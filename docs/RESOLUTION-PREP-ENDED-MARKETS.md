# Resolution prep — 3 ended markets (PREP ONLY, Nov 25, 2026)

Prepared Nov 25, 2026. Nothing has been resolved on-chain. Do NOT resolve
from this file alone — see the blocker at the end.

## The 3 markets

| # | Question | Market PDA / id | Resolution time (UTC) | Threshold |
|---|---|---|---|---|
| 1 | BTC above $100k at 2026-11-20 12:00 UTC? (CoinGecko) | 8hxkCjUgumeZr9dvmeL2xR2x8gzRtMqVDLFf6QBie2m5 / 102498313784629 | 2026-11-20 11:59:59Z (on-chain endTs) | $100,000 |
| 2 | BTC above $100k at 2026-11-20 12:00 UTC? (CoinGecko) | 4i36zWqRgjCt7mfT3vRinKAYbAtgopmePoE6MwjseCBy / 4556349035492 | 2026-11-20 ~12:00 UTC | $100,000 |
| 3 | BTC above $70k at 2026-11-15 12:00 UTC? (CoinGecko) | 4QW2qaFBfGpH345gjeQTzmRzojgCXTr4MagjV8ScShLW / 154474886100287 | 2026-11-15 12:00:01Z (on-chain endTs) | $70,000 |

Named source for all three (per track-record.json): "CoinGecko BTC/USD",
sourceUrl `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd`.
Tie (exactly equal) resolves NO. Resolution rule (src/resolution.ts):
fetched value strictly above threshold => YES, else NO; never resolve
from a guess — a non-finite fetched value throws.

## Price evidence gathered Nov 25 (conflicting — do not resolve yet)

1. **CoinGecko /history (daily snapshot, 00:00 UTC) — fetched Nov 25, HTTP 200:**
   - Nov 15, 2026: BTC $64,120.24
   - Nov 20, 2026: BTC $61,921.36
   - On these numbers alone, all three resolve NO ($64,120 < $70,000;
     $61,921 < $100,000). But this is a 00:00 snapshot, not the 12:00
     resolution-time price, so it is supporting evidence only.

2. **CoinGecko /market_chart/range (hourly, the right endpoint) — HTTP 401
   Unauthorized, Nov 25.** The free range endpoint now requires a key.
   No hourly CoinGecko price at 12:00 UTC on either date could be
   obtained this way.

3. **Yahoo Finance chart API (BTC-USD, 1h candles) — fetched Nov 25:**
   - Nov 15, 12:00 UTC candle close: $95,719.86
   - Nov 20, 12:00 UTC candle close: $91,776.11
   - On these numbers, market #3 would resolve YES ($95,720 > $70,000)
     and markets #1/#2 NO ($91,776 < $100,000). This DIRECTLY
     CONFLICTS with the CoinGecko daily snapshot for Nov 15, and with
     the in-world record (Nov 13: BTC $68,790, falling -3.57% in 24h,
     per the M2 live tick). The Yahoo series is not trusted as the
     resolution source — it may be returning a different year/series —
     and it is NOT the named source in the market criteria anyway.

## Blocker

The M3 proof method fetches the named CoinGecko source AT resolution
time and saves the raw response BEFORE the on-chain call. That window
has passed for all three markets (Nov 15 and Nov 20). A late resolution
needs a historical price the criteria never defined, and the two
sources checked today disagree on market #3 (YES vs NO). Resolving
from either one without settling this would break the "auditable,
not trustless" claim the submission makes.

## What is needed before any on-chain resolve

1. User decision: which historical source counts for a late resolution?
   Options: (a) CoinGecko /history daily snapshot (says NO for all
   three, but it is 00:00 not 12:00); (b) CoinGecko range/hourly with
   a demo API key (needs a key — free tier, no card — and the key
   must be the user's); (c) leave the three markets unresolved and
   submit with the dashboard's honest "ended — awaiting resolution"
   label, as the submission pack already does.
2. If (a) or (b) is chosen: fetch that source, save the raw response
   as `data/resolution-proof-<market-id>.json` BEFORE any resolve
   call, exactly as M3 did, then resolve with the proof-first script.
3. No on-chain resolve, no repo push, and no submission from this file
   without the user's explicit go-ahead naming the market(s).
