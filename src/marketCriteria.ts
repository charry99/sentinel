/**
 * Market-criteria builder + validation — pure functions, no chain access.
 *
 * Every Sentinel market question must name the asset, a numeric threshold,
 * an exact UTC resolution time, and the exact source. Drafts failing the
 * checklist are logged and dropped, never created (PLAN.md §4).
 *
 * Tie rule (stated in every market's criteria): exactly equal to the
 * threshold resolves NO.
 */

export type Asset = "BTC" | "ETH" | "SOL";

export const SUPPORTED_ASSETS: readonly Asset[] = ["BTC", "ETH", "SOL"];

export const COINGECKO_IDS: Record<Asset, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
};

export interface MarketCriteria {
  /** e.g. "BTC" */
  asset: Asset;
  /** Comparison direction. v1 only supports "above". */
  direction: "above";
  /** Numeric threshold in USD, e.g. 100000. */
  thresholdUsd: number;
  /** Exact resolution time, UTC. */
  resolveAt: Date;
  /** Named outcome source, e.g. "CoinGecko BTC/USD". */
  source: string;
  /** Raw source endpoint, for audit. */
  sourceUrl: string;
}

/** pm-AMM market names are 1..64 bytes on-chain. */
export const MAX_NAME_BYTES = 64;

export function buildMarketQuestion(c: MarketCriteria): string {
  const date = c.resolveAt.toISOString().slice(0, 16).replace("T", " ");
  return `${c.asset} above $${formatThreshold(c.thresholdUsd)} at ${date} UTC? (CoinGecko)`;
}

function formatThreshold(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Full question for the dashboard / track record (not the on-chain name). */
export function buildMarketDescription(c: MarketCriteria): string {
  return (
    `Will ${c.asset} close above $${c.thresholdUsd.toLocaleString("en-US")} ` +
    `on ${c.resolveAt.toISOString()} per ${c.source}? ` +
    `Tie (exactly equal) resolves NO. Source: ${c.sourceUrl}`
  );
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Criteria checklist — every item must pass before a market is created.
 * `now` is injectable so tests can pin time.
 */
export function validateCriteria(
  c: MarketCriteria,
  now: Date = new Date(),
): ValidationResult {
  const errors: string[] = [];
  if (!SUPPORTED_ASSETS.includes(c.asset)) {
    errors.push(`unsupported asset: ${c.asset}`);
  }
  if (c.direction !== "above") {
    errors.push(`unsupported direction: ${c.direction}`);
  }
  if (!Number.isFinite(c.thresholdUsd) || c.thresholdUsd <= 0) {
    errors.push(`threshold must be a positive number, got ${c.thresholdUsd}`);
  }
  if (!(c.resolveAt instanceof Date) || Number.isNaN(c.resolveAt.getTime())) {
    errors.push("resolveAt must be a valid date");
  } else {
    const secsOut = (c.resolveAt.getTime() - now.getTime()) / 1000;
    if (secsOut < 300) {
      errors.push(
        `resolution must be at least 300s out (on-chain minimum), got ${Math.round(secsOut)}s`,
      );
    }
  }
  if (!c.source || c.source.trim().length === 0) {
    errors.push("source must name the outcome source");
  }
  if (!c.sourceUrl.startsWith("https://")) {
    errors.push("sourceUrl must be an https URL");
  }
  const name = buildMarketQuestion(c);
  const bytes = Buffer.byteLength(name, "utf8");
  if (bytes < 1 || bytes > MAX_NAME_BYTES) {
    errors.push(`on-chain market name must be 1..64 bytes, got ${bytes}: "${name}"`);
  }
  return { ok: errors.length === 0, errors };
}

/** Duration in whole seconds from `now` until resolution. */
export function durationSecsUntil(
  resolveAt: Date,
  now: Date = new Date(),
): number {
  return Math.max(
    300,
    Math.floor((resolveAt.getTime() - now.getTime()) / 1000),
  );
}
