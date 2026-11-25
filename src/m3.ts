/**
 * Sentinel M3 — short-duration full-cycle proof:
 *   create → trade → wait for expiry → proof bundle → resolve → claim
 *
 *   npm run build && node dist/src/m3.js
 *
 * Creates ONE short-duration binary market on Solana devnet via pm-AMM,
 * buys YES with a small test amount, waits for expiry, fetches the named
 * source (CoinGecko) at resolution time, publishes the resolution proof
 * bundle BEFORE the on-chain resolve call, resolves, then settles
 * (accrue → LP residuals → winnings if held) and records the full cycle
 * with every tx hash in the public track record.
 *
 * Devnet only, mock USDC only, $0. Default: BTC above $68,000, ~15 min
 * out. Env overrides: SENTINEL_M3_THRESHOLD, SENTINEL_M3_WAIT_MINUTES,
 * SENTINEL_DEPOSIT_USDC, SENTINEL_BUY_USDC.
 */
import * as fs from "fs";
import * as path from "path";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { marketAppUrl, solscanAccountUrl, solscanTxUrl } from "./constants";
import {
  buildMarketQuestion,
  durationSecsUntil,
  validateCriteria,
  type MarketCriteria,
} from "./marketCriteria";
import {
  createClient,
  createConnection,
  ensureFunded,
  loadOrCreateKeypair,
  sleep,
  solBalance,
  usdcBalance,
  withRetry,
} from "./pmAmm";
import { marketState, minOutput, quoteSwap } from "./pmAmmHelpers";
import {
  buildResolutionProof,
  buildSettlementSummary,
  type Outcome,
} from "./resolution";
import { CoinGeckoAdapter } from "./signals";
import {
  appendMarketRecord,
  readTrackRecord,
  trackRecordPath,
  type MarketRecord,
} from "./trackRecord";

const THRESHOLD_USD = Number(process.env.SENTINEL_M3_THRESHOLD ?? 68000);
const WAIT_MINUTES = Number(process.env.SENTINEL_M3_WAIT_MINUTES ?? 15);
const DEPOSIT_USDC = Number(process.env.SENTINEL_DEPOSIT_USDC ?? 50);
const BUY_USDC = Number(process.env.SENTINEL_BUY_USDC ?? 5);

/** Resolution time: now + WAIT_MINUTES, truncated to a whole minute. */
function pickResolveAt(now: Date): Date {
  const t = now.getTime() + WAIT_MINUTES * 60_000;
  return new Date(Math.floor(t / 60_000) * 60_000);
}

async function tokenBalance(
  conn: ReturnType<typeof createConnection>,
  mint: PublicKey,
  owner: PublicKey,
): Promise<number> {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  try {
    const bal = await conn.getTokenAccountBalance(ata);
    return Number(bal.value.uiAmount ?? 0);
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  const now = new Date();
  const resolveAt = pickResolveAt(now);
  const criteria: MarketCriteria = {
    asset: "BTC",
    direction: "above",
    thresholdUsd: THRESHOLD_USD,
    resolveAt,
    source: "CoinGecko BTC/USD",
    sourceUrl:
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
  };
  const question = buildMarketQuestion(criteria);
  const check = validateCriteria(criteria, now);
  if (!check.ok) {
    throw new Error(`market criteria failed validation: ${check.errors.join("; ")}`);
  }

  const { keypair: kp, path: kpPath } = loadOrCreateKeypair();
  console.log(`wallet  ${kp.publicKey.toBase58()} (keypair: ${kpPath})`);
  console.log("network devnet only — mock USDC, no real funds");
  console.log(`market  "${question}" (threshold $${THRESHOLD_USD}, resolves ${resolveAt.toISOString()})`);

  const conn = createConnection();
  const solBefore = await solBalance(conn, kp.publicKey);
  const usdcBefore = await usdcBalance(conn, kp.publicKey);
  console.log(`balance before: ${solBefore.toFixed(4)} SOL · ${usdcBefore} mUSDC`);
  const funded = await ensureFunded(conn, kp);
  console.log(`balance funded: ${funded.sol.toFixed(3)} SOL · ${funded.usdc} mUSDC`);

  const client = createClient(conn, kp);
  const dataDir = path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });

  // 1. Create the market.
  const durationSecs = durationSecsUntil(criteria.resolveAt);
  console.log(`creating market (duration ${durationSecs}s, deposit ${DEPOSIT_USDC} mUSDC)…`);
  const created = await client.send.createMarket({
    name: question,
    durationSecs,
    initialPriceBps: 5000,
    depositUsdc: DEPOSIT_USDC,
  });
  const market = new PublicKey(created.marketPda);
  console.log(`market  ${created.marketPda} (id ${created.marketId})`);
  console.log(`create tx ${created.signature}`);
  console.log(`  ${solscanTxUrl(created.signature)}`);
  console.log(`open it: ${marketAppUrl(created.marketId)}`);

  // 2. Buy YES with BUY_USDC mUSDC (same flow as demo.ts).
  let m = await withRetry("fetchMarket", async () => {
    const fetched = await client.fetchMarket(market);
    if (!fetched) throw new Error("market account not found after creation");
    return fetched;
  });
  const onChainEndTs = m.endTs.toNumber();
  console.log(`on-chain endTs: ${new Date(onChainEndTs * 1000).toISOString()} (nominal ${resolveAt.toISOString()})`);
  const before = marketState(m);
  console.log(`YES price before buy: ${(before.price * 100).toFixed(2)}%`);
  const amountInMicro = Math.round(BUY_USDC * 1_000_000);
  const quote = quoteSwap(m, "usdcToYes", amountInMicro);
  const swapSig = await client.send.swap(market, "usdcToYes", amountInMicro, minOutput(quote));
  console.log(`swap tx ${swapSig} (bought ~${(quote.out / 1e6).toFixed(6)} YES for ${BUY_USDC} mUSDC)`);
  console.log(`  ${solscanTxUrl(swapSig)}`);

  await sleep(2000);
  m = await withRetry("fetchMarket after swap", async () => {
    const fetched = await client.fetchMarket(market);
    if (!fetched) throw new Error("market account not found after swap");
    return fetched;
  });
  const after = marketState(m);
  const yesBal = await tokenBalance(conn, client.yesMint(market), kp.publicKey);
  console.log(`YES held: ${yesBal} · YES price now: ${(after.price * 100).toFixed(2)}%`);

  // Record the LIVE market in the track record now (M4 dashboard reads it).
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
    marketId: created.marketId,
    marketPda: created.marketPda,
    marketAppUrl: marketAppUrl(created.marketId),
    explorerAccount: solscanAccountUrl(created.marketPda),
    createTx: created.signature,
    createTxUrl: solscanTxUrl(created.signature),
    swapTx: swapSig,
    swapTxUrl: solscanTxUrl(swapSig),
    yesBought: String(yesBal),
    yesPricePctAfterBuy: Number((after.price * 100).toFixed(2)),
    creator: kp.publicKey.toBase58(),
    createdAt: new Date().toISOString(),
    status: "LIVE",
    resolution: `Pending — resolves after ${resolveAt.toISOString()} via send.resolveMarket (creator authority, M3 proof).`,
  };
  appendMarketRecord(dataDir, record);
  fs.writeFileSync(
    path.join(dataDir, "m3-market.json"),
    JSON.stringify(record, null, 2),
  );
  console.log(`record saved to data/m3-market.json + data/track-record.json`);

  // 3. Wait for expiry (on-chain endTs, ±1s tolerance — never assume the
  //    nominal time equals the on-chain time). Poll every 15s (RPC etiquette).
  console.log(`waiting for expiry (on-chain endTs ${new Date(onChainEndTs * 1000).toISOString()})…`);
  const waitDeadline = Date.now() + 25 * 60_000;
  for (;;) {
    const st = marketState(
      await withRetry("fetchMarket (wait)", async () => {
        const fetched = await client.fetchMarket(market);
        if (!fetched) throw new Error("market account not found while waiting");
        return fetched;
      }),
    );
    if (st.expired) {
      console.log(`expired at ${new Date().toISOString()} (secondsLeft ${st.secondsLeft})`);
      break;
    }
    if (Date.now() > waitDeadline) {
      throw new Error("market did not expire within 25 minutes of the wait loop — aborting before resolution");
    }
    await sleep(15000);
  }
  // Small buffer so the fetch is unambiguously after endTs.
  await sleep(10000);

  // 4. Fetch the outcome source and publish the proof bundle BEFORE the
  //    on-chain resolve call. Retry up to 2h per PLAN.md — in practice
  //    one retry loop with 60s gaps, then fail loudly (never guess).
  console.log(`fetching resolution source: ${criteria.sourceUrl}`);
  const adapter = new CoinGeckoAdapter(["BTC"]);
  let fetchedValue: number | null = null;
  let rawResponse: unknown = null;
  let fetchedAt = "";
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const signals = await adapter.poll();
      const sig = signals.find((s) => s.asset === "BTC");
      if (!sig || !Number.isFinite(sig.metric)) {
        throw new Error("CoinGecko returned no finite BTC price");
      }
      fetchedValue = sig.metric;
      fetchedAt = sig.fetchedAt;
      rawResponse = { bitcoin: { usd: sig.metric, usd_24h_change: sig.change24hPct } };
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  [resolution fetch] attempt ${attempt} failed: ${msg.split("\n")[0]}`);
      if (attempt === 5) throw new Error(`resolution source down after 5 attempts — refusing to resolve from a guess: ${msg}`);
      await sleep(60000);
    }
  }
  const proof = buildResolutionProof(criteria, fetchedValue!, rawResponse, new Date(fetchedAt));
  const proofPath = path.join(dataDir, `resolution-proof-${created.marketId}.json`);
  fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2));
  console.log(`proof bundle published to ${proofPath} BEFORE the on-chain call:`);
  console.log(`  fetched BTC $${fetchedValue} at ${fetchedAt} (threshold $${THRESHOLD_USD}) => outcome ${proof.outcome.toUpperCase()}`);

  // 5. Resolve on-chain.
  const outcome: Outcome = proof.outcome;
  console.log(`resolving market ${outcome.toUpperCase()}…`);
  const resolveSig = await client.send.resolveMarket(market, outcome);
  console.log(`resolve tx ${resolveSig}`);
  console.log(`  ${solscanTxUrl(resolveSig)}`);

  // 6. Verify the on-chain state matches the proof.
  await sleep(5000);
  m = await withRetry("fetchMarket after resolve", async () => {
    const fetched = await client.fetchMarket(market);
    if (!fetched) throw new Error("market account not found after resolve");
    return fetched;
  });
  const resolvedState = marketState(m);
  if (!resolvedState.resolved || resolvedState.winner !== outcome) {
    throw new Error(
      `on-chain state mismatch after resolve: resolved=${resolvedState.resolved} winner=${resolvedState.winner} expected ${outcome}`,
    );
  }
  console.log(`verified on-chain: resolved=true, winningSide=${outcome.toUpperCase()}`);

  // 7. Settle: accrue → LP residuals → winnings (only if winning tokens held).
  //    Each step is independent and logged; a settle-step failure is recorded
  //    but does not erase the resolution proof above.
  const settle: Record<string, string | null> = {
    accrueTx: null,
    claimLpResidualsTx: null,
    claimWinningsTx: null,
    claimWinningsNote: null,
  };
  try {
    settle.accrueTx = await client.send.accrue(market);
    console.log(`accrue tx ${settle.accrueTx}`);
  } catch (e) {
    console.error(`  [settle] accrue failed (non-fatal): ${(e as Error).message.split("\n")[0]}`);
  }
  try {
    settle.claimLpResidualsTx = await client.send.claimLpResiduals(market);
    console.log(`claim LP residuals tx ${settle.claimLpResidualsTx}`);
  } catch (e) {
    console.error(`  [settle] claimLpResiduals failed (non-fatal): ${(e as Error).message.split("\n")[0]}`);
  }
  const yesHeld = await tokenBalance(conn, client.yesMint(market), kp.publicKey);
  const noHeld = await tokenBalance(conn, client.noMint(market), kp.publicKey);
  console.log(`tokens held after resolve: YES ${yesHeld} · NO ${noHeld}`);
  const winningHeld = outcome === "yes" ? yesHeld : noHeld;
  if (winningHeld > 0) {
    try {
      settle.claimWinningsTx = await client.send.claimWinnings(market);
      console.log(`claim winnings tx ${settle.claimWinningsTx} (${winningHeld} winning tokens)`);
    } catch (e) {
      console.error(`  [settle] claimWinnings failed: ${(e as Error).message.split("\n")[0]}`);
    }
  } else {
    settle.claimWinningsNote = `no winning tokens held (outcome ${outcome.toUpperCase()}, held YES ${yesHeld} / NO ${noHeld}) — nothing to claim`;
    console.log(`  [settle] ${settle.claimWinningsNote}`);
  }

  // 8. Final balances + P/L + track-record update.
  await sleep(5000);
  const solAfter = await solBalance(conn, kp.publicKey);
  const usdcAfter = await usdcBalance(conn, kp.publicKey);
  const spentUsdc = DEPOSIT_USDC + BUY_USDC;
  const summary = buildSettlementSummary({
    spentUsdc,
    usdcBefore,
    usdcAfter,
    outcome,
    yesBought: yesBal,
    winningTokensClaimed: winningHeld > 0 && settle.claimWinningsTx ? winningHeld : 0,
  });
  console.log(`balance after: ${solAfter.toFixed(4)} SOL · ${usdcAfter} mUSDC`);
  console.log(`P/L: spent ${spentUsdc} mUSDC (deposit ${DEPOSIT_USDC} + buy ${BUY_USDC}), recovered ${summary.recoveredUsdc} mUSDC, net ${summary.netUsdc >= 0 ? "+" : ""}${summary.netUsdc} mUSDC`);

  const records = readTrackRecord(dataDir);
  const entry = records.find((r) => r.marketPda === created.marketPda);
  if (entry) {
    entry.status = "RESOLVED";
    entry.resolution = JSON.stringify({
      outcome,
      fetchedValue,
      fetchedAt,
      source: criteria.source,
      sourceUrl: criteria.sourceUrl,
      tieRule: "Exactly equal to the threshold resolves NO.",
      proofPath: `data/resolution-proof-${created.marketId}.json`,
      resolveTx: resolveSig,
      resolveTxUrl: solscanTxUrl(resolveSig),
      ...settle,
      solBefore,
      usdcBefore,
      solAfter,
      usdcAfter,
      spentUsdc,
      recoveredUsdc: summary.recoveredUsdc,
      netUsdc: summary.netUsdc,
      resolvedAt: new Date().toISOString(),
    });
    fs.writeFileSync(trackRecordPath(dataDir), JSON.stringify(records, null, 2));
  }
  const proofSummary = {
    market: question,
    marketId: created.marketId,
    marketPda: created.marketPda,
    marketAppUrl: marketAppUrl(created.marketId),
    createTx: created.signature,
    swapTx: swapSig,
    resolveTx: resolveSig,
    settle,
    outcome,
    fetchedValue,
    fetchedAt,
    proofPath: `data/resolution-proof-${created.marketId}.json`,
    solBefore,
    usdcBefore,
    solAfter,
    usdcAfter,
    spentUsdc,
    recoveredUsdc: summary.recoveredUsdc,
    netUsdc: summary.netUsdc,
    completedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(dataDir, "m3-proof.json"),
    JSON.stringify(proofSummary, null, 2),
  );

  console.log(`\nM3 full cycle complete — see data/m3-proof.json`);
  console.log(`market:  ${solscanAccountUrl(created.marketPda)}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
