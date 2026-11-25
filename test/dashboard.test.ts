import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildDashboardData,
  displayStatus,
  generateDashboard,
  parseResolution,
  renderDashboardHtml,
} from "../src/dashboard";
import type { MarketRecord } from "../src/trackRecord";

const NOW = new Date("2026-11-24T00:00:00.000Z");

function tmpDir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-m4-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function record(overrides: Partial<MarketRecord> = {}): MarketRecord {
  return {
    name: "BTC above $70k at 2026-11-25 12:00 UTC? (CoinGecko)",
    criteria: {
      asset: "BTC",
      direction: "above",
      thresholdUsd: 70000,
      resolveAt: "2026-11-25T12:00:00.000Z",
      source: "CoinGecko BTC/USD",
      sourceUrl:
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
      tieRule: "Exactly equal to the threshold resolves NO.",
    },
    marketId: 123,
    marketPda: "11111111111111111111111111111111",
    marketAppUrl: "https://pm-amm-devnet.vercel.app/market/123",
    explorerAccount:
      "https://solscan.io/account/11111111111111111111111111111111?cluster=devnet",
    createTx: "x".repeat(88),
    createTxUrl: "https://solscan.io/tx/x?cluster=devnet",
    swapTx: null,
    swapTxUrl: null,
    yesBought: null,
    yesPricePctAfterBuy: 50,
    creator: "B6mbz82NKSk6NEr1AFmjrGs46pS1SeTCx3JNDHxQb7b5",
    createdAt: "2026-11-23T15:10:00.000Z",
    status: "LIVE",
    resolution: "Pending — resolves after 2026-11-25T12:00:00Z.",
    ...overrides,
  };
}

const RESOLVED = record({
  marketId: 456,
  marketPda: "22222222222222222222222222222222",
  status: "RESOLVED",
  criteria: {
    asset: "BTC",
    direction: "above",
    thresholdUsd: 68000,
    resolveAt: "2026-11-13T15:35:00.000Z",
    source: "CoinGecko BTC/USD",
    sourceUrl:
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
    tieRule: "Exactly equal to the threshold resolves NO.",
  },
  resolution: JSON.stringify({
    outcome: "yes",
    fetchedValue: 68389,
    fetchedAt: "2026-11-13T15:35:18.664Z",
    source: "CoinGecko BTC/USD",
    resolveTx: "r".repeat(88),
    accrueTx: "a".repeat(88),
    claimLpResidualsTx: "b".repeat(88),
    claimWinningsTx: "c".repeat(88),
    spentUsdc: 55,
    recoveredUsdc: 54.949998,
    netUsdc: -0.050002,
    resolvedAt: "2026-11-13T15:35:57.790Z",
  }),
});

function seedDataDir(dir: string): void {
  const ended = record({
    marketId: 789,
    marketPda: "33333333333333333333333333333333",
    createdAt: "2026-11-13T15:10:00.000Z",
    criteria: {
      ...record().criteria,
      thresholdUsd: 70000,
      resolveAt: "2026-11-15T12:00:00.000Z",
    },
    resolution: "Pending — resolves after 2026-11-15T12:00:00Z.",
  });
  fs.writeFileSync(
    path.join(dir, "track-record.json"),
    JSON.stringify([record(), RESOLVED, ended], null, 2),
  );
  fs.writeFileSync(
    path.join(dir, "decisions.jsonl"),
    [
      JSON.stringify({
        at: "2026-11-13T15:10:00.000Z",
        signalId: "s1",
        source: "CoinGecko",
        asset: "BTC",
        summary: "BTC $68,790 (-3.57% in 24h)",
        outcome: "created",
        reason: "worthy",
      }),
      JSON.stringify({
        at: "2026-11-13T15:11:00.000Z",
        signalId: "s2",
        source: "CoinGecko",
        asset: "ETH",
        summary: "ETH $1,942 (-2.88% in 24h)",
        outcome: "skipped",
        reason: "move below 3%",
      }),
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(dir, "snapshots.jsonl"),
    JSON.stringify({
      at: "2026-11-23T15:10:00.000Z",
      marketId: 123,
      marketPda: "11111111111111111111111111111111",
      yesPricePct: 51.5,
      reserveYes: 100,
      reserveNo: 100,
      secondsLeft: 75600,
      resolved: false,
    }) + "\n",
  );
  fs.writeFileSync(
    path.join(dir, "resolution-proof-456.json"),
    JSON.stringify({
      marketId: 456,
      outcome: "yes",
      fetchedValue: 68389,
      fetchedAt: "2026-11-13T15:35:18.664Z",
      rawResponse: { bitcoin: { usd: 68389 } },
    }),
  );
}

test("displayStatus: future LIVE stays LIVE, past LIVE becomes ENDED", () => {
  assert.equal(displayStatus(record(), NOW), "LIVE");
  const past = record({
    criteria: { ...record().criteria, resolveAt: "2026-11-15T12:00:00.000Z" },
  });
  assert.equal(displayStatus(past, NOW), "ENDED");
  assert.equal(displayStatus(RESOLVED, NOW), "RESOLVED");
});

test("parseResolution: pending record yields a note, no resolution", () => {
  const { resolution, note } = parseResolution(record());
  assert.equal(resolution, null);
  assert.match(note ?? "", /Pending/);
});

test("parseResolution: resolved JSON yields outcome, proof + settle txs", () => {
  const { resolution, note } = parseResolution(RESOLVED, {
    file: "resolution-proof-456.json",
    fetchedValue: 68389,
    rawResponse: { bitcoin: { usd: 68389 } },
  });
  assert.equal(note, null);
  assert.equal(resolution?.outcome, "yes");
  assert.equal(resolution?.fetchedValue, 68389);
  assert.equal(resolution?.netUsdc, -0.050002);
  assert.equal(resolution?.settleTxs.length, 3);
  assert.match(resolution?.resolveTxUrl ?? "", /solscan\.io\/tx\//);
  assert.equal(resolution?.proofFile, "resolution-proof-456.json");
  assert.deepEqual(resolution?.proofRawResponse, { bitcoin: { usd: 68389 } });
  assert.equal(resolution?.parsed, true);
});

test("parseResolution: unparseable resolved text is surfaced raw", () => {
  const weird = record({ status: "RESOLVED", resolution: "resolved by hand" });
  const { resolution } = parseResolution(weird);
  assert.equal(resolution?.parsed, false);
  assert.equal(resolution?.raw, "resolved by hand");
});

test("buildDashboardData: stats, ordering, snapshots + proof wiring", (t) => {
  const dir = tmpDir(t);
  seedDataDir(dir);
  const data = buildDashboardData(dir, NOW);
  assert.equal(data.stats.marketsCreated, 3);
  assert.equal(data.stats.resolved, 1);
  assert.equal(data.stats.live, 1);
  assert.equal(data.stats.endedAwaitingResolution, 1);
  assert.equal(data.stats.decisionsLogged, 2);
  assert.equal(data.stats.decisionsCreated, 1);
  assert.equal(data.stats.decisionsSkipped, 1);
  assert.equal(data.stats.snapshotsLogged, 1);
  // Newest market first; decisions newest first.
  assert.equal(data.markets[0].marketId, 123);
  assert.equal(data.decisions[0].asset, "ETH");
  const live = data.markets.find((m) => m.marketId === 123);
  assert.equal(live?.latestYesPricePct, 51.5);
  assert.equal(live?.snapshots.length, 1);
  const resolved = data.markets.find((m) => m.marketId === 456);
  assert.equal(resolved?.resolution?.proofFile, "resolution-proof-456.json");
  const ended = data.markets.find((m) => m.marketId === 789);
  assert.equal(ended?.displayStatus, "ENDED");
  assert.equal(ended?.resolution, null);
});

test("buildDashboardData: empty data dir yields an empty dashboard", (t) => {
  const dir = tmpDir(t);
  const data = buildDashboardData(dir, NOW);
  assert.equal(data.stats.marketsCreated, 0);
  assert.deepEqual(data.markets, []);
  assert.deepEqual(data.decisions, []);
});

test("generateDashboard: writes index.html + data.json that round-trip", (t) => {
  const dir = tmpDir(t);
  seedDataDir(dir);
  const out = path.join(dir, "dashboard");
  const { data, htmlPath, dataPath } = generateDashboard(dir, out, NOW);
  assert.ok(fs.existsSync(htmlPath));
  assert.ok(fs.existsSync(dataPath));
  const html = fs.readFileSync(htmlPath, "utf8");
  assert.match(html, /Sentinel — public track record/);
  assert.match(html, /BTC above \$70k/);
  const roundTripped = JSON.parse(fs.readFileSync(dataPath, "utf8")) as {
    stats: { marketsCreated: number };
  };
  assert.equal(roundTripped.stats.marketsCreated, data.stats.marketsCreated);
  assert.equal(renderDashboardHtml(data), html);
});
