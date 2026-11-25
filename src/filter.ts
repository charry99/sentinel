/**
 * Market-worthiness filter — pure functions, no chain access.
 *
 * A signal is worth a market when EITHER:
 *   (a) the asset moved >= 3% in 24h (either direction), OR
 *   (b) the price is within 2% of a round-number threshold.
 * Plus a duplicate guard: no live market may already cover the same
 * asset + resolution window. Everything the loop decides is logged with
 * its reason (see trackRecord.ts) — a skip is a decision, not silence.
 *
 * Round thresholds are per-asset multiples: BTC $5,000, ETH $250, SOL $10.
 * (PLAN.md §4: "24h change >= 3% ... or price within 2% of a round-number
 * threshold".)
 */
import type { Signal } from "./signals";
import {
  buildMarketQuestion,
  COINGECKO_IDS,
  durationSecsUntil,
  SUPPORTED_ASSETS,
  validateCriteria,
  type Asset,
  type MarketCriteria,
} from "./marketCriteria";

/** |24h change| at or above this percent triggers a market. */
export const MOVE_THRESHOLD_PCT = 3;
/** Price within this percent of a round threshold triggers a market. */
export const PROXIMITY_PCT = 2;
/** At most this many new markets per agent tick (devnet budget guard). */
export const MAX_MARKETS_PER_TICK = 1;

/** Round-number step per asset, in USD. */
export const ROUND_STEPS_USD: Record<Asset, number> = {
  BTC: 5000,
  ETH: 250,
  SOL: 10,
};

/** Nearest multiple of `step` to `price` (ties round up). */
export function nearestRoundThreshold(price: number, step: number): number {
  return Math.round(price / step) * step;
}

/** Smallest multiple of `step` strictly above `price`. */
export function nextRoundAbove(price: number, step: number): number {
  return (Math.floor(price / step) + 1) * step;
}

/** |price - threshold| as a percent of the threshold. */
export function proximityPct(price: number, threshold: number): number {
  if (threshold <= 0) return Infinity;
  return (Math.abs(price - threshold) / threshold) * 100;
}

export type WorthinessTrigger = "move" | "proximity" | "move+proximity";

export interface Worthiness {
  worthy: boolean;
  /** Human-readable reason, logged for every decision (create or skip). */
  reason: string;
  /** Threshold the market would use, when worthy. */
  thresholdUsd?: number;
  trigger?: WorthinessTrigger;
  /** The live signal's 24h change, when provided. */
  change24hPct?: number;
}

/**
 * Decide whether a signal is worth a market. Pure — no chain access.
 * RSS/context signals carry no numeric price (metric NaN) and are never
 * worthy; that is by design, not an error.
 */
export function checkWorthy(signal: Signal): Worthiness {
  if (!SUPPORTED_ASSETS.includes(signal.asset)) {
    return { worthy: false, reason: `unsupported asset: ${signal.asset}` };
  }
  const price = signal.metric;
  if (!Number.isFinite(price) || price <= 0) {
    return {
      worthy: false,
      reason: `${signal.asset}: no numeric price (context-only signal from ${signal.source})`,
    };
  }
  const step = ROUND_STEPS_USD[signal.asset];
  const nearest = nearestRoundThreshold(price, step);
  const prox = proximityPct(price, nearest);
  const change = signal.change24hPct;
  const move =
    Number.isFinite(change) && Math.abs(change as number) >= MOVE_THRESHOLD_PCT;
  const near = prox <= PROXIMITY_PCT;

  const changeStr =
    Number.isFinite(change) ? `${(change as number).toFixed(2)}% in 24h` : "no 24h change";
  if (!move && !near) {
    return {
      worthy: false,
      reason:
        `${signal.asset} $${price.toLocaleString("en-US")} (${changeStr}): ` +
        `move below ${MOVE_THRESHOLD_PCT}% and ${prox.toFixed(2)}% from nearest ` +
        `round $${nearest.toLocaleString("en-US")} (needs ≤${PROXIMITY_PCT}%)`,
      change24hPct: change,
    };
  }
  const trigger: WorthinessTrigger =
    move && near ? "move+proximity" : move ? "move" : "proximity";
  // Threshold: the nearby round number when in proximity, else the next
  // round number above the price (the question is always "above $X").
  const thresholdUsd = near ? nearest : nextRoundAbove(price, step);
  const bits: string[] = [];
  if (move) bits.push(`${(change as number).toFixed(2)}% in 24h (≥${MOVE_THRESHOLD_PCT}%)`);
  if (near) bits.push(`${prox.toFixed(2)}% from round $${nearest.toLocaleString("en-US")}`);
  return {
    worthy: true,
    reason: `${signal.asset} $${price.toLocaleString("en-US")}: ${bits.join(" + ")}`,
    thresholdUsd,
    trigger,
    change24hPct: change,
  };
}

/**
 * Resolution time: the next 12:00 UTC at least 24h out (so 24–48h out).
 * Markets resolve inside the hackathon window and stay tradable for a day+.
 */
export function resolveAtFor(now: Date = new Date()): Date {
  const min = new Date(now.getTime() + 24 * 3600 * 1000);
  const out = new Date(min);
  out.setUTCHours(12, 0, 0, 0);
  if (out.getTime() < min.getTime()) out.setUTCDate(out.getUTCDate() + 1);
  return out;
}

/** Minimal shape of a track-record entry the duplicate guard needs. */
export interface LiveMarketRef {
  criteria: { asset: Asset; resolveAt: string };
  status: string;
}

/**
 * Duplicate guard: a live market for the same asset whose resolution time
 * is within 24h of the proposed one already covers this window.
 * Generic so the caller gets its full record type back.
 */
export function isDuplicate<T extends LiveMarketRef>(
  criteria: MarketCriteria,
  liveMarkets: readonly T[],
): T | null {
  const proposed = criteria.resolveAt.getTime();
  for (const m of liveMarkets) {
    if (m.status !== "LIVE") continue;
    if (m.criteria.asset !== criteria.asset) continue;
    const existing = new Date(m.criteria.resolveAt).getTime();
    if (Math.abs(existing - proposed) < 24 * 3600 * 1000) return m;
  }
  return null;
}

/**
 * Turn a worthy signal into validated market criteria, or return the
 * reason it cannot be built. Pure — no chain access.
 */
export function proposeCriteria(
  signal: Signal,
  worthiness: Worthiness,
  now: Date = new Date(),
): { criteria: MarketCriteria; question: string } | { error: string } {
  if (!worthiness.worthy || worthiness.thresholdUsd === undefined) {
    return { error: worthiness.reason };
  }
  const criteria: MarketCriteria = {
    asset: signal.asset,
    direction: "above",
    thresholdUsd: worthiness.thresholdUsd,
    resolveAt: resolveAtFor(now),
    source: `CoinGecko ${signal.asset}/USD`,
    sourceUrl:
      `https://api.coingecko.com/api/v3/simple/price?ids=${COINGECKO_IDS[signal.asset]}&vs_currencies=usd`,
  };
  const check = validateCriteria(criteria, now);
  if (!check.ok) {
    return { error: `criteria failed validation: ${check.errors.join("; ")}` };
  }
  return { criteria, question: buildMarketQuestion(criteria) };
}

/** Duration in seconds for createMarket, from the criteria + now. */
export function durationSecsFor(
  criteria: MarketCriteria,
  now: Date = new Date(),
): number {
  return durationSecsUntil(criteria.resolveAt, now);
}
