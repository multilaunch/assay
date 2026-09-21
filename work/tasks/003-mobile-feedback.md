# 003 — mobile feedback: buy/sell buttons and the token window "do not load"

status: **in progress** · opened 2026-09-21

## The report (verbatim, a tester, 2026-09-19, Telegram)

> Потестировал. Короче на мобилке все чет прям беда.
> Кнопки сел бай не прогружаются.
> Окно токена тоже не до конца грузит.
> Открой на телефоне и покликай ты поймёшь о чём я.

No device, browser, screenshot or wallet named. Whether they were in a wallet's in-app browser
or a normal one is **unknown** and matters (see below).

## Goal

Reproduce what the tester saw, find the cause, fix it, and prove the fix on a phone-sized
viewport by tapping rather than by script.

## Constraints

- Task 001's limiter stays unless it is shown to be the cause, and then it is tuned with numbers.
- AGENTS.md verification table applies. Screenshot at 375 px and measure.

## Hypotheses — NOT yet checked

Listed so they are tested and not believed:

1. Stacked layout puts the dock **above** the feed. Tapping a row deep in the list opens the dock
   off-screen at the top, so the buttons "are not there".
2. The task 001 limiter refuses a normal reader: a row open fires `/candles` and `/holders`
   (holders take 7–10 s), so opening three rows quickly is six in flight against a cap of four.
   The page has no handling for 429, so the chart and holders would just say "could not read".
3. Carrier NAT: many phones behind one address share one budget.
4. Something specific to a real phone that the emulator does not reproduce.

## Reproduced — production, 375 px, real tap on a row in the middle of the feed

| # | what the tester would have seen | measured |
|---|---|---|
| 1 | **BUY / SELL are not on screen.** On a phone the dock stacks *above* the feed; the shell scrolls itself, so tapping a row 15 deep leaves the dock **1 686 px above** the visible area. The tester sees the opened row and no trade buttons at all. | `dockTopInShell: -1686`, `actButtonVisibleNow: false` |
| 2 | **The "trade $X" button inside the row does nothing on a phone.** It calls `openDock`, which for an already-open dock only un-hides it — no scroll. The one control meant to bring the panel back is a no-op. | `scrollBeforeTap 2545 → scrollAfterTap 2545`, dock still off-screen |
| 3 | **The token window is 1 431 px tall** — nearly two screens for one token — with the chart 700 px down. 5 short facts take 431 px because `<dl class="kv">` still has the browser's default 12 px top and bottom margin. True at every width; a phone is where it hurts. | grid 431 px, `kvMargin 12px / 12px` ×5 |

## Hypotheses — status

1. Dock above the feed, off-screen: **confirmed** (#1).
2. Task 001 limiter refusing a normal reader: **not reproduced.** Seven rows opened 2.5 s apart,
   17 requests, every one 200 — fresh launches answer `/holders` in well under a second, so
   nothing stays in flight long enough to hit the cap of four. It could still bite on old,
   slow tokens or behind a shared address; that is untested and stays open. Not changed.
3. Carrier NAT sharing a budget: **untested.**
4. Something an emulator cannot show: **unknown.** No real phone or wallet in-app browser was
   available. What follows is verified in an emulated 375 px viewport only.

## A fourth finding, reproduced

| # | | measured |
|---|---|---|
| 4 | **A failed holders read was cached as the answer.** Any dropped request, 429 or 502 was stored, and the row said "could not read the holders" for the rest of the session — even after the connection recovered. On a phone's network that is the likeliest reading of "the token window does not fully load". | dropped one request, reopened on a healthy connection: still "could not read", `cachedAsFailure: true` |

## Fixed

| # | fix | after |
|---|---|---|
| 1, 2 | On a phone the dock is a **bottom bar that is always on screen** — ticker, green BUY, red SELL, ×. Tapping either opens the full swap as a sheet on that side. The row's "trade $X" button now expands the sheet. × in the sheet returns to the bar; Escape does the same. Above 860 px nothing changes. | strip 61 px at the bottom, on screen at any scroll; sheet 526 px of an allowed 715 |
| 3 | `.kv { margin: 0 }`; holders on a phone show the top 5 with the rest behind "and N more" | worst case (31 exempt wallets): window **1 208 px, was 1 686**; chart at 565 px, was 700+ |
| 4 | a failure is never cached; one automatic retry after the server's `retry-after` (or 3 s on a dropped request), then a "try again" button | 3 cases, below |

Retry, tested against a page whose `fetch` was made to fail on purpose:

| case | result |
|---|---|
| one dropped request | "trying again in 3 s…" → **recovered with no tap** |
| two in a row | one automatic retry, then a button; tapping it **loaded** |
| fails, row closed, network back, row reopened | failure **not remembered**; loaded |

165 tests pass; slopcheck 0 critical. At 375 px no element scrolls sideways; at 1440 the dock is
a 340 px column, the strip is `display:none`, shell padding 0.

## A mistake of mine, recorded

The first retry test appeared to fail. The cause was the test: a previous aborted script had left
a `fetch` stub installed, and I then captured *that* as "the real fetch", so it dropped a request of
its own. Reloading for a pristine `fetch` and re-running gave the right answer. The retry code was
never wrong. Worth remembering when a check contradicts an isolated one.

## Not verified — and this matters

- **No real phone.** Everything above is an emulated 375 px viewport with touch. Real iOS Safari and
  Android Chrome differ in ways that could matter here: the dynamic address bar changing the
  viewport height (the sheet uses `dvh`), and the on-screen keyboard covering the amount field in
  the sheet. Not tested.
- **No wallet in-app browser.** If the tester used one, `window.ethereum` exists and the buttons
  would be live rather than "no wallet". Every screenshot here shows "no wallet".
- **The task 001 limiter** was not reproduced as a cause (7 rows in 17 s, all 200) but remains
  untested for slow tokens and for many phones behind one carrier address.

## Next step

Deploy, verify on production at 375 px, then ask the tester which device and browser they used.
