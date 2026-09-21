# assay — the visual rules

One self-contained file, `src/board/index.html`. No build step, so the tokens at the top of
its `<style>` are the design system; there is nowhere else for them to live.

## Direction

A terminal. Dark ground, zero radius, hairline separation, monospace on every number.
Density is the point: an operator watches this for hours and the screen has to hold a lot
without shouting.

Single scheme. There is no light mode and there should not be one — the board is looked at
in the dark, next to a wallet, and a second palette is a second thing to keep honest.

## Colour: four hues, four jobs, no overlap

Every other tool on Robinhood Chain wears the chain's brand — `#CCFF00` on black, pill
radii, Instrument Serif. Wearing it is camouflage. assay does not.

| token | hue | means |
| --- | --- | --- |
| `--hot` | cyan 200 | you can act here, or this is moving: selection, focus, the tape, how full a curve is |
| `--ok` | green 158 | the verdict is good, or the side is buy |
| `--warn` | amber 82 | unclear |
| `--crit` | red 22 | the verdict is bad, or the side is sell |

The accent is deliberately *not* one of the verdict hues, so a selected control can never be
read as a judgement. Verdict colours appear on the numbers they describe and nowhere else.

Before 2026-09: no accent at all, chrome from black through white. Correct about the brand,
wrong about the rest — on a page where nothing is lit, nothing reads as live.

## Rules that have already been broken once

- **Disabled outranks the accent.** `.act:not([disabled])` carries the colour; the base rule
  is the disabled look. Written the obvious way round, "no wallet" came out in full red.
- **No `min-width` on the feed table.** Columns leave, least useful first, and the queries
  are `@container feed` — the pane is not the window, the trade dock takes 340px off it.
- **Long values wrap.** An address is one unbroken 42-character word and will set the width
  of the whole table if allowed to.
- **Grid rows squeeze.** A grid row will shrink an item below its content when the container
  has a definite height. Stacked layouts use a flex column with `flex:none`.
- **A control that has to be scrolled to is not there.** On a phone the trade panel was stacked
  above the feed; the shell scrolls itself, so tapping a row fifteen deep left the buy and sell
  buttons 1 686px off screen and a tester reported that they "do not load". The primary action is a
  fixed bottom bar on phones. Test any primary control by tapping from a **scrolled** position, not
  from the top of the page.
- **A failure is never cached as an answer.** A dropped request stored as the result made a row say
  "could not read" for the whole session. Failures are retried and offer a button.
- **Reset browser margins on anything semantic.** `<dl>` carried 12px above and below that nobody
  wrote, and five short facts took 431px on a phone.
- **Type scale is 10 / 11.5 / 12 / 13, plus 14–17 for headings.** Nothing half a pixel from
  anything else; that is two people deciding the same thing on different days.

## Gates before calling any visual change done

1. Screenshot it at a wide viewport, at 375px **after scrolling into the feed and tapping a row**, and with the trade dock open. Then measure —
   horizontal overflow, contrast, touch targets, recipe dominance. `getComputedStyle` returns
   `oklch(...)` here, so a contrast check that parses `rgb()` reports nonsense; the page's own
   `toRgb()` goes through a canvas and handles it.
2. `bash ~/.claude/skills/ui-design/scripts/slopcheck.sh src/board/index.html`
3. Write five sentences beginning "this looks generated because…" and act on the ones that
   are true.
