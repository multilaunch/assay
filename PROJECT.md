# assay

A launch terminal for Robinhood Chain (pons v2). It watches every launch as it lands,
scores it with the reason for each point shown, and lets a visitor trade it from their own
wallet. Local, open, non-custodial, dry run by default.

Live: <https://assay.mlaunch.xyz> · source: <https://github.com/multilaunch/assay>

## What it has to be right about

The product is a claim about numbers, so the numbers are the deliverable:

- **Every number is read from the chain**, not from an API or from documentation.
  `assay doctor` re-reads the protocol constants on every start and refuses to run the
  engine when they disagree with the code.
- **Every verdict is written down before the outcome is known** and checked against what
  happened. The claim is never a rate on its own — it is that the 95% lower bound on the
  FIRE bucket clears the base rate everything else ran at. Measured base rate: **1.19%**
  over 25 789 launches (`docs/GROUND_TRUTH.md`); the live board's own journal currently
  shows 1.55% over 6 250 judged.
- **The board never holds a key for a visitor.** It prices a trade and hands back the exact
  bytes; the visitor's wallet signs and sends.
- **A cache is never load-bearing.** The local index makes reads fast; delete it and every
  reader falls back to the chain, slower and just as correct.

## Layout

| path | what |
| --- | --- |
| `src/chain/` | endpoints, the RPC gate, the block clock |
| `src/pons/` | the protocol: launch detection, curve maths, enrichment, farm fingerprints |
| `src/score/` | the score and its reasons, as codes rather than sentences |
| `src/engine/` | the operator's automation: rules, arming, positions |
| `src/trade/` | building and sending trades — curve and Uniswap v4 |
| `src/track/` | the journal, accuracy, backfill, rule mining |
| `src/index/` | the local copy of the chain: schema, ingester, readers |
| `src/board/` | the HTTP server, the quote route, and `index.html` — the whole page, one file |
| `test/` | 152 checks, no network |
| `deploy/`, `compose.prod.yaml` | the VPS |

`src/board/index.html` is the entire front end: markup, styles, both languages and all the
behaviour. There is no build step for it, which is deliberate — see `DECISIONS.md`.

## Documents

| file | when |
| --- | --- |
| `AGENTS.md` | how to work here. Read first. |
| `DECISIONS.md` | what was decided and why; proposals kept separate |
| `DESIGN.md` | the visual system and the three gates a visual change passes |
| `docs/GROUND_TRUTH.md` | protocol numbers read off the chain, with block heights |
| `docs/NOTES.md` | method: accuracy, rule mining, what running it changed, how the v4 sell was proved |
| `docs/DEPLOY.md` | the VPS, access control, backup, rollback |
| `work/tasks/` | one state file per task in flight |
| `work/logs/` | verbose output, referenced from task files |

## Checks

```sh
npm run typecheck && npm test && npm run build
```

## Tasks in flight

| task | state |
| --- | --- |
| Per-caller limits on the RPC-amplifying routes | [`work/tasks/001-public-route-limits.md`](work/tasks/001-public-route-limits.md) — in progress |

## Known and unfixed

- **No trade has ever been signed from the board with real money.** The bytes are simulated
  and the sell maths reproduces real chain payouts to the wei, but the path from wallet to
  block is unproven. This is the single largest unknown in the product.
- Holders are read from the chain on every request, 7–10s. Measured cost of indexing them:
  ~17 transfers per block chain-wide, ~7M rows for the board's window. Deferred, not refused.
