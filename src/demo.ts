/**
 * Sentinel demo — the judge reproduction path:
 *   npm run demo
 * Creates ONE binary market on Solana devnet via pm-AMM, buys YES with
 * a small amount, and prints the market address + tx signatures +
 * explorer links. Devnet only, mock USDC only, $0.
 *
 * Market (M1): "BTC above $100k at 2026-11-20 12:00 UTC? (CoinGecko)"
 * — the example question from PLAN.md §4, with machine-checkable
 * criteria (asset + threshold + exact UTC time + named source).
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

const DEMO_CRITERIA: MarketCriteria = {
  asset: "BTC",
  direction: "above",
  thresholdUsd: 100000,
  resolveAt: new Date("2026-11-20T12:00:00.000Z"),
  source: "CoinGecko BTC/USD",
  sourceUrl: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
};

const DEPOSIT_USDC = Number(process.env.SENTINEL_DEPOSIT_USDC ?? 50);
const BUY_USDC = Number(process.env.SENTINEL_BUY_USDC ?? 5);

async function main(): Promise<void> {
  const criteriaName =
    process.env.SENTINEL_MARKET_NAME ?? buildMarketQuestion(DEMO_CRITERIA);
  const check = validateCriteria(DEMO_CRITERIA);
  if (!check.ok) {
    throw new Error(`market criteria failed validation: ${check.errors.join("; ")}`);
  }

  const { keypair: kp, path: kpPath, created } = loadOrCreateKeypair();
  console.log(`wallet  ${kp.publicKey.toBase58()} (keypair: ${kpPath}${created ? ", freshly generated" : ""})`);
  console.log("network devnet only — mock USDC, no real funds");

  const conn = createConnection();
  const funded = await ensureFunded(conn, kp);
  console.log(
    `balance ${(funded.sol).toFixed(3)} SOL · ${funded.usdc} mUSDC`,
  );

  const client = createClient(conn, kp);

  // 1. Create the binary market, seeded with DEPOSIT_USDC mUSDC.
  const durationSecs = durationSecsUntil(DEMO_CRITERIA.resolveAt);
  console.log(
    `creating market "${criteriaName}" (duration ${durationSecs}s, deposit ${DEPOSIT_USDC} mUSDC)…`,
  );
  const createdMarket = await client.send.createMarket({
    name: criteriaName,
    durationSecs,
    initialPriceBps: 5000, // 50% YES
    depositUsdc: DEPOSIT_USDC, // human units
  });
  const market = new PublicKey(createdMarket.marketPda);
  console.log(`market  ${createdMarket.marketPda} (id ${createdMarket.marketId})`);
  console.log(`create tx ${createdMarket.signature}`);
  console.log(`  ${solscanTxUrl(createdMarket.signature)}`);

  // 2. Fetch the market and buy YES with BUY_USDC mUSDC.
  //    swap() takes RAW 6-dp units; quote via helpers (fee included).
  let m = await withRetry("fetchMarket", async () => {
    const fetched = await client.fetchMarket(market);
    if (!fetched) throw new Error("market account not found after creation");
    return fetched;
  });
  const before = marketState(m);
  console.log(`YES price before buy: ${(before.price * 100).toFixed(2)}%`);

  const amountInMicro = Math.round(BUY_USDC * 1_000_000);
  const quote = quoteSwap(m, "usdcToYes", amountInMicro);
  const minOut = minOutput(quote); // 1% slippage
  console.log(
    `buying YES with ${BUY_USDC} mUSDC (quote ${quote.out / 1e6} YES, fee ${quote.fee / 1e6} mUSDC, minOut ${minOut / 1e6})…`,
  );
  const swapSig = await client.send.swap(market, "usdcToYes", amountInMicro, minOut);
  console.log(`swap tx ${swapSig}`);
  console.log(`  ${solscanTxUrl(swapSig)}`);

  // 3. Verify on-chain: market exists, YES balance moved, price moved.
  await sleep(2000);
  m = await withRetry("fetchMarket after swap", async () => {
    const fetched = await client.fetchMarket(market);
    if (!fetched) throw new Error("market account not found after swap");
    return fetched;
  });
  const after = marketState(m);
  const yesAta = getAssociatedTokenAddressSync(client.yesMint(market), kp.publicKey);
  const yesBal = await withRetry("YES balance", () =>
    conn.getTokenAccountBalance(yesAta),
  );
  const solAfter = await solBalance(conn, kp.publicKey);
  const usdcAfter = await usdcBalance(conn, kp.publicKey);
  console.log(`bought ${yesBal.value.uiAmountString} YES for ${BUY_USDC} mUSDC`);
  console.log(`YES price now: ${(after.price * 100).toFixed(2)}%`);
  console.log(`balance after: ${solAfter.toFixed(4)} SOL · ${usdcAfter} mUSDC`);

  // 4. Record the market in the public track record (seed for the dashboard).
  const record = {
    name: criteriaName,
    criteria: {
      asset: DEMO_CRITERIA.asset,
      direction: DEMO_CRITERIA.direction,
      thresholdUsd: DEMO_CRITERIA.thresholdUsd,
      resolveAt: DEMO_CRITERIA.resolveAt.toISOString(),
      source: DEMO_CRITERIA.source,
      sourceUrl: DEMO_CRITERIA.sourceUrl,
      tieRule: "Exactly equal to the threshold resolves NO.",
    },
    marketId: createdMarket.marketId,
    marketPda: createdMarket.marketPda,
    marketAppUrl: marketAppUrl(createdMarket.marketId),
    explorerAccount: solscanAccountUrl(createdMarket.marketPda),
    createTx: createdMarket.signature,
    createTxUrl: solscanTxUrl(createdMarket.signature),
    swapTx: swapSig,
    swapTxUrl: solscanTxUrl(swapSig),
    yesBought: yesBal.value.uiAmountString,
    yesPricePctAfterBuy: Number((after.price * 100).toFixed(2)),
    creator: kp.publicKey.toBase58(),
    createdAt: new Date().toISOString(),
    status: "LIVE",
    resolution: "Pending — resolves after 2026-11-20T12:00:00Z via send.resolveMarket (creator authority, M3).",
  };
  const dataDir = path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "demo-market.json"),
    JSON.stringify(record, null, 2),
  );
  const trackPath = path.join(dataDir, "track-record.json");
  const track = fs.existsSync(trackPath)
    ? (JSON.parse(fs.readFileSync(trackPath, "utf8")) as unknown[])
    : [];
  track.push(record);
  fs.writeFileSync(trackPath, JSON.stringify(track, null, 2));

  console.log(`\nopen it: ${marketAppUrl(createdMarket.marketId)}`);
  console.log(`market:  ${solscanAccountUrl(createdMarket.marketPda)}`);
  console.log(
    `you are this market's authority: resolve it after it ends with client.send.resolveMarket(market, "yes" | "no")`,
  );
  console.log(`record saved to data/demo-market.json + data/track-record.json`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
