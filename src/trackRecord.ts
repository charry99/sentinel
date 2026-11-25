/**
 * Track-record store — the agent's public memory.
 *
 * - `data/track-record.json`: every market the agent created (same shape
 *   as demo.ts writes; M4's dashboard reads this file).
 * - `data/decisions.jsonl`: one JSON line per loop decision —
 *   signal seen → filter verdict → created / skipped + reason.
 *   A skip is a decision, not silence: the log is the audit trail.
 * - `data/snapshots.jsonl`: one JSON line per price snapshot of a live
 *   market (marketId, YES price, reserves, timestamp).
 *
 * All writes are append-only except track-record.json, which is rewritten
 * whole (small file, human-readable). Nothing here touches the chain.
 */
import * as fs from "fs";
import * as path from "path";
import type { Asset } from "./marketCriteria";

/** Market record — same shape demo.ts writes to track-record.json. */
export interface MarketRecord {
  name: string;
  criteria: {
    asset: Asset;
    direction: string;
    thresholdUsd: number;
    resolveAt: string;
    source: string;
    sourceUrl: string;
    tieRule: string;
  };
  marketId: number;
  marketPda: string;
  marketAppUrl: string;
  explorerAccount: string;
  createTx: string;
  createTxUrl: string;
  swapTx: string | null;
  swapTxUrl: string | null;
  yesBought: string | null;
  yesPricePctAfterBuy: number | null;
  creator: string;
  createdAt: string;
  status: string;
  resolution: string;
}

export type DecisionOutcome = "created" | "skipped" | "error";

export interface DecisionEntry {
  at: string;
  signalId: string;
  source: string;
  asset: string;
  summary: string;
  outcome: DecisionOutcome;
  /** Why: the filter verdict, the duplicate hit, or the error. */
  reason: string;
  marketPda?: string;
  marketId?: number;
  createTx?: string;
  question?: string;
}

export interface PriceSnapshot {
  at: string;
  marketId: number;
  marketPda: string;
  yesPricePct: number;
  reserveYes: number;
  reserveNo: number;
  secondsLeft: number;
  resolved: boolean;
}

export function trackRecordPath(dataDir: string): string {
  return path.join(dataDir, "track-record.json");
}

export function decisionsPath(dataDir: string): string {
  return path.join(dataDir, "decisions.jsonl");
}

export function snapshotsPath(dataDir: string): string {
  return path.join(dataDir, "snapshots.jsonl");
}

export function readTrackRecord(dataDir: string): MarketRecord[] {
  const p = trackRecordPath(dataDir);
  if (!fs.existsSync(p)) return [];
  const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed as MarketRecord[];
}

/** Append a market record (rewrites the JSON file whole). */
export function appendMarketRecord(
  dataDir: string,
  record: MarketRecord,
): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const records = readTrackRecord(dataDir);
  records.push(record);
  fs.writeFileSync(
    trackRecordPath(dataDir),
    JSON.stringify(records, null, 2),
  );
}

/** Live markets: status LIVE and resolution still in the future. */
export function liveMarkets(
  records: readonly MarketRecord[],
  now: Date = new Date(),
): MarketRecord[] {
  return records.filter(
    (r) =>
      r.status === "LIVE" && new Date(r.criteria.resolveAt).getTime() > now.getTime(),
  );
}

export function appendDecision(dataDir: string, entry: DecisionEntry): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(decisionsPath(dataDir), JSON.stringify(entry) + "\n");
}

export function appendSnapshot(dataDir: string, snap: PriceSnapshot): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(snapshotsPath(dataDir), JSON.stringify(snap) + "\n");
}

export function readSnapshots(dataDir: string): PriceSnapshot[] {
  const p = snapshotsPath(dataDir);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as PriceSnapshot);
}

export function readDecisions(dataDir: string): DecisionEntry[] {
  const p = decisionsPath(dataDir);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as DecisionEntry);
}
