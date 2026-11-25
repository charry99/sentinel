import test from "node:test";
import assert from "node:assert/strict";
import {
  checkWorthy,
  isDuplicate,
  nearestRoundThreshold,
  nextRoundAbove,
  proposeCriteria,
  proximityPct,
  resolveAtFor,
} from "../src/filter";
import type { Signal } from "../src/signals";

const NOW = new Date("2026-11-13T15:07:00.000Z");

function priceSignal(
  asset: Signal["asset"],
  price: number,
  change24hPct?: number,
): Signal {
  return {
    id: `test-${asset}`,
    source: "CoinGecko",
    summary: `${asset} $${price} (${change24hPct ?? "?"}% in 24h)`,
    asset,
    metric: price,
    change24hPct,
    fetchedAt: NOW.toISOString(),
    rawRef: "https://example.com",
  };
}

// Live 2026-11-13 ~15:07 UTC prices (used as fixtures, not fetched):
// BTC $68,851 (-3.37%), ETH $1,943.81 (-2.60%), SOL $80.37 (-0.59%).

test("round thresholds: BTC steps of $5,000", () => {
  assert.equal(nearestRoundThreshold(68851, 5000), 70000);
  assert.equal(nextRoundAbove(68851, 5000), 70000);
  assert.equal(nextRoundAbove(70000, 5000), 75000);
  assert.equal(nearestRoundThreshold(1943.81, 250), 2000);
  assert.equal(nearestRoundThreshold(80.37, 10), 80);
});

test("proximityPct: BTC $68,851 is 1.64% from $70,000", () => {
  const p = proximityPct(68851, 70000);
  assert.ok(Math.abs(p - 1.6414) < 0.01, String(p));
  assert.equal(proximityPct(80.37, 80).toFixed(2), "0.46");
});

test("checkWorthy: BTC -3.37% + near $70k is worthy (move+proximity)", () => {
  const w = checkWorthy(priceSignal("BTC", 68851, -3.3726));
  assert.equal(w.worthy, true);
  assert.equal(w.trigger, "move+proximity");
  assert.equal(w.thresholdUsd, 70000);
});

test("checkWorthy: ETH -2.60% and 2.81% from $2,000 is not worthy", () => {
  const w = checkWorthy(priceSignal("ETH", 1943.81, -2.6024));
  assert.equal(w.worthy, false);
  assert.match(w.reason, /below 3%/);
});

test("checkWorthy: SOL -0.59% but 0.46% from $80 is worthy (proximity)", () => {
  const w = checkWorthy(priceSignal("SOL", 80.37, -0.587));
  assert.equal(w.worthy, true);
  assert.equal(w.trigger, "proximity");
  assert.equal(w.thresholdUsd, 80);
});

test("checkWorthy: big move alone is worthy even far from a round number", () => {
  const w = checkWorthy(priceSignal("BTC", 67231, 4.1));
  assert.equal(w.worthy, true);
  assert.equal(w.trigger, "move");
  // Next round above $67,231 at $5,000 steps is $70,000.
  assert.equal(w.thresholdUsd, 70000);
});

test("checkWorthy: quiet price far from any round number is not worthy", () => {
  const w = checkWorthy(priceSignal("ETH", 1871, 0.4));
  assert.equal(w.worthy, false);
});

test("checkWorthy: context-only RSS signal (no price) is never worthy", () => {
  const w = checkWorthy({
    id: "rss-1",
    source: "RSS: Cointelegraph",
    summary: "Bitcoin slides as traders de-risk",
    asset: "BTC",
    metric: Number.NaN,
    fetchedAt: NOW.toISOString(),
    rawRef: "https://cointelegraph.com/news/x",
  });
  assert.equal(w.worthy, false);
  assert.match(w.reason, /context-only/);
});

test("checkWorthy: missing 24h change still allows a proximity trigger", () => {
  const w = checkWorthy(priceSignal("SOL", 80.2, undefined));
  assert.equal(w.worthy, true);
  assert.equal(w.trigger, "proximity");
});

test("resolveAtFor: Nov 13 15:07 UTC -> Nov 15 12:00 UTC (24-48h out)", () => {
  const r = resolveAtFor(NOW);
  assert.equal(r.toISOString(), "2026-11-15T12:00:00.000Z");
});

test("resolveAtFor: just after a 12:00 UTC skips to the next day (>=24h out)", () => {
  const r = resolveAtFor(new Date("2026-11-13T12:05:00.000Z"));
  // Nov 14 12:00 would be only 23h55m out — must be Nov 15 12:00.
  assert.equal(r.toISOString(), "2026-11-15T12:00:00.000Z");
});

test("proposeCriteria builds a valid question for the live BTC signal", () => {
  const signal = priceSignal("BTC", 68851, -3.3726);
  const w = checkWorthy(signal);
  const p = proposeCriteria(signal, w, NOW);
  assert.ok(!("error" in p), JSON.stringify(p));
  if ("error" in p) return;
  assert.equal(
    p.question,
    "BTC above $70k at 2026-11-15 12:00 UTC? (CoinGecko)",
  );
  assert.equal(p.criteria.thresholdUsd, 70000);
  assert.equal(p.criteria.resolveAt.toISOString(), "2026-11-15T12:00:00.000Z");
  assert.equal(p.criteria.source, "CoinGecko BTC/USD");
});

test("isDuplicate: same asset + window within 24h blocks", () => {
  const signal = priceSignal("BTC", 68851, -3.3726);
  const w = checkWorthy(signal);
  const p = proposeCriteria(signal, w, NOW);
  assert.ok(!("error" in p));
  if ("error" in p) return;
  const live = [
    {
      criteria: { asset: "BTC" as const, resolveAt: "2026-11-15T12:00:00.000Z" },
      status: "LIVE",
    },
  ];
  assert.ok(isDuplicate(p.criteria, live));
});

test("isDuplicate: existing BTC market resolving Nov 20 does NOT block Nov 15", () => {
  const signal = priceSignal("BTC", 68851, -3.3726);
  const w = checkWorthy(signal);
  const p = proposeCriteria(signal, w, NOW);
  assert.ok(!("error" in p));
  if ("error" in p) return;
  const live = [
    {
      criteria: { asset: "BTC" as const, resolveAt: "2026-11-20T12:00:00.000Z" },
      status: "LIVE",
    },
  ];
  assert.equal(isDuplicate(p.criteria, live), null);
});

test("isDuplicate: different asset never blocks", () => {
  const signal = priceSignal("BTC", 68851, -3.3726);
  const w = checkWorthy(signal);
  const p = proposeCriteria(signal, w, NOW);
  assert.ok(!("error" in p));
  if ("error" in p) return;
  const live = [
    {
      criteria: { asset: "SOL" as const, resolveAt: "2026-11-15T12:00:00.000Z" },
      status: "LIVE",
    },
  ];
  assert.equal(isDuplicate(p.criteria, live), null);
});
