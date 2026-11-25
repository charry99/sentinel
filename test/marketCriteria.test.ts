import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMarketDescription,
  buildMarketQuestion,
  durationSecsUntil,
  validateCriteria,
  type MarketCriteria,
} from "../src/marketCriteria";

const NOW = new Date("2026-11-13T15:00:00.000Z");
const good: MarketCriteria = {
  asset: "BTC",
  direction: "above",
  thresholdUsd: 100000,
  resolveAt: new Date("2026-11-20T12:00:00.000Z"),
  source: "CoinGecko BTC/USD",
  sourceUrl:
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
};

test("buildMarketQuestion names asset, threshold, time and source", () => {
  const q = buildMarketQuestion(good);
  assert.equal(q, "BTC above $100k at 2026-11-20 12:00 UTC? (CoinGecko)");
  assert.ok(Buffer.byteLength(q, "utf8") <= 64, "on-chain name must fit 64 bytes");
});

test("validateCriteria accepts a well-formed market", () => {
  const r = validateCriteria(good, NOW);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("validateCriteria rejects resolution <300s out (on-chain minimum)", () => {
  const r = validateCriteria(
    { ...good, resolveAt: new Date("2026-11-13T15:02:00.000Z") },
    NOW,
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /300s/);
});

test("validateCriteria rejects a non-positive threshold", () => {
  const r = validateCriteria({ ...good, thresholdUsd: 0 }, NOW);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /threshold/);
});

test("validateCriteria rejects an unsupported asset", () => {
  const r = validateCriteria(
    { ...good, asset: "DOGE" as never },
    NOW,
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /unsupported asset/);
});

test("validateCriteria rejects a non-https source URL", () => {
  const r = validateCriteria({ ...good, sourceUrl: "http://example.com" }, NOW);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /https/);
});

test("validateCriteria rejects an empty source", () => {
  const r = validateCriteria({ ...good, source: "  " }, NOW);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /source/);
});

test("market name stays within 64 bytes even for a huge threshold", () => {
  const r = validateCriteria({ ...good, thresholdUsd: 999999999999 }, NOW);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const q = buildMarketQuestion({ ...good, thresholdUsd: 999999999999 });
  assert.ok(Buffer.byteLength(q, "utf8") <= 64, q);
});

test("durationSecsUntil is at least 300 and matches the target", () => {
  const secs = durationSecsUntil(good.resolveAt, NOW);
  assert.equal(secs, 7 * 86400 - 3 * 3600); // Nov 13 15:00Z -> Nov 20 12:00Z
  assert.ok(secs >= 300);
});

test("buildMarketDescription states the tie rule and source", () => {
  const d = buildMarketDescription(good);
  assert.match(d, /Tie \(exactly equal\) resolves NO/);
  assert.match(d, /CoinGecko BTC\/USD/);
  assert.match(d, /100,000/);
});
