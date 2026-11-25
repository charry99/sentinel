# Submission pack — Sentinel (M5)

**Hackathon:** Solana Perps & Prediction Markets — $101,000 pool.
**Deadline:** Dec 5, 2026 (exact time still unconfirmed — submit by
**Dec 4** at the latest, per PLAN.md).
**Form facts (RESEARCH.md, verified Nov 13):** the submission is light —
all fields optional, devnet projects are OK, pitch video max 3 minutes.

> **Status: DRAFT — nothing has been submitted.** Every outward step
> (creating the public repo, pushing, uploading the video, submitting
> the form) needs the user's explicit go-ahead. This pack exists so the
> Dec 3–4 window is copy-paste, not writing-from-scratch.

## Drafted form fields

**Project name:** Sentinel

**One-liner:** An autonomous agent that turns a free public signal into
a live, tradable, verifiably-resolved prediction market on Solana — and
publishes its own public track record, win or lose.

**What it does (short):**
Sentinel runs a loop on Solana devnet: it polls free public signals
(CoinGecko price + 24h change for BTC/ETH/SOL; news RSS as context only),
applies a published worthiness filter, and creates binary prediction
markets on pm-AMM with machine-checkable criteria — every question names
the asset, the threshold, the exact time, and the exact source. At
resolution time it re-fetches the named source, saves the raw response
as a proof bundle *before* the on-chain call, resolves the market, and
settles. A public dashboard shows every market, price snapshot,
decision (including the skips, with reasons), and settlement proof.

**Why it matters (longer, for any essay field):**
Prediction markets have a cold-start problem (markets are created by
hand, so most interesting questions never become markets) and a trust
problem (resolution is usually the resolver's word). pm-AMM removes the
market plumbing; Sentinel is the missing agent layer on top of it:
signal → market → resolution → public proof. pm-AMM is not a side
feature — market creation, pricing, liquidity and settlement are all
pm-AMM (program `GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y`,
`@pm-amm/sdk` v0.2.0); Sentinel writes no AMM math and no custom
program. Resolution on pm-AMM is centralized by design (the creator
resolves), so Sentinel makes that power auditable instead of pretending
it doesn't exist: criteria fixed before the market opens, a public
outcome source anyone can re-fetch, the raw response saved before the
call, and a track record that keeps the losses.

**Proof it works (all devnet, all verifiable):**
- 4 markets created on devnet, one of them by the autonomous loop with
  no human in the loop ("BTC above $70k at 2026-11-15 12:00 UTC",
  market `4QW2qaFBfGpH345gjeQTzmRzojgCXTr4MagjV8ScShLW`).
- 1 market resolved end to end with a published proof bundle and all
  settlement transactions ("BTC above $68k", resolved YES at $68,389;
  net −0.05 test mUSDC, essentially break-even — kept on the record).
- 50 unit tests pass; a judge can reproduce the demo in one command
  (`npm run demo`).
- Public dashboard: every market, price, decision and proof link.

**Honest weaknesses (state them; the jury rewards it):**
Devnet only, no real users or real-money volume yet, binary markets
only, resolution authority is the creator (auditable, not trustless),
signals are price-based (X sentiment is a documented future adapter,
not v1). Three early markets ended before the agent was run again to
resolve them; the dashboard labels them "ended — awaiting resolution"
rather than hiding them.

**Track / bounty fit:** Main track (a working product that *uses* a
prediction market rather than just building one) + the pm-AMM bounty
(Sentinel cannot exist without pm-AMM; the dependency is verifiable
from the program ID, SDK calls and on-chain transactions above).

## Links (fill in at submission time)

| Field | Value |
|---|---|
| Public repo | https://github.com/charry99/sentinel — **live, created + pushed Nov 25, 2026 (commit 8579423c, 41 files, branch main)** |
| Demo video (≤3 min) | *paste URL after upload (owner step)* |
| Dashboard | GitHub Pages URL after the repo exists (the `dashboard/` folder), or the repo path `dashboard/index.html` |
| Live judge market | pm-AMM reference-app URL of the market created for the judging window (see checklist) |
| Resolved-market proof | `data/m3-proof.json` + `data/resolution-proof-133405243500474.json` in the repo |

## Pre-submit checklist (Dec 3–4)

Owner-only steps are marked 👤 — they need the user's hands or explicit
word. Everything else is prepared in this repo.

- [x] Create the public GitHub repo `charry99/sentinel` and push `repo/`
      — DONE Nov 25, 2026: repo created empty in browser (signed in as
      charry99, SMS 2FA), then 41 files pushed via GitHub connector,
      commit 8579423c on main (plus provider initial commit 78083786).
- [ ] 👤 Record the demo video from `docs/DEMO-SCRIPT.md` (≤3 min),
      upload it, and paste the URL into the Links table above.
- [ ] Re-run the full suite on the pushed commit: `npm test`
      (expect 50 pass, 1 skipped) and `npm run dashboard` to refresh
      the dashboard's generated-at timestamp.
- [ ] Create 1–2 fresh live markets for judges to trade during the
      judging window (`npm run demo` and/or one `npm run agent:once`
      tick), then regenerate the dashboard so they appear as LIVE.
- [ ] Optional but strengthening: resolve the 3 ended markets
      (Nov 15 + Nov 20) with proof bundles, so the record shows them
      settled instead of awaiting resolution. On-chain agent action —
      👤 needs the user's go-ahead.
- [ ] 👤 Submit the form with the fields above **by Dec 4** (≥24h
      before the Dec 5 deadline).
- [ ] After submission: keep the judge markets' snapshots updating
      (agent ticks) and resolve them when they end, proof first.

## What is NOT in this pack

No traction claims beyond the devnet facts above, no user counts, no
revenue — none exist, and inventing them would sink the entry with a
technical jury. If the form asks for something this pack doesn't cover,
leave it blank (all fields are optional) rather than guessing.
