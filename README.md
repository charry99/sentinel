# Sentinel — autonomous prediction-market agent on Solana devnet

**Hackathon:** [Solana Perps & Prediction Markets](https://hackathons.solana.com/hackathons/perps-and-prediction-markets) — deadline Dec 5, 2026.
**Status (M4/M5 prep, Nov 24, 2026):** the full loop is proven on devnet —
signal → market → verifiable resolution → settlement (M1–M3, Nov 13).
M4's public dashboard is built (`npm run dashboard`) and the demo-video
script is written (`docs/DEMO-SCRIPT.md`); recording the video, creating
the public repo, and submitting are the remaining owner steps, packed
and ready in `SUBMISSION.md` (M5). Nothing has been submitted.

## What it is

Sentinel turns a free public signal into a live, tradable, verifiably-resolved
prediction market on Solana — and publishes its own public track record, win
or lose.

- **Signal** (M2, done): CoinGecko free public API, no key (price + 24h
  change for BTC/ETH/SOL). News RSS (Cointelegraph, CoinDesk fallback) is
  live as a *context-only* adapter — headlines are logged, never trigger
  a market, never a resolution source. X sentiment is a pluggable future
  adapter, NOT v1 (X API is paid; $0 budget).
- **Market** (M1, done): binary markets on Solana devnet via
  [pm-AMM](https://predict-pm-amm.dev) (`@pm-amm/sdk` v0.2.0), program
  `GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y`. Collateral is devnet
  mock USDC (mUSDC) from the free faucet. Swap fee 2% on the USDC leg
  (50% protocol / 50% market creator). Settlement: 1 winning token = 1 USDC.
- **Resolution** (M3): pm-AMM resolution is manual and centralized by design —
  the market creator resolves after `endTs` via
  `send.resolveMarket(market, "yes" | "no")`. There is no oracle. Sentinel
  makes that authority auditable: criteria are published *before* the market
  opens, the outcome source is a public API anyone can re-fetch, the raw
  source response is saved before the on-chain call, and the track record
  keeps losses.
- **No real money.** Devnet only, mock USDC only, $0 budget. The agent never
  holds real funds, never touches mainnet, and does not trade its own markets
  in v1 (conflict of interest — see PLAN.md).

## Judge reproduction — one command

```bash
git clone https://github.com/charry99/sentinel && cd sentinel
npm install
npm run demo   # creates one devnet market, buys YES, prints its links
```

`npm run demo` needs a funded devnet keypair. It handles that itself:

1. It loads a keypair from `SENTINEL_KEYPAIR_PATH`, `./devnet-wallet.json`,
   or `~/.config/sentinel/devnet-wallet.json` — or generates a **fresh
   devnet-only** keypair at `./devnet-wallet.json` if none exists.
   Keypair files are gitignored; never commit one, never paste a mainnet key.
2. It claims the pm-AMM faucet (1,000 mUSDC + 0.2 devnet SOL, 1 claim per
   wallet per hour) if the wallet holds < 50 mUSDC, and falls back to a
   public devnet SOL airdrop if SOL is short.
3. It creates the market, buys YES with 5 mUSDC, verifies the trade on-chain,
   and prints the market URL + explorer links. The record is saved to
   `data/demo-market.json` and appended to `data/track-record.json`.

If the faucet is rate-limited (429, 1 claim/wallet/hour), wait out the hour
and re-run — the demo does not fake success.

## Layout

| Path | What it is |
|---|---|
| `src/constants.ts` | Devnet constants (program ID, mUSDC mint, faucet, explorer links) |
| `src/marketCriteria.ts` | Market-criteria builder + validation checklist (pure, tested) |
| `src/resolution.ts` | Deterministic outcome logic + proof bundle (pure, tested; tie = NO) |
| `src/signals.ts` | Signal adapters: CoinGecko (live) + news RSS (live, context-only) |
| `src/filter.ts` | Market-worthiness filter + threshold/resolve-time proposal + duplicate guard (pure, tested) |
| `src/trackRecord.ts` | Track-record store: markets, decision log, price snapshots (JSON/JSONL) |
| `src/pmAmm.ts` | pm-AMM client wrapper: keypair, faucet, balances, 429-aware retries |
| `src/pmAmmHelpers.ts` | Exact swap quotes (verbatim from the pm-AMM builder kit — never hand-roll quotes) |
| `src/agent.ts` | Agent loop (M2): poll → filter → validate → create → snapshot → log |
| `src/demo.ts` | `npm run demo`: create market → buy YES → verify → print links |
| `src/dashboard.ts` | Dashboard generator (M4): data files → `dashboard/index.html` + `data.json` (pure, tested; never touches the chain) |
| `test/` | Unit tests (criteria + resolution + filter + signals + track record + dashboard) + gated devnet integration test |
| `data/` | `track-record.json` (markets), `decisions.jsonl` (every loop decision + reason), `snapshots.jsonl` (live-market prices) |
| `dashboard/` | Generated public track-record page (M4) — regenerate with `npm run dashboard`; host as-is (e.g. GitHub Pages) |
| `docs/DEMO-SCRIPT.md` | Demo-video shot list + recording checklist (M4, ≤3 min) |
| `SUBMISSION.md` | Submission pack (M5): drafted form fields + pre-submit checklist — **draft only, nothing submitted** |

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | Compile TypeScript to CommonJS (`dist/`) |
| `npm run demo` | Build + run the demo path (creates one devnet market) |
| `npm run dashboard` | Build + regenerate the public dashboard into `dashboard/` from `data/` |
| `npm test` | Build + unit tests (integration test skipped unless enabled) |
| `npm run test:integration` | Build + devnet integration test (`SENTINEL_INTEGRATION=1`) |
| `npm run agent` | Agent loop: polls every 15 min, creates markets autonomously |
| `npm run agent:once` | One agent tick, then exit (same loop, single pass) |
| `node dist/src/agent.js --once --dry-run` | One tick with no chain writes — logs what *would* happen |

## Why CommonJS, not ESM

`@anchor-lang/core` is CommonJS, so raw Node ESM fails on `BN`. The project
is TypeScript compiled with `module: commonjs`, and all runtime code uses
`require()` under the hood. See RESEARCH.md §8.

## Gotchas baked in

- `send.swap` / `send.redeemPair` take **raw 6-dp units**; every other
  `send.*` takes human units.
- Quotes come from `quoteSwap`/`minOutput` (helpers), never hand-rolled —
  stored reserves go stale and swaps fail with `SlippageExceeded (6007)`.
- Public devnet RPC 429s: reads retry with ≥15s gaps; polling is ≥15s.
- **Websocket confirmations are bypassed by design:** `createConnection()`
  patches `confirmTransaction` to poll `getSignatureStatus` over HTTPS.
  The VM's egress proxy breaks wss to `api.devnet.solana.com` (TLS EPROTO),
  which made every `confirmTransaction` hang 30s and throw even after the
  tx landed — including the SDK's `send.*` path (Anchor `sendAndConfirm`).
  HTTP polling works everywhere, so the patch is harmless on normal
  networks and required on restricted ones.

## M1 proof (Nov 13, 2026)

Demo market #1 (created by `npm run demo`, verified on-chain):
- Market: `8hxkCjUgumeZr9dvmeL2xR2x8gzRtMqVDLFf6QBie2m5`
  — https://pm-amm-devnet.vercel.app/market/102498313784629
- Create tx: `pjUhCT9u1jQw5D7MWZtnw4rzeVnX1E4abH5e1PpXe3zh8MMBSTmWnzWzM16VWDNr2L3Qt3TSWY8wVRHNve786qN`
- Swap tx (bought 9.512127 YES for 5 mUSDC, price 50% → 53.02%):
  `4R7rYHBjLgFqNByGW6qjc543iUyMp4fRF9GzJMmHZpU5aWJp9GKygPDAWuJWCgMPoSXGfDc835sshLHGMdmXqEdf`
- Faucet tx (1,000 mUSDC + 0.2 SOL to fresh agent wallet
  `B6mbz82NKSk6NEr1AFmjrGs46pS1SeTCx3JNDHxQb7b5`):
  `4hKvQ1AQQu4cV2opWcK97NJbYh3AsZUjnVT59vEiyYrQ9L9FfM8rmj91UDZYQAJ6HHyHiZ4LLK86VxiU6hRWZHZz`
- A second identical market was created by the integration test
  (`npm run test:integration`): `4i36zWqRgjCt7mfT3vRinKAYbAtgopmePoE6MwjseCBy`
  (id 4556349035492). Full records: `data/demo-market.json`,
  `data/track-record.json`.
- Agent wallet after both markets: 0.12327 SOL · 890.1 mUSDC (devnet only).

## M2 proof (Nov 13, 2026)

The loop ran end to end on devnet with no human in the loop
(`npm run agent:once`). Live signals at the tick: BTC $68,790 (-3.57%
in 24h), ETH $1,942.16 (-2.88%), SOL $80.30 (-0.39%), plus 5
Cointelegraph headlines (context only).

- **Created:** "BTC above $70k at 2026-11-15 12:00 UTC? (CoinGecko)"
  — trigger: BTC -3.57% (≥3% move) + 1.73% from the $70,000 round
  threshold. Market: `4QW2qaFBfGpH345gjeQTzmRzojgCXTr4MagjV8ScShLW`
  (id 154474886100287) — https://pm-amm-devnet.vercel.app/market/154474886100287
  — create tx `2dH7nNkkyXitpEpDyWatcYS1uT1mmLQPzv5qiLVKWC5KJdziekVJxTcERcfWPwHXFnYoExCkKLnQymUFtMXbrEPt`
  (slot 521864933, err null, finalized). Verified on-chain: name decodes
  exactly, endTs 2026-11-15T12:00:01Z, winningSide 0, unresolved,
  authority = agent wallet. YES price 50.00% — the loop creates markets
  but does NOT trade its own (v1 decision).
- **Skipped with reasons (all logged to `data/decisions.jsonl`):** ETH
  (-2.88% < 3% and 2.89% from $2,000); SOL (worthy via proximity to
  $80, deferred by the 1-market-per-tick budget cap); 5 RSS headlines
  (context-only, no numeric price).
- **Snapshots:** 3 price snapshots logged to `data/snapshots.jsonl`
  (all 3 live markets: 53.02% / 53.02% / 50.00%).
- Agent wallet after: 0.0879 SOL · 840.1 mUSDC (devnet only; one market
  cost ~0.035 SOL gas + 50 mUSDC deposit).

Filter rules (`src/filter.ts`): worthy when |24h change| ≥ 3% OR price
within 2% of a round threshold (BTC $5,000 / ETH $250 / SOL $10 steps);
duplicate guard blocks a live market for the same asset + window within
24h; at most 1 new market per tick. Resolution time is the next 12:00 UTC
at least 24h out (24–48h).

## M3 proof (Nov 13, 2026)

One short-duration market taken through the full settlement cycle with
no human in the loop (`src/m3.ts`). Threshold near the money ($68,000 vs
BTC $68,837 at creation), so the outcome was genuinely uncertain:

- Market: `BG7zUsKyt11EoKyKogeh9Tntwo8TXD7UYsa2R9Swu1ew`
  (id 133405243500474) — https://pm-amm-devnet.vercel.app/market/133405243500474
- Create tx: `GefUfvQwHHPJWF5MoSCosrvAW9qGSSgkfKXNgbtnB3MM6fWPg1zCha12U7r7yHrKuRCT2pUm5b4GzNjdUzz3JQs`
  (deposit 50 mUSDC); swap tx bought ~9.511 YES for 5 mUSDC
  (`3h51b4AWBKmMTCV1TczBiTcgoa7R2LG6md4fFp9BdxCWT1yHMfkgVjhQdipd6zvQyACa3tTAByUzjyqKwkKZgKeD`).
- At resolution the source was re-fetched: **BTC $68,389** vs the $68,000
  threshold → **YES**. The proof bundle
  (`data/resolution-proof-133405243500474.json`, with the raw CoinGecko
  response) was written **before** the on-chain resolve call.
- Resolve tx: `EaV34VDffk8XAqTJBooTf74rmAXqP6GEsD25vxKTGYwVZUfCga6piRhoZHwLth7wW5DasxJmYFkEmh2Y9tRgpVY`
  — verified on-chain afterwards (`resolved=true, winningSide=1`).
- Settle: accrue + LP residuals + winnings claimed (3 further txs, in
  `data/m3-proof.json`). **P/L, honestly: spent 55 test mUSDC, recovered
  54.95, net −0.05** — essentially break-even; the cycle proof is the
  deliverable, not the profit.

## M4 — dashboard + demo video (Nov 24, 2026)

- **Dashboard (built):** `npm run dashboard` regenerates
  `dashboard/index.html` + `dashboard/data.json` from the agent's own
  public data files — every market with its criteria and tx links, the
  resolution proof (fetched value, raw source response, settle txs),
  the full decision log including skips, and price snapshots. Static,
  no server, no build framework; host the `dashboard/` folder as-is.
  Honesty rule baked in: a market past its resolve time with no recorded
  resolution shows as **ENDED — AWAITING RESOLUTION**, never quietly
  relabelled. As of this build that is the true state of the three
  earliest markets (ended Nov 15 / Nov 20; the agent has not been run to
  resolve them since).
- **Demo video (script ready, recording is an owner step):**
  `docs/DEMO-SCRIPT.md` — a shot-by-shot 2:30–2:50 script
  (signal → market → trade → resolve → track record) plus a recording
  checklist. The hackathon caps the pitch video at 3 minutes.

## What remains (M5 — owner steps, packed in `SUBMISSION.md`)

- Create the public GitHub repo and push this code (browser step,
  needs the owner's word — deliberately not done by the agent).
- Record + upload the demo video from `docs/DEMO-SCRIPT.md`.
- Optionally resolve the 3 ended markets with proof bundles first, and
  create 1–2 fresh live markets for judges to trade.
- Submit by **Dec 4** (deadline Dec 5). Drafted form fields, links
  table and the full pre-submit checklist: `SUBMISSION.md`.
  **Nothing has been submitted.**
