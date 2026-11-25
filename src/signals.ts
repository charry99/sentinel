/**
 * Signal adapters — pluggable sources. The Market Engine only ever sees
 * `Signal[]`; adding a new source means writing one adapter that returns
 * the same shape (PLAN.md §4).
 *
 * v1: CoinGecko free public API (no key). X sentiment is a documented
 * future adapter, NOT v1 (X API is paid; $0 budget).
 */
import { COINGECKO_IDS, type Asset } from "./marketCriteria";

export interface Signal {
  id: string;
  source: string;
  summary: string;
  asset: Asset;
  /** Current price in USD (CoinGecko) or other metric. */
  metric: number;
  /** 24h change in percent, when the source provides it. */
  change24hPct?: number;
  fetchedAt: string;
  /** URL or API endpoint, for audit. */
  rawRef: string;
}

export interface SignalAdapter {
  name: string;
  poll(): Promise<Signal[]>;
}

const COINGECKO_SIMPLE_PRICE =
  "https://api.coingecko.com/api/v3/simple/price";

/** Pure parse of a CoinGecko /simple/price response (unit-testable). */
export function parseCoinGeckoResponse(
  data: Record<string, { usd?: number; usd_24h_change?: number }>,
  assets: readonly Asset[],
  fetchedAt: string,
  url: string,
): Signal[] {
  return assets.map((asset) => {
    const row = data[COINGECKO_IDS[asset]] ?? {};
    const price = row.usd;
    if (!Number.isFinite(price)) {
      throw new Error(`CoinGecko returned no USD price for ${asset}`);
    }
    const change = row.usd_24h_change;
    return {
      id: `coingecko-${COINGECKO_IDS[asset]}-${fetchedAt}`,
      source: "CoinGecko",
      summary:
        `${asset} $${price!.toLocaleString("en-US")}` +
        (Number.isFinite(change)
          ? ` (${change!.toFixed(2)}% in 24h)`
          : ""),
      asset,
      metric: price!,
      change24hPct: change,
      fetchedAt,
      rawRef: url,
    };
  });
}

/**
 * CoinGecko adapter (free tier, no key). Fetches current USD prices +
 * 24h change for BTC/ETH/SOL in a single call. Keep call rate far under
 * the free-tier limit (~10–30 calls/min).
 */
export class CoinGeckoAdapter implements SignalAdapter {
  readonly name = "coingecko";
  private readonly assets: readonly Asset[];

  constructor(assets: readonly Asset[] = ["BTC", "ETH", "SOL"]) {
    this.assets = assets;
  }

  async poll(): Promise<Signal[]> {
    const ids = this.assets.map((a) => COINGECKO_IDS[a]).join(",");
    const url =
      `${COINGECKO_SIMPLE_PRICE}?ids=${ids}` +
      `&vs_currencies=usd&include_24hr_change=true`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      throw new Error(`CoinGecko ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as Record<
      string,
      { usd?: number; usd_24h_change?: number }
    >;
    return parseCoinGeckoResponse(data, this.assets, new Date().toISOString(), url);
  }
}

/** Guess the asset a headline is about, from keywords. Null = none. */
export function detectAssetFromTitle(title: string): Asset | null {
  const t = title.toLowerCase();
  if (/\b(bitcoin|btc)\b/.test(t)) return "BTC";
  if (/\b(ethereum|ether|eth)\b/.test(t)) return "ETH";
  if (/\b(solana|sol)\b/.test(t)) return "SOL";
  return null;
}

export interface RssItem {
  title: string;
  link: string;
}

/** Minimal RSS <item> parser — no dependency, titles + links only. */
export function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[1];
    const title = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/
      .exec(body)?.[1]
      ?.replace(/<!\[CDATA\[|\]\]>/g, "")
      .trim();
    const link = /<link>([\s\S]*?)<\/link>/.exec(body)?.[1]?.trim();
    if (title) items.push({ title, link: link ?? "" });
  }
  return items;
}

const RSS_FEEDS = [
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  {
    name: "CoinDesk",
    url: "https://www.coindesk.com/arc/outboundfeeds/rss/",
  },
];

/**
 * News RSS adapter — CONTEXT ONLY. Headlines feed the decision log and
 * (later) market-question wording; they never trigger a market and are
 * never a resolution source. Resolution sources are numeric APIs only.
 *
 * Fail-soft: a feed that errors or times out returns [] and the loop
 * continues on CoinGecko alone. RSS is first on the PLAN cut list.
 */
export class NewsRssAdapter implements SignalAdapter {
  readonly name = "news-rss";
  private readonly maxItems: number;

  constructor(maxItems = 5) {
    this.maxItems = maxItems;
  }

  async poll(): Promise<Signal[]> {
    for (const feed of RSS_FEEDS) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        let res: Response;
        try {
          res = await fetch(feed.url, {
            headers: { "user-agent": "Sentinel/0.1 (devnet hackathon demo)" },
            signal: ctrl.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) continue;
        const xml = await res.text();
        const fetchedAt = new Date().toISOString();
        // Only headlines actually about a supported asset become signals;
        // generic crypto headlines are dropped, not mislabelled as BTC.
        // Filter first, then take the top 5 asset-specific headlines.
        return parseRssItems(xml)
          .map((item, i) => {
            const asset = detectAssetFromTitle(item.title);
            if (!asset) return null;
            return {
              id: `rss-${feed.name.toLowerCase()}-${fetchedAt}-${i}`,
              source: `RSS: ${feed.name}`,
              summary: item.title,
              // No numeric metric: RSS headlines carry no price. The filter
              // treats metric NaN as "context-only, never worthy".
              asset,
              metric: Number.NaN,
              fetchedAt,
              rawRef: item.link || feed.url,
            };
          })
          .filter((s): s is Signal => s !== null)
          .slice(0, this.maxItems);
      } catch {
        // Try the next feed; a dead RSS feed must never kill the loop.
        continue;
      }
    }
    return [];
  }
}
