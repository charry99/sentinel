/**
 * Public dashboard (M4) — Sentinel's track record as a static page.
 *
 * PLAN.md stack decision: static HTML/JS + a JSON data file, no build
 * framework, no server. This module is the generator:
 *
 *   npm run dashboard   →   dashboard/index.html + dashboard/data.json
 *
 * It reads ONLY the agent's own public data files (track-record.json,
 * decisions.jsonl, snapshots.jsonl, resolution-proof-*.json) and never
 * touches the chain, so regenerating is free and safe at any time. The
 * page can be hosted as-is (GitHub Pages serves the dashboard/ folder)
 * or opened from disk.
 *
 * Honesty rules baked in (the track record is the product's credibility):
 * - A market whose resolve time has passed but which has no recorded
 *   resolution is shown as ENDED — AWAITING RESOLUTION, never quietly
 *   relabelled resolved or dropped.
 * - Resolution details come from the resolution JSON the resolver wrote
 *   into the track record plus the proof bundle saved BEFORE the
 *   on-chain call; both are shown with their tx links.
 * - Counts are computed from the files, never hard-coded.
 */
import * as fs from "fs";
import * as path from "path";
import {
  readDecisions,
  readSnapshots,
  readTrackRecord,
  type DecisionEntry,
  type MarketRecord,
  type PriceSnapshot,
} from "./trackRecord";
import { PROGRAM_ID, REFERENCE_APP, USDC_MINT, solscanTxUrl } from "./constants";

export type MarketDisplayStatus = "LIVE" | "ENDED" | "RESOLVED";

/** Parsed view of a resolved market's resolution record. */
export interface ResolutionView {
  outcome: string | null;
  fetchedValue: number | null;
  fetchedAt: string | null;
  source: string | null;
  resolveTxUrl: string | null;
  /** Accrue / claim settle transactions, labelled, in settlement order. */
  settleTxs: { label: string; url: string }[];
  spentUsdc: number | null;
  recoveredUsdc: number | null;
  netUsdc: number | null;
  resolvedAt: string | null;
  /** Proof-bundle file name (data/resolution-proof-<marketId>.json). */
  proofFile: string | null;
  /** Raw source response from the proof bundle, when one exists. */
  proofRawResponse: unknown;
  /** False when the stored resolution text was not JSON (shown raw). */
  parsed: boolean;
  raw: string | null;
}

export interface MarketView {
  name: string;
  asset: string;
  direction: string;
  thresholdUsd: number;
  resolveAt: string;
  source: string;
  sourceUrl: string;
  tieRule: string;
  marketId: number;
  marketPda: string;
  marketAppUrl: string;
  explorerAccount: string;
  createTxUrl: string;
  swapTxUrl: string | null;
  yesBought: string | null;
  yesPricePctAfterBuy: number | null;
  creator: string;
  createdAt: string;
  displayStatus: MarketDisplayStatus;
  /** Set when resolved; null while pending. */
  resolution: ResolutionView | null;
  /** The stored "Pending — …" note while unresolved, else null. */
  resolutionNote: string | null;
  snapshots: { at: string; yesPricePct: number }[];
  latestYesPricePct: number | null;
}

export interface DashboardStats {
  marketsCreated: number;
  resolved: number;
  live: number;
  endedAwaitingResolution: number;
  decisionsLogged: number;
  decisionsCreated: number;
  decisionsSkipped: number;
  decisionsErrored: number;
  snapshotsLogged: number;
}

export interface DashboardData {
  generatedAt: string;
  network: "devnet";
  programId: string;
  usdcMint: string;
  referenceApp: string;
  stats: DashboardStats;
  /** Newest first. */
  markets: MarketView[];
  /** Newest first. */
  decisions: DecisionEntry[];
}

interface ProofBundle {
  fetchedValue?: number;
  fetchedAt?: string;
  outcome?: string;
  rawResponse?: unknown;
}

function loadProofBundles(dataDir: string): Map<number, ProofBundle & { file: string }> {
  const proofs = new Map<number, ProofBundle & { file: string }>();
  if (!fs.existsSync(dataDir)) return proofs;
  for (const file of fs.readdirSync(dataDir)) {
    const m = /^resolution-proof-(\d+)\.json$/.exec(file);
    if (!m) continue;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(dataDir, file), "utf8"),
      ) as ProofBundle;
      proofs.set(Number(m[1]), { ...parsed, file });
    } catch {
      // A corrupt proof file must not break the dashboard; the market's
      // own resolution record still renders.
    }
  }
  return proofs;
}

/**
 * Parse a market record's resolution field. Resolved records store a
 * JSON string (written by the resolver in m3.ts); pending records store
 * a "Pending — …" note. Anything else is surfaced raw, never hidden.
 */
export function parseResolution(
  record: MarketRecord,
  proof?: (ProofBundle & { file: string }) | null,
): { resolution: ResolutionView | null; note: string | null } {
  const text = record.resolution ?? "";
  if (record.status !== "RESOLVED") {
    return { resolution: null, note: text.length > 0 ? text : null };
  }
  let obj: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      obj = parsed as Record<string, unknown>;
    }
  } catch {
    obj = null;
  }
  if (obj === null) {
    return {
      resolution: {
        outcome: null,
        fetchedValue: proof?.fetchedValue ?? null,
        fetchedAt: proof?.fetchedAt ?? null,
        source: null,
        resolveTxUrl: null,
        settleTxs: [],
        spentUsdc: null,
        recoveredUsdc: null,
        netUsdc: null,
        resolvedAt: null,
        proofFile: proof?.file ?? null,
        proofRawResponse: proof?.rawResponse ?? null,
        parsed: false,
        raw: text,
      },
      note: null,
    };
  }
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const settleTxs: { label: string; url: string }[] = [];
  const settle: [string, string][] = [
    ["Accrue interest", "accrueTx"],
    ["Claim LP residuals", "claimLpResidualsTx"],
    ["Claim winnings", "claimWinningsTx"],
  ];
  for (const [label, key] of settle) {
    const sig = str(obj[key]);
    if (sig) settleTxs.push({ label, url: solscanTxUrl(sig) });
  }
  const resolveTx = str(obj.resolveTx);
  return {
    resolution: {
      outcome: str(obj.outcome) ?? proof?.outcome ?? null,
      fetchedValue: num(obj.fetchedValue) ?? proof?.fetchedValue ?? null,
      fetchedAt: str(obj.fetchedAt) ?? proof?.fetchedAt ?? null,
      source: str(obj.source),
      resolveTxUrl: resolveTx ? solscanTxUrl(resolveTx) : null,
      settleTxs,
      spentUsdc: num(obj.spentUsdc),
      recoveredUsdc: num(obj.recoveredUsdc),
      netUsdc: num(obj.netUsdc),
      resolvedAt: str(obj.resolvedAt),
      proofFile: proof?.file ?? null,
      proofRawResponse: proof?.rawResponse ?? null,
      parsed: true,
      raw: null,
    },
    note: null,
  };
}

/** LIVE only while the resolve time is still ahead; past it, ENDED. */
export function displayStatus(
  record: MarketRecord,
  now: Date = new Date(),
): MarketDisplayStatus {
  if (record.status === "RESOLVED") return "RESOLVED";
  return new Date(record.criteria.resolveAt).getTime() > now.getTime()
    ? "LIVE"
    : "ENDED";
}

export function toMarketView(
  record: MarketRecord,
  snapshots: readonly PriceSnapshot[],
  proof: (ProofBundle & { file: string }) | null,
  now: Date = new Date(),
): MarketView {
  const { resolution, note } = parseResolution(record, proof);
  const own = snapshots
    .filter((s) => s.marketPda === record.marketPda)
    .map((s) => ({ at: s.at, yesPricePct: s.yesPricePct }));
  return {
    name: record.name,
    asset: record.criteria.asset,
    direction: record.criteria.direction,
    thresholdUsd: record.criteria.thresholdUsd,
    resolveAt: record.criteria.resolveAt,
    source: record.criteria.source,
    sourceUrl: record.criteria.sourceUrl,
    tieRule: record.criteria.tieRule,
    marketId: record.marketId,
    marketPda: record.marketPda,
    marketAppUrl: record.marketAppUrl,
    explorerAccount: record.explorerAccount,
    createTxUrl: record.createTxUrl,
    swapTxUrl: record.swapTxUrl,
    yesBought: record.yesBought,
    yesPricePctAfterBuy: record.yesPricePctAfterBuy,
    creator: record.creator,
    createdAt: record.createdAt,
    displayStatus: displayStatus(record, now),
    resolution,
    resolutionNote: note,
    snapshots: own,
    latestYesPricePct:
      own.length > 0
        ? own[own.length - 1].yesPricePct
        : record.yesPricePctAfterBuy,
  };
}

/** Build the full dashboard data model from the agent's data files. */
export function buildDashboardData(
  dataDir: string,
  now: Date = new Date(),
): DashboardData {
  const records = readTrackRecord(dataDir);
  const decisions = readDecisions(dataDir);
  const snapshots = readSnapshots(dataDir);
  const proofs = loadProofBundles(dataDir);
  const markets = records
    .map((r) => toMarketView(r, snapshots, proofs.get(r.marketId) ?? null, now))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const stats: DashboardStats = {
    marketsCreated: markets.length,
    resolved: markets.filter((m) => m.displayStatus === "RESOLVED").length,
    live: markets.filter((m) => m.displayStatus === "LIVE").length,
    endedAwaitingResolution: markets.filter(
      (m) => m.displayStatus === "ENDED",
    ).length,
    decisionsLogged: decisions.length,
    decisionsCreated: decisions.filter((d) => d.outcome === "created").length,
    decisionsSkipped: decisions.filter((d) => d.outcome === "skipped").length,
    decisionsErrored: decisions.filter((d) => d.outcome === "error").length,
    snapshotsLogged: snapshots.length,
  };
  return {
    generatedAt: now.toISOString(),
    network: "devnet",
    programId: PROGRAM_ID.toBase58(),
    usdcMint: USDC_MINT.toBase58(),
    referenceApp: REFERENCE_APP,
    stats,
    markets,
    decisions: [...decisions].sort((a, b) => b.at.localeCompare(a.at)),
  };
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sentinel — public track record</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif;
         background: #0b0e14; color: #e6e9ee; }
  main { max-width: 880px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 28px; margin: 0 0 4px; }
  h2 { font-size: 19px; margin: 36px 0 12px; }
  .sub { color: #9aa4b2; margin: 0 0 16px; line-height: 1.5; }
  .meta { color: #9aa4b2; font-size: 13px; line-height: 1.7; }
  .meta a, a { color: #7cc4ff; }
  .stats { display: flex; flex-wrap: wrap; gap: 10px; margin: 18px 0 4px; }
  .stat { background: #141926; border: 1px solid #232b3d; border-radius: 10px;
          padding: 10px 14px; min-width: 104px; }
  .stat b { display: block; font-size: 21px; }
  .stat span { color: #9aa4b2; font-size: 12px; }
  .card { background: #11151f; border: 1px solid #232b3d; border-radius: 12px;
          padding: 16px 18px; margin: 0 0 14px; }
  .card h3 { margin: 0 0 8px; font-size: 16px; line-height: 1.45; }
  .badge { display: inline-block; font-size: 11px; font-weight: 700;
           letter-spacing: .04em; padding: 2px 8px; border-radius: 999px;
           vertical-align: 2px; margin-left: 8px; }
  .b-live { background: #123524; color: #4ade80; }
  .b-ended { background: #3a2f10; color: #fbbf24; }
  .b-resolved { background: #1d2b4d; color: #93c5fd; }
  .kv { color: #9aa4b2; font-size: 13.5px; line-height: 1.75; }
  .kv b { color: #e6e9ee; font-weight: 600; }
  .proof { background: #0d1420; border: 1px solid #1f2c47; border-radius: 8px;
           padding: 10px 12px; margin-top: 10px; font-size: 13.5px;
           line-height: 1.7; }
  pre { white-space: pre-wrap; word-break: break-word; background: #0a0f18;
        border-radius: 8px; padding: 10px; font-size: 12px; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th, td { text-align: left; padding: 8px 8px; border-bottom: 1px solid #1c2333;
           vertical-align: top; line-height: 1.5; }
  th { color: #9aa4b2; font-weight: 600; }
  .oc-created { color: #4ade80; font-weight: 700; }
  .oc-skipped { color: #fbbf24; font-weight: 700; }
  .oc-error { color: #f87171; font-weight: 700; }
  footer { color: #9aa4b2; font-size: 13px; line-height: 1.7; margin-top: 40px; }
</style>
</head>
<body>
<main>
  <h1>Sentinel — public track record</h1>
  <p class="sub">An autonomous agent that turns a free public signal into a
  live prediction market on Solana devnet (pm-AMM), resolves it from the
  public source named in the market's criteria, and publishes the proof —
  win or lose. No real money: devnet + mock USDC only.</p>
  <p class="meta" id="meta"></p>
  <div class="stats" id="stats"></div>

  <h2>How to verify any of this</h2>
  <p class="kv">1. Open a market in the
  <a href="https://pm-amm-devnet.vercel.app" target="_blank" rel="noopener">pm-AMM reference app</a>
  or on Solscan (links on every card) — the question, end time and state are
  on-chain. 2. Re-fetch the outcome source named in the criteria at the
  resolution time and compare it with the fetched value in the proof.
  3. Follow the create / swap / resolve transaction links — every claim on
  this page traces to a transaction or a saved source response.</p>

  <h2>Markets</h2>
  <div id="markets"></div>

  <h2>Decision log</h2>
  <p class="kv">Every loop decision, including the skips — a skip is a
  decision, not silence. Newest first.</p>
  <table>
    <thead><tr><th>When (UTC)</th><th>Signal</th><th>Outcome</th><th>Reason</th></tr></thead>
    <tbody id="decisions"></tbody>
  </table>

  <footer>
    <p>Resolution on pm-AMM is manual and centralized by design — the
    market creator resolves. Sentinel makes that authority auditable
    instead of hiding it: criteria are fixed before the market opens, the
    outcome source is public, the raw source response is saved before the
    on-chain resolution call, and this page keeps the losses.</p>
    <p>The agent loop creates markets but never trades them (conflict of
    interest). The one-command demo (<span>npm run demo</span>) buys YES
    once to prove the trade path end to end — those buys are the ones
    shown on the demo markets above.</p>
    <p>Data regenerated from the agent's own public files
    (track-record.json, decisions.jsonl, snapshots.jsonl,
    resolution-proof-*.json) by <span>npm run dashboard</span>.</p>
  </footer>
</main>
<script>
"use strict";
var DATA = /*__DATA__*/null;
function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function link(href, text) {
  var a = el("a", null, text);
  a.href = href; a.target = "_blank"; a.rel = "noopener";
  return a;
}
function fmtUsd(n) {
  return "$" + Number(n).toLocaleString("en-US");
}
function fmtTime(iso) {
  return iso.replace("T", " ").replace(".000Z", " UTC").replace("Z", " UTC");
}
function badge(status) {
  if (status === "LIVE") return el("span", "badge b-live", "LIVE");
  if (status === "ENDED") return el("span", "badge b-ended", "ENDED — AWAITING RESOLUTION");
  return el("span", "badge b-resolved", "RESOLVED");
}
function kvLine(parent, label, valueNode) {
  var div = el("div");
  div.appendChild(el("b", null, label + ": "));
  if (typeof valueNode === "string") div.appendChild(document.createTextNode(valueNode));
  else div.appendChild(valueNode);
  parent.appendChild(div);
}
function renderMeta() {
  var m = document.getElementById("meta");
  m.appendChild(document.createTextNode("Network: Solana devnet · pm-AMM program "));
  m.appendChild(link("https://solscan.io/account/" + DATA.programId + "?cluster=devnet", DATA.programId.slice(0, 8) + "…"));
  m.appendChild(document.createTextNode(" · Collateral: devnet mock USDC · Page generated " + fmtTime(DATA.generatedAt)));
}
function renderStats() {
  var s = DATA.stats, box = document.getElementById("stats");
  var items = [
    [s.marketsCreated, "markets created"],
    [s.resolved, "resolved with proof"],
    [s.live, "live now"],
    [s.endedAwaitingResolution, "ended, awaiting resolution"],
    [s.decisionsLogged, "decisions logged"],
    [s.snapshotsLogged, "price snapshots"]
  ];
  items.forEach(function (it) {
    var d = el("div", "stat");
    d.appendChild(el("b", null, String(it[0])));
    d.appendChild(el("span", null, it[1]));
    box.appendChild(d);
  });
}
function renderMarkets() {
  var box = document.getElementById("markets");
  DATA.markets.forEach(function (mk) {
    var card = el("div", "card");
    var h = el("h3", null, mk.name);
    h.appendChild(badge(mk.displayStatus));
    card.appendChild(h);
    var kv = el("div", "kv");
    kvLine(kv, "Criteria", mk.asset + " " + mk.direction + " " + fmtUsd(mk.thresholdUsd) +
      " at " + fmtTime(mk.resolveAt) + " per " + mk.source + ". " + mk.tieRule);
    kvLine(kv, "Created", fmtTime(mk.createdAt) + " by " + mk.creator);
    if (mk.latestYesPricePct !== null && mk.latestYesPricePct !== undefined)
      kvLine(kv, "Latest YES price", mk.latestYesPricePct.toFixed(2) + "%");
    if (mk.yesBought)
      kvLine(kv, "Demo buy", mk.yesBought + " YES" +
        (mk.yesPricePctAfterBuy !== null ? " (price after buy " + mk.yesPricePctAfterBuy.toFixed(2) + "%)" : ""));
    var links = el("div");
    links.appendChild(link(mk.marketAppUrl, "Trade / view in pm-AMM app"));
    links.appendChild(document.createTextNode(" · "));
    links.appendChild(link(mk.explorerAccount, "Market on Solscan"));
    links.appendChild(document.createTextNode(" · "));
    links.appendChild(link(mk.createTxUrl, "Create tx"));
    if (mk.swapTxUrl) {
      links.appendChild(document.createTextNode(" · "));
      links.appendChild(link(mk.swapTxUrl, "Swap tx"));
    }
    kv.appendChild(links);
    if (mk.snapshots && mk.snapshots.length) {
      var snap = mk.snapshots.map(function (s) {
        return fmtTime(s.at) + " → " + s.yesPricePct.toFixed(2) + "%";
      }).join(" · ");
      kvLine(kv, "Price snapshots", snap);
    }
    card.appendChild(kv);
    if (mk.displayStatus === "ENDED" && mk.resolutionNote)
      kvLine(card, "Status note", mk.resolutionNote);
    if (mk.resolution) {
      var r = mk.resolution, proof = el("div", "proof");
      proof.appendChild(el("b", null, "Resolution proof"));
      var pl = el("div");
      if (r.parsed) {
        pl.appendChild(document.createTextNode(
          "Outcome: " + (r.outcome ? r.outcome.toUpperCase() : "?") +
          " · Source value at resolution: " + (r.fetchedValue !== null ? fmtUsd(r.fetchedValue) : "?") +
          (r.fetchedAt ? " fetched " + fmtTime(r.fetchedAt) : "") +
          (r.netUsdc !== null ? " · Net for the agent: " + r.netUsdc.toFixed(4) + " mUSDC" : "")));
        proof.appendChild(pl);
        var txs = el("div");
        if (r.resolveTxUrl) { txs.appendChild(link(r.resolveTxUrl, "Resolve tx")); }
        (r.settleTxs || []).forEach(function (t) {
          txs.appendChild(document.createTextNode(" · "));
          txs.appendChild(link(t.url, t.label + " tx"));
        });
        proof.appendChild(txs);
      } else {
        pl.textContent = r.raw || "";
        proof.appendChild(pl);
      }
      if (r.proofRawResponse) {
        proof.appendChild(el("div", null, "Raw source response saved before the on-chain call:"));
        proof.appendChild(el("pre", null, JSON.stringify(r.proofRawResponse, null, 2)));
      }
      if (r.proofFile)
        proof.appendChild(el("div", null, "Proof bundle: data/" + r.proofFile));
      card.appendChild(proof);
    }
    box.appendChild(card);
  });
}
function renderDecisions() {
  var tb = document.getElementById("decisions");
  DATA.decisions.forEach(function (d) {
    var tr = el("tr");
    tr.appendChild(el("td", null, fmtTime(d.at)));
    tr.appendChild(el("td", null, d.summary));
    var oc = el("td", "oc-" + d.outcome, d.outcome.toUpperCase());
    tr.appendChild(oc);
    tr.appendChild(el("td", null, d.reason));
    tb.appendChild(tr);
  });
}
renderMeta(); renderStats(); renderMarkets(); renderDecisions();
</script>
</body>
</html>
`;

/** Render the standalone dashboard page with the data embedded. */
export function renderDashboardHtml(data: DashboardData): string {
  // Escape `<` so a stray "</script>" inside data can never break the page.
  const json = JSON.stringify(data, null, 2).replace(/</g, "\\u003c");
  return HTML_TEMPLATE.replace("/*__DATA__*/null", () => json);
}

/** Write dashboard/index.html + dashboard/data.json; returns the paths. */
export function generateDashboard(
  dataDir: string,
  outDir: string,
  now: Date = new Date(),
): { data: DashboardData; htmlPath: string; dataPath: string } {
  const data = buildDashboardData(dataDir, now);
  fs.mkdirSync(outDir, { recursive: true });
  const dataPath = path.join(outDir, "data.json");
  const htmlPath = path.join(outDir, "index.html");
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
  fs.writeFileSync(htmlPath, renderDashboardHtml(data));
  return { data, htmlPath, dataPath };
}

if (require.main === module) {
  const dataDir = path.join(process.cwd(), "data");
  const outDir = path.join(process.cwd(), "dashboard");
  const { data, htmlPath, dataPath } = generateDashboard(dataDir, outDir);
  console.log("Sentinel dashboard generated:");
  console.log(`  ${htmlPath}`);
  console.log(`  ${dataPath}`);
  console.log(
    `  markets: ${data.stats.marketsCreated} ` +
      `(${data.stats.resolved} resolved, ${data.stats.live} live, ` +
      `${data.stats.endedAwaitingResolution} ended awaiting resolution)`,
  );
  console.log(
    `  decisions: ${data.stats.decisionsLogged}, snapshots: ${data.stats.snapshotsLogged}`,
  );
  console.log(
    "  Host the dashboard/ folder as-is (e.g. GitHub Pages) or open index.html from disk.",
  );
}
