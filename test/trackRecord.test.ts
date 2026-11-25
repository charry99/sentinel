import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendDecision,
  appendMarketRecord,
  appendSnapshot,
  liveMarkets,
  readDecisions,
  readTrackRecord,
  type MarketRecord,
} from "../src/trackRecord";

function tmpDir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-m2-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function record(overrides: Partial<MarketRecord> = {}): MarketRecord {
  return {
    name: "BTC above $70k at 2026-11-15 12:00 UTC? (CoinGecko)",
    criteria: {
      asset: "BTC",
      direction: "above",
      thresholdUsd: 70000,
      resolveAt: "2026-11-15T12:00:00.000Z",
      source: "CoinGecko BTC/USD",
      sourceUrl: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
      tieRule: "Exactly equal to the threshold resolves NO.",
    },
    marketId: 123,
    marketPda: "11111111111111111111111111111111",
    marketAppUrl: "https://pm-amm-devnet.vercel.app/market/123",
    explorerAccount: "https://solscan.io/account/11111111111111111111111111111111?cluster=devnet",
    createTx: "x".repeat(88),
    createTxUrl: "https://solscan.io/tx/x?cluster=devnet",
    swapTx: null,
    swapTxUrl: null,
    yesBought: null,
    yesPricePctAfterBuy: 50,
    creator: "B6mbz82NKSk6NEr1AFmjrGs46pS1SeTCx3JNDHxQb7b5",
    createdAt: "2026-11-13T15:10:00.000Z",
    status: "LIVE",
    resolution: "Pending",
    ...overrides,
  };
}

test("track record: append + read round-trips", (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(readTrackRecord(dir), []);
  appendMarketRecord(dir, record());
  appendMarketRecord(dir, record({ marketId: 124 }));
  const records = readTrackRecord(dir);
  assert.equal(records.length, 2);
  assert.equal(records[0].marketId, 123);
  assert.equal(records[1].marketId, 124);
});

test("liveMarkets: only LIVE + future resolveAt count", (t) => {
  const dir = tmpDir(t);
  const now = new Date("2026-11-13T15:10:00.000Z");
  const records = [
    record(),
    record({
      marketId: 124,
      criteria: { ...record().criteria, resolveAt: "2026-11-13T12:00:00.000Z" },
    }),
    record({ marketId: 125, status: "RESOLVED" }),
  ];
  assert.equal(liveMarkets(records, now).length, 1);
  assert.equal(liveMarkets(records, now)[0].marketId, 123);
});

test("decisions: append + read JSONL", (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(readDecisions(dir), []);
  appendDecision(dir, {
    at: "2026-11-13T15:10:00.000Z",
    signalId: "coingecko-bitcoin-2026-11-13T15:10:00.000Z",
    source: "CoinGecko",
    asset: "BTC",
    summary: "BTC $68,851 (-3.37% in 24h)",
    outcome: "created",
    reason: "BTC -3.37% in 24h",
    marketPda: "11111111111111111111111111111111",
    marketId: 123,
    createTx: "x".repeat(88),
    question: "BTC above $70k at 2026-11-15 12:00 UTC? (CoinGecko)",
  });
  appendDecision(dir, {
    at: "2026-11-13T15:10:00.000Z",
    signalId: "coingecko-ethereum-2026-11-13T15:10:00.000Z",
    source: "CoinGecko",
    asset: "ETH",
    summary: "ETH $1,943.81 (-2.60% in 24h)",
    outcome: "skipped",
    reason: "move below 3%",
  });
  const entries = readDecisions(dir);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].outcome, "created");
  assert.equal(entries[1].outcome, "skipped");
  const raw = fs.readFileSync(path.join(dir, "decisions.jsonl"), "utf8");
  assert.equal(raw.trim().split("\n").length, 2);
});

test("snapshots: appends one JSON line per snapshot", (t) => {
  const dir = tmpDir(t);
  appendSnapshot(dir, {
    at: "2026-11-13T15:10:00.000Z",
    marketId: 123,
    marketPda: "11111111111111111111111111111111",
    yesPricePct: 50,
    reserveYes: 100,
    reserveNo: 100,
    secondsLeft: 144000,
    resolved: false,
  });
  const lines = fs
    .readFileSync(path.join(dir, "snapshots.jsonl"), "utf8")
    .trim()
    .split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).yesPricePct, 50);
});
