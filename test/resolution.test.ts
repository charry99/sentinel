import test from "node:test";
import assert from "node:assert/strict";
import { buildResolutionProof, computeOutcome } from "../src/resolution";
import type { MarketCriteria } from "../src/marketCriteria";

const criteria: MarketCriteria = {
  asset: "BTC",
  direction: "above",
  thresholdUsd: 100000,
  resolveAt: new Date("2026-11-20T12:00:00.000Z"),
  source: "CoinGecko BTC/USD",
  sourceUrl:
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
};

test("computeOutcome: above threshold => YES", () => {
  assert.equal(computeOutcome({ fetchedValue: 100001, criteria }), "yes");
  assert.equal(computeOutcome({ fetchedValue: 150000, criteria }), "yes");
});

test("computeOutcome: below threshold => NO", () => {
  assert.equal(computeOutcome({ fetchedValue: 99999, criteria }), "no");
  assert.equal(computeOutcome({ fetchedValue: 50000, criteria }), "no");
});

test("computeOutcome: exactly equal (tie) => NO", () => {
  assert.equal(computeOutcome({ fetchedValue: 100000, criteria }), "no");
});

test("computeOutcome: non-finite value throws — never resolve from a guess", () => {
  assert.throws(
    () => computeOutcome({ fetchedValue: Number.NaN, criteria }),
    /not finite/,
  );
  assert.throws(
    () => computeOutcome({ fetchedValue: Infinity, criteria }),
    /not finite/,
  );
});

test("buildResolutionProof bundles value, threshold, outcome and raw response", () => {
  const raw = { bitcoin: { usd: 101234 } };
  const proof = buildResolutionProof(criteria, 101234, raw, new Date("2026-11-20T12:00:30.000Z"));
  assert.equal(proof.outcome, "yes");
  assert.equal(proof.fetchedValue, 101234);
  assert.equal(proof.thresholdUsd, 100000);
  assert.equal(proof.source, "CoinGecko BTC/USD");
  assert.equal(proof.fetchedAt, "2026-11-20T12:00:30.000Z");
  assert.equal(proof.tieRule, "Exactly equal to the threshold resolves NO.");
  assert.deepEqual(proof.rawResponse, raw);
});

test("buildResolutionProof: tie value produces a NO proof", () => {
  const proof = buildResolutionProof(criteria, 100000, { bitcoin: { usd: 100000 } });
  assert.equal(proof.outcome, "no");
});
