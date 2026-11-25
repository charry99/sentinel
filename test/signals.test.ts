import test from "node:test";
import assert from "node:assert/strict";
import {
  detectAssetFromTitle,
  parseCoinGeckoResponse,
  parseRssItems,
} from "../src/signals";

test("parseCoinGeckoResponse: live-shaped payload parses prices + 24h change", () => {
  const data = {
    bitcoin: { usd: 68851, usd_24h_change: -3.372642426322821 },
    ethereum: { usd: 1943.81, usd_24h_change: -2.6024132615413693 },
    solana: { usd: 80.37, usd_24h_change: -0.5869577301222441 },
  };
  const signals = parseCoinGeckoResponse(
    data,
    ["BTC", "ETH", "SOL"],
    "2026-11-13T15:07:00.000Z",
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true",
  );
  assert.equal(signals.length, 3);
  assert.equal(signals[0].asset, "BTC");
  assert.equal(signals[0].metric, 68851);
  assert.ok(Math.abs((signals[0].change24hPct as number) - -3.3726) < 0.001);
  assert.equal(signals[1].metric, 1943.81);
  assert.equal(signals[2].metric, 80.37);
  assert.match(signals[0].summary, /BTC \$68,851 \(-3\.37% in 24h\)/);
});

test("parseCoinGeckoResponse: missing price throws (never invent a price)", () => {
  assert.throws(
    () =>
      parseCoinGeckoResponse(
        { bitcoin: {} },
        ["BTC"],
        "2026-11-13T15:07:00.000Z",
        "https://example.com",
      ),
    /no USD price for BTC/,
  );
});

test("parseCoinGeckoResponse: missing 24h change is tolerated", () => {
  const signals = parseCoinGeckoResponse(
    { solana: { usd: 80.37 } },
    ["SOL"],
    "2026-11-13T15:07:00.000Z",
    "https://example.com",
  );
  assert.equal(signals[0].metric, 80.37);
  assert.equal(signals[0].change24hPct, undefined);
});

test("detectAssetFromTitle matches BTC / ETH / SOL keywords", () => {
  assert.equal(detectAssetFromTitle("Bitcoin slides as traders de-risk"), "BTC");
  assert.equal(detectAssetFromTitle("ETH whales move $200M to exchanges"), "ETH");
  assert.equal(detectAssetFromTitle("Solana network upgrade goes live"), "SOL");
  assert.equal(detectAssetFromTitle("Ethereum ETF inflows hit record"), "ETH");
  assert.equal(detectAssetFromTitle("Crypto market weekly roundup"), null);
  assert.equal(detectAssetFromTitle("Solana-based memecoin rallies"), "SOL");
});

test("parseRssItems extracts titles + links from RSS XML", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[Bitcoin slides as traders de-risk]]></title><link>https://example.com/a</link></item>
    <item><title>Solana upgrade goes live</title><link>https://example.com/b</link></item>
  </channel></rss>`;
  const items = parseRssItems(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Bitcoin slides as traders de-risk");
  assert.equal(items[0].link, "https://example.com/a");
  assert.equal(items[1].title, "Solana upgrade goes live");
});

test("parseRssItems returns [] for empty/invalid XML", () => {
  assert.deepEqual(parseRssItems(""), []);
  assert.deepEqual(parseRssItems("<rss></rss>"), []);
});
