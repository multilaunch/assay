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

## Design findings — confirmed and fixed

| # | defect | measured before | after |
|---|---|---|---|
| 8 | addresses printed in full, breaking mid-hex; a launch with 31 exempt wallets pushed **the chart 1 420 px down**, two screens below the fold — a real answer to "where did the chart go" | row 1 651 px, address block 1 105 px | row **527 px**, block **71 px**, chart at **401 px** |
| 9 | the holders table printed full addresses in `nowrap` cells; with a row open it widened the feed to **478 px in a 375 px pane** — sideways scroll on every phone | pane 478 / 375 | **375 / 375**, verified with holders painted |
| 10 | a long social handle broke mid-word onto a second line inside its own border | chip wrapped | one line, ellipsis, full URL in title |
| 11 | on a 1024 px laptop the dock stacked above the feed and stretched to full width: buy and sell were **390 px slabs**, the swap took the top third | buy button 390 px | side column; buy **152 px**, feed drops to 7 columns |
| 12 | the new short-address links were **16 px** tall on a phone | 16 px | 44 px |

Short addresses link to the explorer with the full address in the title; lists longer than three
collapse behind a native `<details>` ("and 28 more") that opens without closing the row.

## Another mistake of mine, recorded

Twice in this pass a check reported "no overflow" and was wrong:

- On a phone the pane scrolls, not the document. Measuring `document.documentElement` said
  clean while the feed was 478 px in a 375 px pane. The check now walks **every** element that
  can scroll sideways.
- My first fix for that targeted the table headers. The headers were not the cause — an open
  row's holders table was, and the table spread its extra width across every column, which is
  why "score" measured 88 px. Found by shrinking the cell and listing what refused to fit.
- Then "fixed" was nearly reported before the holders had painted. They load in 7–10 s; the
  first re-check ran with zero holder rows on screen and proved nothing. Re-run after waiting
  for them explicitly.

## Checks run — design

| width | sideways scroll (every scroller) | columns | notes |
|---|---|---|---|
| 1440 | none | 10 | dock open, 7 type sizes |
| 1024 | none | 7 | dock beside the feed |
| 768 | none | 7 | stacked, dock body capped at 560 px |
| 375, three rows open, holders painted | none | 5 | table exactly 375 |

165 tests pass; slopcheck 0 critical.

## Next step

Deploy, then confirm on production at 375 px with a row open and its holders loaded.
