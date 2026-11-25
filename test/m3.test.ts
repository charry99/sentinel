import test from "node:test";
import assert from "node:assert/strict";
import { buildSettlementSummary } from "../src/resolution";

test("buildSettlementSummary: winning market recovers deposit + winnings", () => {
  // Spent 55 (50 deposit + 5 buy), wallet went 840 -> 849.5 after settle:
  // recovered 64.5, net +9.5.
  const s = buildSettlementSummary({
    spentUsdc: 55,
    usdcBefore: 840,
    usdcAfter: 849.5,
    outcome: "yes",
    yesBought: 9.512127,
    winningTokensClaimed: 9.512127,
  });
  assert.equal(s.recoveredUsdc, 64.5);
  assert.equal(s.netUsdc, 9.5);
  assert.equal(s.outcome, "yes");
});

test("buildSettlementSummary: losing market recovers only LP residuals", () => {
  // Spent 55, wallet went 840 -> 833 after settle (LP residuals back ~48):
  // recovered 48, net -7.
  const s = buildSettlementSummary({
    spentUsdc: 55,
    usdcBefore: 840,
    usdcAfter: 833,
    outcome: "no",
    yesBought: 9.512127,
    winningTokensClaimed: 0,
  });
  assert.equal(s.recoveredUsdc, 48);
  assert.equal(s.netUsdc, -7);
  assert.equal(s.winningTokensClaimed, 0);
});
