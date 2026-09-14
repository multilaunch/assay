# 001 — per-caller limits on the RPC-amplifying routes

status: **in progress** · opened 2026-09-15

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

- Read the routes and confirmed the gap. Nothing changed yet.

## Checks run

None yet.

## Unknown

- What a normal reader's actual request rate is — needs measuring before a limit can be
  chosen, or the limit will be picked out of the air.
- Whether the failure under load is refusal, queueing, or the process falling over.
- Whether Caddy already applies anything (believed not; `deploy/Caddyfile` has no
  rate-limit directive, unverified).

## Next step

Measure the baseline: drive `/holders` with distinct token addresses against a local board
and record where response time for an unrelated `/state` request starts to degrade. Write
the numbers to `work/logs/001-baseline.md`. Only then choose a limit.
