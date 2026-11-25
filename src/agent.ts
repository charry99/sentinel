/**
 * Sentinel agent loop — M2.
 *
 * One tick: poll adapters (CoinGecko prices + news RSS context) →
 * rank signals by |24h move| → run the market-worthiness filter →
 * validate criteria → create markets via pm-AMM with no human in the
 * loop → log every decision (created / skipped + reason) → snapshot
 * prices of live markets.
 *
 * Guards (all logged, never silent):
 * - At most MAX_MARKETS_PER_TICK new markets per tick (devnet budget).
 * - No duplicate live market for the same asset + resolution window.
 * - The agent does NOT trade its own markets (PLAN decision: v1
 *   creates + resolves only; no self-trade, no conflict of interest).
 * - One failing adapter never kills the tick.
 * - `--dry-run` logs what WOULD happen and touches nothing on-chain.
 *
 * Run: `npm run agent` (loop, 15 min ticks) or
 *      `npm run agent:once` (one tick, then exit) or
 *      `node dist/src/agent.js --once --dry-run` (no chain writes).
 */
import * as path from "path";
import type { PmAmmClient } from "@pm-amm/sdk";
import type { Connection, Keypair } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import {
  marketAppUrl,
  solscanAccountUrl,
  solscanTxUrl,
} from "./constants";
import {
  checkWorthy,
  durationSecsFor,
  isDuplicate,
  MAX_MARKETS_PER_TICK,
  proposeCriteria,
  type Worthiness,
} from "./filter";
import {
  buildMarketDescription,
  type MarketCriteria,
} from "./marketCriteria";
import {
  createClient,
  createConnection,
  ensureFunded,
  loadOrCreateKeypair,
  solBalance,
  usdcBalance,
} from "./pmAmm";
import { fetchMarkets, marketState } from "./pmAmmHelpers";
import { CoinGeckoAdapter, NewsRssAdapter, type Signal, type SignalAdapter } from "./signals";
import {
  appendDecision,
  appendMarketRecord,
  appendSnapshot,
  liveMarkets,
  readTrackRecord,
  type DecisionEntry,
  type MarketRecord,
} from "./trackRecord";

export interface AgentConfig {
  pollIntervalMs: number;
  adapters: SignalAdapter[];
  dataDir: string;
  /** mUSDC deposited per new market (human units). Default 50. */
  depositUsdc: number;
  /** Max new markets per tick. Default MAX_MARKETS_PER_TICK (1). */
  maxMarketsPerTick: number;
  /** Log decisions without touching the chain. */
  dryRun: boolean;
}

export interface AgentContext {
  conn: Connection;
  client: PmAmmClient;
  keypair: Keypair;
}

export interface CreatedMarket {
  question: string;
  marketPda: string;
  marketId: number;
  createTx: string;
  criteria: MarketCriteria;
}

export interface TickResult {
  at: string;
  signalsSeen: number;
  created: CreatedMarket[];
  skipped: { summary: string; reason: string }[];
  errors: string[];
  snapshots: number;
}

const DEFAULT_POLL_MS = 15 * 60 * 1000;

export function defaultConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    pollIntervalMs: Number(process.env.SENTINEL_POLL_MINUTES ?? 15) * 60 * 1000 || DEFAULT_POLL_MS,
    adapters: [new CoinGeckoAdapter(), new NewsRssAdapter()],
    dataDir: path.join(process.cwd(), "data"),
    depositUsdc: Number(process.env.SENTINEL_DEPOSIT_USDC ?? 50),
    maxMarketsPerTick: MAX_MARKETS_PER_TICK,
    dryRun: false,
    ...overrides,
  };
}

/** Numeric (price) signals first, biggest |24h move| first; context last. */
function rankSignals(signals: Signal[]): Signal[] {
  return [...signals].sort((a, b) => {
    const ma = Math.abs(a.change24hPct ?? 0);
    const mb = Math.abs(b.change24hPct ?? 0);
    return mb - ma;
  });
}

async function snapshotLiveMarkets(
  config: AgentConfig,
  ctx: AgentContext,
  now: Date,
): Promise<number> {
  const records = readTrackRecord(config.dataDir);
  const live = liveMarkets(records, now);
  if (live.length === 0) return 0;
  const pdas = live.map((r) => new PublicKey(r.marketPda));
  const fetched = await fetchMarkets(ctx.client, pdas);
  let count = 0;
  for (let i = 0; i < live.length; i++) {
    const m = fetched[i];
    if (!m) continue;
    const st = marketState(m);
    appendSnapshot(config.dataDir, {
      at: now.toISOString(),
      marketId: live[i].marketId,
      marketPda: live[i].marketPda,
      yesPricePct: Number((st.price * 100).toFixed(2)),
      reserveYes: st.x,
      reserveNo: st.y,
      secondsLeft: st.secondsLeft,
      resolved: st.resolved,
    });
    count++;
  }
  return count;
}

export async function agentTick(
  config: AgentConfig,
  ctx: AgentContext | null,
  now: Date = new Date(),
): Promise<TickResult> {
  const result: TickResult = {
    at: now.toISOString(),
    signalsSeen: 0,
    created: [],
    skipped: [],
    errors: [],
    snapshots: 0,
  };
  const decision = (entry: DecisionEntry): void => {
    appendDecision(config.dataDir, entry);
    console.log(
      `  [decision] ${entry.outcome.toUpperCase()} ${entry.asset} — ${entry.reason}`,
    );
  };

  // 1. Poll adapters — one failing adapter must not kill the tick.
  const signals: Signal[] = [];
  for (const adapter of config.adapters) {
    try {
      const polled = await adapter.poll();
      console.log(`[agent] ${adapter.name}: ${polled.length} signal(s)`);
      signals.push(...polled);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`${adapter.name} poll failed: ${msg}`);
      console.error(`[agent] ${adapter.name} poll failed: ${msg.split("\n")[0]}`);
    }
  }
  result.signalsSeen = signals.length;

  // 2. Rank + filter. Live markets from the track record (source of truth
  //    for what the agent already created).
  const records = readTrackRecord(config.dataDir);
  const live = liveMarkets(records, now);
  let createdThisTick = 0;

  for (const signal of rankSignals(signals)) {
    const base: Omit<DecisionEntry, "outcome" | "reason"> = {
      at: now.toISOString(),
      signalId: signal.id,
      source: signal.source,
      asset: signal.asset,
      summary: signal.summary,
    };
    const worthy: Worthiness = checkWorthy(signal);
    if (!worthy.worthy) {
      result.skipped.push({ summary: signal.summary, reason: worthy.reason });
      decision({ ...base, outcome: "skipped", reason: worthy.reason });
      continue;
    }
    if (createdThisTick >= config.maxMarketsPerTick) {
      const reason =
        `worthy (${worthy.reason}) but per-tick cap of ${config.maxMarketsPerTick} ` +
        `new market(s) reached — deferred to a later tick`;
      result.skipped.push({ summary: signal.summary, reason });
      decision({ ...base, outcome: "skipped", reason });
      continue;
    }
    const proposed = proposeCriteria(signal, worthy, now);
    if ("error" in proposed) {
      result.skipped.push({ summary: signal.summary, reason: proposed.error });
      decision({ ...base, outcome: "skipped", reason: proposed.error });
      continue;
    }
    const { criteria, question } = proposed;
    const dup = isDuplicate(criteria, live);
    if (dup) {
      const reason =
        `duplicate: live market "${dup.name}" (${dup.marketPda}) already covers ` +
        `${criteria.asset} for a window within 24h of ${criteria.resolveAt.toISOString()}`;
      result.skipped.push({ summary: signal.summary, reason });
      decision({ ...base, outcome: "skipped", reason });
      continue;
    }

    // 3. Create the market — autonomously, no human in the loop.
    if (config.dryRun || !ctx) {
      const reason = `DRY RUN — would create: "${question}" (threshold $${criteria.thresholdUsd.toLocaleString("en-US")}, resolves ${criteria.resolveAt.toISOString()})`;
      result.skipped.push({ summary: signal.summary, reason });
      decision({ ...base, outcome: "skipped", reason, question });
      // Count it against the per-tick cap so a dry run mirrors a live run
      // (otherwise every worthy signal would show "would create").
      createdThisTick++;
      continue;
    }
    try {
      console.log(`[agent] creating market "${question}"…`);
      const createdMarket = await ctx.client.send.createMarket({
        name: question,
        durationSecs: durationSecsFor(criteria, now),
        initialPriceBps: 5000, // 50% YES
        depositUsdc: config.depositUsdc, // human units
      });
      const market = new PublicKey(createdMarket.marketPda);
      const m = await ctx.client.fetchMarket(market);
      if (!m) throw new Error("market account not found after creation");
      const st = marketState(m);
      const record: MarketRecord = {
        name: question,
        criteria: {
          asset: criteria.asset,
          direction: criteria.direction,
          thresholdUsd: criteria.thresholdUsd,
          resolveAt: criteria.resolveAt.toISOString(),
          source: criteria.source,
          sourceUrl: criteria.sourceUrl,
          tieRule: "Exactly equal to the threshold resolves NO.",
        },
        marketId: createdMarket.marketId,
        marketPda: createdMarket.marketPda,
        marketAppUrl: marketAppUrl(createdMarket.marketId),
        explorerAccount: solscanAccountUrl(createdMarket.marketPda),
        createTx: createdMarket.signature,
        createTxUrl: solscanTxUrl(createdMarket.signature),
        swapTx: null,
        swapTxUrl: null,
        yesBought: null,
        yesPricePctAfterBuy: Number((st.price * 100).toFixed(2)),
        creator: ctx.keypair.publicKey.toBase58(),
        createdAt: now.toISOString(),
        status: "LIVE",
        resolution: `Pending — resolves after ${criteria.resolveAt.toISOString()} via send.resolveMarket (creator authority, M3).`,
      };
      appendMarketRecord(config.dataDir, record);
      live.push(record);
      createdThisTick++;
      result.created.push({
        question,
        marketPda: createdMarket.marketPda,
        marketId: createdMarket.marketId,
        createTx: createdMarket.signature,
        criteria,
      });
      console.log(`[agent] market live: ${createdMarket.marketPda} (id ${createdMarket.marketId})`);
      console.log(`  create tx ${createdMarket.signature}`);
      console.log(`  ${marketAppUrl(createdMarket.marketId)}`);
      decision({
        ...base,
        outcome: "created",
        reason: `${worthy.reason} → ${buildMarketDescription(criteria)}`,
        marketPda: createdMarket.marketPda,
        marketId: createdMarket.marketId,
        createTx: createdMarket.signature,
        question,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`createMarket failed for "${question}": ${msg}`);
      decision({
        ...base,
        outcome: "error",
        reason: `createMarket failed: ${msg.split("\n")[0]}`,
        question,
      });
    }
  }

  // 4. Price snapshots of live markets (read-only; never fails the tick).
  if (!config.dryRun && ctx) {
    try {
      result.snapshots = await snapshotLiveMarkets(config, ctx, now);
      if (result.snapshots > 0) {
        console.log(`[agent] ${result.snapshots} price snapshot(s) logged`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`snapshots failed: ${msg}`);
      console.error(`[agent] snapshots failed: ${msg.split("\n")[0]}`);
    }
  }

  console.log(
    `[agent] tick done — ${result.signalsSeen} signal(s), ` +
      `${result.created.length} market(s) created, ` +
      `${result.skipped.length} skipped, ${result.snapshots} snapshot(s)`,
  );
  return result;
}

export async function runAgent(config: AgentConfig, ctx: AgentContext): Promise<never> {
  console.log("[agent] Sentinel agent loop starting");
  console.log(`[agent] poll every ${config.pollIntervalMs / 60000} min · deposit ${config.depositUsdc} mUSDC/market · max ${config.maxMarketsPerTick} new market(s)/tick`);
  for (;;) {
    await agentTick(config, ctx);
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const once = args.has("--once");
  const dryRun = args.has("--dry-run");
  const config = defaultConfig({ dryRun });
  console.log("Sentinel — autonomous prediction-market agent (devnet only)");
  console.log(`mode: ${once ? "single tick" : "loop"}${dryRun ? " · DRY RUN (no chain writes)" : ""}`);

  let ctx: AgentContext | null = null;
  if (!dryRun) {
    const { keypair: kp, path: kpPath, created } = loadOrCreateKeypair();
    console.log(`wallet  ${kp.publicKey.toBase58()} (keypair: ${kpPath}${created ? ", freshly generated" : ""})`);
    const conn = createConnection();
    const funded = await ensureFunded(conn, kp);
    console.log(`balance ${funded.sol.toFixed(3)} SOL · ${funded.usdc} mUSDC`);
    const client = createClient(conn, kp);
    ctx = { conn, client, keypair: kp };
    // Re-read balances post-funding for the log (ensureFunded returns pre-poll values).
    const sol = await solBalance(conn, kp.publicKey);
    const usdc = await usdcBalance(conn, kp.publicKey);
    console.log(`balance now ${sol.toFixed(4)} SOL · ${usdc} mUSDC`);
  } else {
    console.log("dry run — wallet/funding skipped, no market will be created");
  }

  if (once) {
    await agentTick(config, ctx);
    return;
  }
  if (!ctx) throw new Error("loop mode requires a funded wallet (no --dry-run)");
  await runAgent(config, ctx);
}

// CLI entry point (compiled CommonJS).
if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
