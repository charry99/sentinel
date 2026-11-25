# Demo video script — Sentinel (M4)

**Hard limit: 3 minutes** (hackathon pitch-video cap, RESEARCH.md).
Target 2:30–2:50. Screen recording + voiceover; if time runs short,
captions over the recording instead of voiceover (PLAN.md cut list #7 —
the video itself is never cut).

Record at 1080p, browser zoom ~125% on the dashboard and the pm-AMM app,
terminal font large enough to read on a phone. Keep every explorer/app
tab pre-opened so no shot waits on a page load.

## Shot list

| Time | Screen | Narration (say roughly this) |
|---|---|---|
| 0:00–0:15 | Dashboard (`dashboard/index.html`), stats strip visible | "This is Sentinel — an autonomous agent that turns a free public signal into a live prediction market on Solana, resolves it from a public source, and publishes its own track record, win or lose. Everything you are about to see is on devnet, and every claim links to a transaction." |
| 0:15–0:45 | Terminal: `node dist/src/agent.js --once --dry-run`, then scroll `data/decisions.jsonl` | "The loop polls CoinGecko for BTC, ETH and SOL. A signal is worthy when the 24-hour move is at least 3 percent, or the price sits near a round threshold. Every decision is logged with its reason — including the skips. A skip is a decision, not silence." |
| 0:45–1:20 | Terminal: `npm run demo`; then the market page it prints, in the pm-AMM reference app | "One command creates a real market. Read the question: asset, threshold, exact time, exact source. No vague questions, ever — the resolution criteria are fixed before the market opens, and anyone can trade it in the reference app." |
| 1:20–1:50 | Solscan swap tx from the demo output; back to the app page showing the moved YES price | "The demo buys YES with 5 mock USDC to prove the trade path, and the price moves — 50 to 53 percent on our first market. Quotes come from the pm-AMM SDK, never hand-rolled." |
| 1:50–2:35 | Dashboard, resolved market card (BTC above $68k), proof block expanded | "Resolution is where prediction markets ask you to trust someone. On pm-AMM the creator resolves — that power is centralized by design, so Sentinel makes it auditable instead of hiding it. The raw CoinGecko response was saved before the on-chain call. Here is the fetched value, the resolve transaction, and the settlement transactions. Net result: minus five cents of test USDC — and it stays on the record." |
| 2:35–2:55 | Dashboard decision log + stats; end on the track-record header | "Four markets created by an agent with no human in the loop, one resolved end to end with proof, every decision public. Devnet only, binary markets only — stated plainly. The code is public, the demo is one command, and the track record keeps the losses. That's Sentinel." |

## Recording checklist

- [ ] Regenerate the dashboard first: `npm run dashboard` (fresh
      `generatedAt`, current statuses).
- [ ] If a live judge market is running for the submission window, create
      it before recording (`npm run demo` or one agent tick) so the
      "live now" count is honest on camera.
- [ ] Pre-open tabs: dashboard, pm-AMM reference app market page, Solscan
      create + swap + resolve txs, `data/decisions.jsonl`.
- [ ] Terminal: run the dry-run tick once off-camera to confirm no
      errors; CoinGecko rate limits can bite on repeat runs.
- [ ] Record in one take per shot; total runtime ≤ 3:00 — re-check after
      editing, the cap is a submission rule, not a guideline.
- [ ] Captions on (auto-captions reviewed, or burned-in from this script).
- [ ] Upload (YouTube, public or unlisted per the submission form) and
      paste the URL into `SUBMISSION.md` §Links.
- [ ] After upload: watch it once at 1x on a phone-sized window — if the
      terminal text is unreadable, re-record the terminal shots zoomed.
