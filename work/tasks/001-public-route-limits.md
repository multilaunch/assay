# 001 — per-caller limits on the RPC-amplifying routes

status: **built, deploying** · opened 2026-09-15

## Goal

A single caller must not be able to exhaust the board's RPC budget and make the page
unusable for everyone else, without that costing the caller anything.

Done when: a caller walking distinct token addresses is slowed to a rate the board can
serve; a normal reader never meets the limit; and both of those are measured rather than
asserted.

## Why this and not something else

Confirmed by reading `src/board/server.ts`: `LoginThrottle` guards `/admin/login` and
nothing else. `/candles`, `/holders`, `/logo`, `/quote` and `/balance` are public, cached
per token, and uncapped per caller.

The caches bound repeat cost for the *same* token — 20s for candles, 45s for holders,
30 min for logos. They do nothing against distinct tokens, and a cache miss on `/holders`
is roughly twenty `getLogs`. The RPC gate then serialises them: 3 in flight, 400ms spacing
on log calls. So a few hundred addresses is enough to make every other reader's chart hang.

Assumption, not yet measured: that the board becomes unresponsive rather than merely slow.
The first step below is to find out.

## Constraints

- The board must stay public to read. No account, no token, no captcha.
- Must not break the SSE stream on `/events`, which is long-lived by design.
- Must not depend on a proxy being present. It runs behind Caddy in production and on bare
  loopback in development, and `clientKey()` already prefers the forwarded header.
- No new dependency. Two in the whole project (`commander`, `viem`) and that is a decision.
- Must not lock out an operator on the same address as ordinary readers.

## Done so far

- Read the routes and confirmed the gap. `LoginThrottle` guards `/admin/login` only.
- Measured the baseline. Numbers in [`work/logs/001-baseline.md`](../logs/001-baseline.md).

## Checks run

Load measurement against a local board, index warm:

| | |
|---|---|
| reader's `/candles`, board idle | 1 179 ms |
| reader's `/candles`, 40 distinct `/holders` in flight | **61 573 ms** |
| flood drain time | 133 s; slowest single response 134 s; every code 200 |

**40 requests is enough to make the board 52× slower for everyone, for two minutes.**
Cheaper than assumed. The earlier guess that the process might fall over was wrong — it
stays up and stays correct, it just queues.

## Unknown — resolved

- ~~Whether the failure is refusal, queueing, or falling over~~ → queueing, measured above.
- ~~Whether random addresses are enough~~ → no. They 404 on one `readContract` before any
  log range is touched. Real addresses are required, and 86k of them are in our own index.

## Still unknown

- A normal reader's real request rate, which sets where the limit goes without hurting
  anyone. Estimated from the code — a reader with five rows open re-asks `/candles` and
  `/holders` every 20 s, so under one request per second sustained — but **not measured**.
- Whether Caddy applies anything already. `deploy/Caddyfile` has no rate-limit directive;
  read, not tested.

## Built

`src/board/limit.ts` — `WorkLimit`, three bounds, 10 unit tests in `test/limit.test.ts`:

| bound | default | why that number |
|---|---|---|
| per caller, in flight | 4 | a reader with five rows open never has more than a handful |
| per caller, burst / refill | 20 / 0.5 per s | five rows re-ask every 20 s: under 1 per s sustained |
| **whole board, in flight** | 12 | the RPC gate runs 3 at a time with 400 ms between log calls, so ~4 deep |

Metered: `/candles`, `/holders`, `/logo`, `/quote`, `/balance`. Not metered: `/`, `/state`,
`/events`, `/stats`, `/og.png`, `/vendor/*` — they cost nothing and `/events` is long-lived.

**A warm cache is free.** `cachedCandles` / `cachedHolders` / `cachedLogo` answer before the
limiter is consulted, so what is rationed is reaching the chain, not asking a question.

## Checks run — after

Numbers in [`work/logs/001-baseline.md`](../logs/001-baseline.md).

| reader's chart | before | per-caller | + ceiling |
|---|---|---|---|
| 40 requests, one caller | 61 573 ms | 6 893 ms | — |
| 40 requests, forty callers | — | 71 872 ms | **7 883 ms** |

162 tests pass, typecheck and build clean.

## What this does not fix

- A distributed flood still costs readers something: 7.9 s instead of 0.5 s. The ceiling
  bounds the damage, it does not remove it. Removing it needs more RPC capacity, which is
  money, not code.
- Nothing here defends against a volumetric flood that never reaches the application.
  That is the case for a CDN in front — see the proposal in `DECISIONS.md`, still the
  user's call, and now answerable with numbers rather than by feel.

## Still unknown

- **Whether `X-Forwarded-For` actually arrives in production.** Caddy sets it by default and
  the Caddyfile does not override it, but that is a documented default, not a measurement.
  The whole per-caller bound rests on it: without it every visitor is one caller. The board
  now logs a warning once if a non-loopback request arrives without it — **check the
  production log after deploying; absence of that line is the verification.**

## Next step

Deploy, then read `docker logs assay-board` for the forwarded-header warning. If it appears,
the per-caller bound is not working in production and the Caddyfile needs the header stated
explicitly.
