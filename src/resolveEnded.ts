/**
 * Sentinel — resolve the 3 ended markets from Nov 15 + Nov 20 (late resolution).
 *
 *   DRY RUN (preview only, sends nothing):
 *     DRY_RUN=1 npm run build && node dist/src/resolveEnded.js
 *   LIVE (sends resolveMarket + settle txs on devnet):
 *     npm run build && node dist/src/resolveEnded.js
 *
 * Authority: user picked option 1 in Main chat 2026-11-25 — resolve all three
 * NO on-chain, citing CoinGecko + Kraken. Verdict file:
 *   ~/workspace/goals/solana-perps-hackathon/sentinel-resolution-verdict-2026-11-25.md
 *
 * Proof-first, exactly like M3, with one honest difference: the resolution
 * window has passed, so the "named source at resolution time" is a
 * HISTORICAL reconstruction, not a live fetch. The proof bundle therefore
 * cites BOTH CoinGecko range (hourly, the named source) and Kraken OHLC
 * (independent cross-check) with their exact URLs and timestamps, and the
 * Yahoo $95,720 figure is explicitly NOT used (rejected in the verdict:
 * contradicts both CoinGecko and Kraken; no hour of Nov 15 on Kraken came
 * within $30k of it). A market is resolved only if BOTH sources agree on
 * the outcome; any disagreement aborts that market.
 *
 * Devnet only, mock USDC only, $0. Gas is devnet SOL from the agent wallet.
 */
import * as fs from "fs";
import * as path from "path";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { solscanAccountUrl, solscanTxUrl } from "./constants";
import type { MarketCriteria } from "./marketCriteria";
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
import { marketState } from "./pmAmmHelpers";
import { buildResolutionProof, type Outcome } from "./resolution";
import {
  appendMarketRecord,
  readTrackRecord,
  trackRecordPath,
} from "./trackRecord";

const DRY_RUN = process.env.DRY_RUN === "1";
const CREATOR = "B6mbz82NKSk6NEr1AFmjrGs46pS1SeTCx3JNDHxQb7b5";

interface EndedMarket {
  marketId: number;
  marketPda: string;
  thresholdUsd: number;
  resolveAt: string; // ISO, 12:00 UTC
}

const MARKETS: EndedMarket[] = [
  {
    marketId: 102498313784629,
    marketPda: "8hxkCjUgumeZr9dvmeL2xR2x8gzRtMqVDLFf6QBie2m5",
    thresholdUsd: 100000,
    resolveAt: "2026-11-20T12:00:00.000Z",
  },
  {
    marketId: 4556349035492,
    marketPda: "4i36zWqRgjCt7mfT3vRinKAYbAtgopmePoE6MwjseCBy",
    thresholdUsd: 100000,
    resolveAt: "2026-11-20T12:00:00.000Z",
  },
  {
    marketId: 154474886100287,
    marketPda: "4QW2qaFBfGpH345gjeQTzmRzojgCXTr4MagjV8ScShLW",
    thresholdUsd: 70000,
    resolveAt: "2026-11-15T12:00:00.000Z",
  },
];

async function fetchJson(url: string): Promise<unknown> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(5000);
    }
  }
  throw new Error("unreachable");
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
  const { keypair: kp, path: kpPath } = loadOrCreateKeypair();
  console.log(`wallet  ${kp.publicKey.toBase58()} (keypair: ${kpPath})`);
  if (kp.publicKey.toBase58() !== CREATOR) {
    throw new Error(
      `keypair is NOT the market creator (${CREATOR}) — refusing to resolve from another wallet`,
    );
  }
  console.log(`creator check OK — this wallet created all three markets`);
  console.log(`mode    ${DRY_RUN ? "DRY RUN — preview only, nothing will be sent" : "LIVE — resolveMarket + settle txs will be sent on devnet"}`);

  const conn = createConnection();
  const solBefore = await solBalance(conn, kp.publicKey);
  const usdcBefore = await usdcBalance(conn, kp.publicKey);
  console.log(`balance before: ${solBefore.toFixed(4)} SOL · ${usdcBefore} mUSDC`);
  if (!DRY_RUN && solBefore < 0.05) {
    const funded = await ensureFunded(conn, kp);
    console.log(`balance funded: ${funded.sol.toFixed(3)} SOL · ${funded.usdc} mUSDC`);
  }

  const client = createClient(conn, kp);
  const dataDir = path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });

  for (const em of MARKETS) {
    const market = new PublicKey(em.marketPda);
    const resolveAt = new Date(em.resolveAt);
    const resolveEpoch = Math.floor(resolveAt.getTime() / 1000);
    console.log(`\n=== market ${em.marketId} "${"BTC"} above $${em.thresholdUsd} at ${em.resolveAt}" ===`);
    console.log(`  pda ${em.marketPda} — ${solscanAccountUrl(em.marketPda)}`);

    const m = await withRetry("fetchMarket", async () => {
      const fetched = await client.fetchMarket(market);
      if (!fetched) throw new Error("market account not found");
      return fetched;
    });
    const st = marketState(m);
    console.log(`  on-chain: expired=${st.expired} resolved=${st.resolved} winner=${st.winner} secondsLeft=${st.secondsLeft}`);
    if (st.resolved) {
      console.log(`  SKIP — already resolved on-chain (winner ${st.winner})`);
      continue;
    }
    if (!st.expired) throw new Error(`market ${em.marketId} has not expired yet — refusing to resolve early`);

    // ---- Evidence (fresh fetch, both sources, before any on-chain call) ----
    const cgUrl = `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range?vs_currency=usd&from=${resolveEpoch - 3600}&to=${resolveEpoch + 3600}`;
    const krUrl = `https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=60&since=${resolveEpoch - 3600}`;
    const cg = (await fetchJson(cgUrl)) as { prices?: [number, number][] };
    const kr = (await fetchJson(krUrl)) as { result?: { XXBTZUSD?: [number, string, string, string, string][] } };
    const cgPoint = (cg.prices ?? []).find(([ms]) => ms === resolveEpoch * 1000)
      ?? (cg.prices ?? []).reduce<[number, number] | undefined>(
        (best, p) => (!best || Math.abs(p[0] - resolveEpoch * 1000) < Math.abs(best[0] - resolveEpoch * 1000) ? p : best),
        undefined,
      );
    if (!cgPoint) throw new Error(`CoinGecko range returned no price near ${em.resolveAt}`);
    const cgValue = cgPoint[1];
    const krRow = (kr.result?.XXBTZUSD ?? []).find(([t]) => t === resolveEpoch);
    if (!krRow) throw new Error(`Kraken OHLC returned no 12:00 candle for ${em.resolveAt}`);
    const krClose = Number(krRow[4]);
    const krOpen = Number(krRow[1]);
    const cgOutcome: Outcome = cgValue > em.thresholdUsd ? "yes" : "no";
    const krOutcome: Outcome = krClose > em.thresholdUsd ? "yes" : "no";
    console.log(`  evidence: CoinGecko 12:00 UTC $${cgValue.toFixed(2)} (point ${new Date(cgPoint[0]).toISOString()}) => ${cgOutcome.toUpperCase()}`);
    console.log(`  evidence: Kraken 12:00 candle open $${krOpen.toFixed(2)} / close $${krClose.toFixed(2)} => ${krOutcome.toUpperCase()}`);
    if (cgOutcome !== krOutcome) {
      throw new Error(`SOURCES DISAGREE on market ${em.marketId} (CoinGecko ${cgOutcome} vs Kraken ${krOutcome}) — aborting this market, nothing sent for it`);
    }
    if (cgOutcome !== "no") {
      throw new Error(`expected NO for market ${em.marketId} per the user verdict, got ${cgOutcome} — aborting`);
    }
    const outcome: Outcome = "no";

    // ---- Proof bundle FIRST, before the on-chain call (M3 rule) ----
    const criteria: MarketCriteria = {
      asset: "BTC",
      direction: "above",
      thresholdUsd: em.thresholdUsd,
      resolveAt,
      source: "CoinGecko BTC/USD (range endpoint, historical reconstruction)",
      sourceUrl: cgUrl,
    };
    const rawResponse = {
      note: "Historical reconstruction (resolution window passed Nov 15/20; live fetch at resolution time was not possible). CoinGecko range is the named source; Kraken OHLC is an independent cross-check. Yahoo Finance hourly figure ($95,720 for Nov 15 12:00) explicitly NOT used — rejected in the verdict file: it contradicts both CoinGecko and Kraken.",
      coingecko_range_url: cgUrl,
      coingecko_prices_window: cg.prices,
      kraken_ohlc_url: krUrl,
      kraken_12h00_candle: { time: krRow[0], open: krRow[1], high: krRow[2], low: krRow[3], close: krRow[4] },
      reconstructedAt: new Date().toISOString(),
      verdictFile: "sentinel-resolution-verdict-2026-11-25.md",
    };
    const proof = buildResolutionProof(criteria, cgValue, rawResponse, resolveAt);
    const proofPath = path.join(dataDir, `resolution-proof-${em.marketId}.json`);
    fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2));
    console.log(`  proof bundle published to ${proofPath} BEFORE the on-chain call: BTC $${cgValue.toFixed(2)} at ${em.resolveAt} (threshold $${em.thresholdUsd}) => NO`);

    // ---- Transaction preview (printed before any send) ----
    console.log(`  PREVIEW: send.resolveMarket(${em.marketPda}, "no")`);
    console.log(`    signer (creator): ${kp.publicKey.toBase58()}`);
    console.log(`    program: pm-AMM (devnet) · expected cost: ~0.000005 SOL devnet (faucet SOL, $0)`);
    console.log(`    settle after resolve: accrue + claimLpResiduals (+ claimWinnings only if NO tokens held)`);
    if (DRY_RUN) {
      console.log(`  DRY RUN — stopping here, no tx sent for market ${em.marketId}`);
      continue;
    }

    // ---- Resolve on-chain ----
    const resolveSig = await client.send.resolveMarket(market, outcome);
    console.log(`  resolve tx ${resolveSig}`);
    console.log(`    ${solscanTxUrl(resolveSig)}`);

    // ---- Verify on-chain state matches the proof ----
    await sleep(5000);
    const m2 = await withRetry("fetchMarket after resolve", async () => {
      const fetched = await client.fetchMarket(market);
      if (!fetched) throw new Error("market account not found after resolve");
      return fetched;
    });
    const st2 = marketState(m2);
    if (!st2.resolved || st2.winner !== outcome) {
      throw new Error(`on-chain mismatch after resolve: resolved=${st2.resolved} winner=${st2.winner} expected ${outcome}`);
    }
    console.log(`  verified on-chain: resolved=true, winningSide=NO`);

    // ---- Settle ----
    const settle: Record<string, string | null> = {
      accrueTx: null,
      claimLpResidualsTx: null,
      claimWinningsTx: null,
      claimWinningsNote: null,
    };
    try {
      settle.accrueTx = await client.send.accrue(market);
      console.log(`  accrue tx ${settle.accrueTx}`);
    } catch (e) {
      console.error(`  [settle] accrue failed (non-fatal): ${(e as Error).message.split("\n")[0]}`);
    }
    try {
      settle.claimLpResidualsTx = await client.send.claimLpResiduals(market);
      console.log(`  claim LP residuals tx ${settle.claimLpResidualsTx}`);
    } catch (e) {
      console.error(`  [settle] claimLpResiduals failed (non-fatal): ${(e as Error).message.split("\n")[0]}`);
    }
    const yesHeld = await tokenBalance(conn, client.yesMint(market), kp.publicKey);
    const noHeld = await tokenBalance(conn, client.noMint(market), kp.publicKey);
    console.log(`  tokens held after resolve: YES ${yesHeld} · NO ${noHeld}`);
    if (noHeld > 0) {
      try {
        settle.claimWinningsTx = await client.send.claimWinnings(market);
        console.log(`  claim winnings tx ${settle.claimWinningsTx} (${noHeld} NO tokens)`);
      } catch (e) {
        console.error(`  [settle] claimWinnings failed: ${(e as Error).message.split("\n")[0]}`);
      }
    } else {
      settle.claimWinningsNote = `no winning (NO) tokens held (YES ${yesHeld} / NO ${noHeld}) — nothing to claim`;
      console.log(`  [settle] ${settle.claimWinningsNote}`);
    }

    // ---- Track record ----
    const records = readTrackRecord(dataDir);
    const entry = records.find((r) => r.marketPda === em.marketPda);
    if (entry) {
      entry.status = "RESOLVED";
      entry.resolution = JSON.stringify({
        outcome,
        fetchedValue: cgValue,
        krakenClose: krClose,
        fetchedAt: em.resolveAt,
        source: criteria.source,
        sourceUrl: criteria.sourceUrl,
        krakenUrl: krUrl,
        tieRule: "Exactly equal to the threshold resolves NO.",
        proofPath: `data/resolution-proof-${em.marketId}.json`,
        resolveTx: resolveSig,
        resolveTxUrl: solscanTxUrl(resolveSig),
        ...settle,
        resolvedAt: new Date().toISOString(),
      });
      fs.writeFileSync(trackRecordPath(dataDir), JSON.stringify(records, null, 2));
      console.log(`  track record updated: ${em.marketId} RESOLVED`);
    } else {
      console.error(`  WARNING: no track-record entry for ${em.marketPda} — resolve tx still valid, record update skipped`);
    }
  }

  await sleep(2000);
  const solAfter = await solBalance(conn, kp.publicKey);
  const usdcAfter = await usdcBalance(conn, kp.publicKey);
  console.log(`\nbalance after: ${solAfter.toFixed(4)} SOL (was ${solBefore.toFixed(4)}) · ${usdcAfter} mUSDC (was ${usdcBefore})`);
  console.log(DRY_RUN ? "DRY RUN complete — no transactions were sent." : "Resolution run complete.");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
