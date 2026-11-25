/**
 * Resolution outcome logic — pure functions, no chain access.
 *
 * The outcome is computed deterministically from the fetched source value
 * vs. the threshold named in the market criteria. Tie (exactly equal)
 * resolves NO. A missing / non-finite source value is never resolved from
 * a guess — the caller must retry or fall back to a documented source.
 */
import type { MarketCriteria } from "./marketCriteria";

export type Outcome = "yes" | "no";

export interface OutcomeInput {
  /** Value fetched from the named source at/near resolution time. */
  fetchedValue: number;
  criteria: MarketCriteria;
}

/**
 * Deterministic outcome: fetched value strictly above the threshold => YES,
 * otherwise (below or exactly equal) => NO.
 * Throws on a non-finite fetched value — never resolve from a guess.
 */
export function computeOutcome(input: OutcomeInput): Outcome {
  const { fetchedValue, criteria } = input;
  if (!Number.isFinite(fetchedValue)) {
    throw new Error(
      `cannot resolve: fetched value from ${criteria.source} is not finite (${fetchedValue})`,
    );
  }
  return fetchedValue > criteria.thresholdUsd ? "yes" : "no";
}

export interface ResolutionProof {
  marketQuestion: string;
  asset: string;
  thresholdUsd: number;
  fetchedValue: number;
  source: string;
  sourceUrl: string;
  fetchedAt: string;
  resolveAt: string;
  outcome: Outcome;
  tieRule: string;
  /** Raw source response, saved verbatim for audit. */
  rawResponse: unknown;
}

/** Build the proof bundle that is published BEFORE the on-chain resolve call. */
export function buildResolutionProof(
  criteria: MarketCriteria,
  fetchedValue: number,
  rawResponse: unknown,
  fetchedAt: Date = new Date(),
): ResolutionProof {
  return {
    marketQuestion: `${criteria.asset} above $${criteria.thresholdUsd} at ${criteria.resolveAt.toISOString()}?`,
    asset: criteria.asset,
    thresholdUsd: criteria.thresholdUsd,
    fetchedValue,
    source: criteria.source,
    sourceUrl: criteria.sourceUrl,
    fetchedAt: fetchedAt.toISOString(),
    resolveAt: criteria.resolveAt.toISOString(),
    outcome: computeOutcome({ fetchedValue, criteria }),
    tieRule: "Exactly equal to the threshold resolves NO.",
    rawResponse,
  };
}

export interface SettlementInput {
  /** mUSDC spent creating + trading the market (deposit + buy). */
  spentUsdc: number;
  usdcBefore: number;
  usdcAfter: number;
  outcome: Outcome;
  yesBought: number;
  winningTokensClaimed: number;
}

export interface SettlementSummary {
  /** mUSDC that came back (LP residuals + winnings), derived from balances. */
  recoveredUsdc: number;
  netUsdc: number;
  outcome: Outcome;
  yesBought: number;
  winningTokensClaimed: number;
}

/**
 * Settlement P/L from wallet balances — pure, testable. Recovered mUSDC is
 * whatever the wallet regained after the spend; net is recovered minus spent.
 * (Faucet claims in between would inflate it — the M3 run claims none.)
 */
export function buildSettlementSummary(input: SettlementInput): SettlementSummary {
  const recoveredUsdc = Number(
    (input.usdcAfter - (input.usdcBefore - input.spentUsdc)).toFixed(6),
  );
  return {
    recoveredUsdc,
    netUsdc: Number((recoveredUsdc - input.spentUsdc).toFixed(6)),
    outcome: input.outcome,
    yesBought: input.yesBought,
    winningTokensClaimed: input.winningTokensClaimed,
  };
}
