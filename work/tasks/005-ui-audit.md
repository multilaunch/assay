# 005 — UI audit with the updated ui-design skill

status: **done** · opened 2026-09-22 · closed 2026-09-23

## Ask (verbatim, 2026-09-22)

> Так а ну ка проведи аудит проекта и заюзай ui-skill там апдейт есть по скилу

## What changed in the skill

`assets/audit.js` (updated 2026-09-22) — a runtime geometry audit: who overflows sideways,
measure, recipe dominance, spacing rhythm, type sizes, objects by size, touch targets under
768px, computed contrast (canvas-converted, so oklch is read correctly), a focus-ring probe.
Slopcheck and the adversarial critique are unchanged.

## How it was measured

- The in-app browser refused `fetch("/state")` on production (`net::ERR_BLOCKED_BY_CLIENT`) while
  `curl` got a 200 and the event stream — a tool restriction, not a site fault. So the audit ran on a
  local board serving `src/board/index.html` (`BOARD_HTML=…`), behind a throwaway proxy that answered
  `/state` with production's real 120-launch replay buffer so the feed had real rows and real lengths.
  The proxy lived in the session scratchpad and is not in the repo.
- `auditLayout()` plus direct geometry at 1440, 1024 (dock open), 768 and 375×812, and 375×667 with a
  priced quote on screen; English and Russian; a chart opened wide, then the window narrowed.
- The quote in the sheet was a test double of the server's response shape, with a stub provider in
  place of a wallet. Nothing was signed and nothing reached a chain.

## Findings (measured before any change)

| # | Where | What | Number |
|---|---|---|---|
| 1 | 375 | Chrome above the feed: masthead in three rows ("guide" alone on the third), track-record strip with its link on a 44px row of its own, filter bar two rows | first launch at **397px of 812** |
| 2 | 375 | The phone rules for the feed never applied: the `@container feed (max-width:480px)` block sat above the `thead th` / `td` / `.who` rules and lost on source order. Headers stayed unwrapped | ticker column **120px**, tickers cut to 5 characters ("$STIDE…"), score column 68px for two digits, "opening buy" 113px for "2.33%" |
| 3 | 375×667 | A priced quote rendered below a static paragraph; the sheet (capped at 88dvh) overflowed and "sign and send" sat under the fold with nothing pointing to it | button at **688px of 667** |
| 4 | 375 | Inside the sheet the swap was capped at 300px by a rule meant for the old inline box | 58px dead strip on the right |
| 5 | all | The line under the swap was a fragment ("of the launches an outsider could enter…") with numbers frozen into the copy, including a median nothing on the server computes | `/stats` has `withEntry` 2914, `doubled` 157 — no median |
| 6 | 1024 | The cell's single ellipsis ate the count out of the farm badge | "FARM …", "farm ×…" |
| 7 | all | A failed `/state` left the page on "connecting" over an empty feed forever — `boot()` rejected into nothing | no retry, no message |
| 8 | resize | A chart opened in a wide window held the feed at that width after narrowing | **1084px table in a 753px pane** — sideways scroll |
| 9 | 375 quote | "re-quote" and "sign and send" were identical lit green slabs a thumb apart | two primaries |
| 10 | chart | Crosshair labels read `--bg-1`, which does not exist, and fell back to a raw hex | — |
| 11 | 375 | Detail close button | 26px wide |

Clean at every width before and after: no page overflow, 0 contrast failures, 5–7 type sizes, all
on the scale.

## Changes

1. Phone masthead gaps 16→8px: two rows. Track-record link has a short form ("why?"/"почему?", long
   text kept for screen readers) and the lift column hides under 560px, so the strip is one line in
   both languages. Search takes its own row at full width.
2. The phone feed block moved **after** the rules it narrows; score, opening buy and age are sized to
   their content and the launch cell takes the rest.
3. Quote directly under the action; the statistic line moved to the end; after a quote arrives the
   sheet scrolls "sign and send" into view (`scroll-margin-bottom` keeps it off the edge).
4. `.dock .buy{max-width:none}`.
5. `truthLine()` builds the sentence from `/stats` (`withEntry`, `doubled`, the ratio), hidden when
   the stats are not in, repainted when they arrive. EN and RU.
6. The launch cell is a flex row: icon, ticker and badges are one unit that never wraps and inside
   which only the ticker yields; the name shows while 5ch fit, otherwise wraps onto a hidden line.
   The opening-tax countdown joins the unit, so it cannot be carried off.
7. `loadState()` retries with backoff (1s, 2s, 4s … 15s) and says "reconnecting".
8. `.ch-plot{contain:inline-size; overflow:hidden}`.
9. Re-quote drops to an outline while a quote is live and relights when it expires.
10. `--surface-3` for crosshair labels.
11. `.det-x{min-width:44px}` on touch.

## Verification (after)

| | before | after |
|---|---|---|
| first launch, 375×812 | 397px | 335px |
| masthead / track record | 145 / 77px | 115 / 33px (EN and RU) |
| ticker column, 375 | 120px | 199px |
| tickers cut, first 80 rows, 375 | most, to 5 chars | 0 without a badge beside them; 3 (EN) / 10 (RU) that share the row with a badge |
| badges cut or hidden | clipped at 1024 | 0 of 23 at 375 EN/RU, 1024, 1440; 0 of 22 at 768 |
| "sign and send", 375×667 | 688px (off screen) | 601–651px, sheet scrolled 87px |
| feed pane after narrowing with a chart open | 1084 in 753 | 753 in 753, chart redrawn to fit |
| `/state` failing twice | stuck on "connecting" | "reconnecting", state in 3.0s |

`npm run typecheck`, `npm test` (165/165), `npm run build`: pass. Slopcheck: 0 critical, 1 warning —
`#000` is the reset colour of the off-screen probe canvas in `toRgb()`, never painted.

## Critique (gate 3)

"This looks generated because…"

1. …the masthead's status tags and its buttons are the same bordered rectangle. **Defended:** tags are
   10px mono uppercase and never take a pointer; buttons are 12px sans. Distinct by type, not by box.
2. …two identical green slabs in the sheet. **Fixed** (change 9).
3. …the sentence under the swap read like boilerplate with a stat frozen in. **Fixed** (change 5).
4. …on a phone, half the screen was equal-weight bars before any content. **Fixed in part** (397→335px).
   What remains is the ribbon (the one live object on the page) and a two-row filter bar.
5. …below "no wallet" the desktop dock is an empty column. **Defended:** it holds one action; the
   quote, the receipt and the transaction fill it when it is used.

- Investment hierarchy: the feed row — verdict shape, score colour, opening-buy chip. It is what the eye
  lands on at every width.
- Content shape: opening buy, tax, exempt, curve, deployer record — columns that only exist for pons
  launches. This layout would not hold another product unchanged.
- Texture: the farm ×N twin badge that opens the matching set; the opening tax decaying live in the row;
  deployer history as graduated/prior.

## Not done, and why

- Production was not measured in the in-app browser — the pane blocks its fetches. The same page was
  measured locally; production is checked after deploy by `curl` and by the served HTML.
- The phone filter bar is still two rows (segments + filters, then search). Removing a row means hiding
  search or the status, and both earn their place.
- Real-phone confirmation of change 3 needs the tester: open a launch, get a quote, "sign and send" should
  be on screen without scrolling.

## Follow-up, 2026-09-23

The owner asked what "DRY RUN" and "PAUSED" at the top are. They are the operator's engine mode and
run state; to a visitor they said nothing about the launches, and "paused" read as the page being
stopped. Both are now hidden unless signed in as the operator (`applyAudience`), and start hidden in
the markup so they do not flash before `/state` answers. The tour's "dry run or live" step is skipped
for visitors by the existing hidden-target rule (5 steps → 4).
