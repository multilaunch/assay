# 002 — system audit: bugs, flaws, design

status: **in progress** · opened 2026-09-16

## Goal

Find real defects across the system and fix them. A finding counts only when it is
reproduced or read unambiguously in the code; suspicions that do not reproduce are recorded
as such and not "fixed".

## Order, by what it costs to be wrong

1. The trading path — it moves the reader's money.
2. Anything that can silently show wrong numbers — the index, the chart, the score.
3. Server: routes, guards, limits, leaks.
4. The page: state, timers, memory over a long session.
5. Design.

## Constraints

- AGENTS.md verification table applies to every fix.
- No new dependency.
- Task 001's limiter stays; do not loosen it without numbers.

## Findings — confirmed and fixed

Each was reproduced or read unambiguously before being changed, and each fix re-checked.

| # | where | defect | how confirmed | fixed |
|---|---|---|---|---|
| 1 | index reader | board that started before the index file existed **never used the index** until restart | reproduced: file created, board still read `null` | re-stats the path every 5 s |
| 2 | index reader | after `index reset` the board **kept reading the deleted file**, frozen, silently | reproduced: new file cursor 6000, board read 999 | keeps the handle only while the path names the same inode |
| 3 | trade path | transactions carried **no `chainId`** — a network switch while the wallet popup was open signed our calldata on the wrong chain, with real ETH as `value` | read: `tx` was `{to,data,value,from}` | `chainId: 0x1237` on buy, sell and approve |
| 4 | trade path | approval receipt compared against `"0x1"` only; a wallet answering `1` or `true` reported a **successful approval as failed** | read; the send path already handled all three | one `receiptState()` for both |
| 5 | trade path | an approval still pending at 90 s was reported as **failed**, inviting a second signature | read | `"pending"` is its own outcome and message |
| 6 | server | an oversized POST body **never got a response** and its handler was held forever — reachable anonymously on `/admin/login` | reproduced: `ECONNRESET`, no status | every exit settles once; `413` |
| 7 | server | **no cap on live streams** — one address opened 300 of 300 | reproduced | 8 per caller, 2 000 total, released on close |

Tests: 162 → 165. The three new reader tests were run against the original code first and
failed 3/3, then passed 3/3 with the fix.

## Checked and not a defect

- The long-lived read handle **does** see later commits in WAL mode (200 → 999). Suspected,
  tested, fine.
- The feed is capped at 400 rows, and removing a row unobserves its icon — no observer leak.
- `CANDLES`, `HOLDERS`, `BUY` grow only with rows the reader opened themselves. Pruning them
  on row removal would break the token held in the trade dock. Left as is.
- `/state` stays at 1 ms under load: served from memory.

## A mistake of mine, recorded

Adding the null guard to the body reader, a replacement loop re-matched its own output and
inserted the guard 43 times. Caught by typecheck, collapsed, and then asserted: 3 call sites,
3 guards. The rule in AGENTS.md about asserting scripted edits exists for exactly this.

## Next step

Design pass over the live page with the gates in DESIGN.md.
