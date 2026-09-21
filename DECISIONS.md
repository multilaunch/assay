# Decisions

Each line is a decision that has been taken and the reason it was taken. Reversing one is
allowed; doing it without saying which line you are contradicting is not.

Proposals — things considered and not decided — are at the bottom, kept apart on purpose.

## Taken

### Product

- **Non-custodial, always.** The board prices a trade and returns the exact calldata; the
  visitor's wallet signs. No session keys, no custody, no key material for anyone but the
  single operator. `src/board/quote.ts`.
- **A sell approves exactly that sale, never an unlimited allowance.** A standing permission
  left behind is a claim on tokens the reader may hold for months.
- **The page is public to read; only the four verbs that move money need a password.**
  Reading the board is the product. `docs/DEPLOY.md`, Access control.
- **Refuse rather than guess.** A quote for a non-ETH pair, a graduated curve, or an amount
  out of bounds is refused with a reason, not approximated.
- **Waiting is the strategy.** pons opens behind a 99% tax decaying over 3s, so there is no
  first-block race to lose and a person clicking is not meaningfully slower than a bot.

### Numbers

- **Every protocol constant is read from the chain**, re-read by `doctor` on every start.
  Source documentation has already been wrong: `snipeTaxSeconds` is 3 here, not the 15 in
  the published source. `docs/GROUND_TRUTH.md`.
- **The significance bar is derived from the base rate, not fixed at 30 samples.** At a
  1.19% base rate a bucket of thirty with no graduation is the most likely outcome whether a
  filter works or not; showing a doubling takes ~318 judged launches inside the filter.
- **Rule mining splits on time, never at random.** A farm that ran Tuesday and vanished
  Thursday makes a random split lie.

### Engineering

- **`node:sqlite` for the local index — no dependency, no service.** Measured: 200k inserts
  in 99ms, and it runs unflagged in `node:22-alpine`. Rejected ClickHouse for now: the
  bottleneck was RPC round trips, not query speed.
- **The index is a cache and may never be load-bearing.** The board opens it read-only, must
  not need a writable directory to start, and falls back to the chain for any range it does
  not cover. A derived copy that becomes required is one that can be wrong unnoticed.
- **The index is bounded (`--keep 4000000`, ~4.5 days, ~735 MB).** Unbounded it writes ~3 GB
  a month on a rented box. Pruning moves the coverage floor with it, so a trimmed range reads
  as missing rather than as empty.
- **Curve trades are filtered by topic, not by address** — one `getLogs` covers every live
  curve. An event counts only if its emitter is a curve the factory announced, because the
  topic is public and anyone may emit it.
- **The front end is one file with no build step.** It is read as a whole, deployed as a
  whole, and has no toolchain to rot. The cost is a 167 KB page, which is accepted.
- **Third-party assets are vendored and served from our origin, never a CDN.** Same reason
  token images are proxied: a script tag pointing elsewhere hands that host the address of
  every reader, seconds before they trade. `src/board/vendor/`.
- **The chart is TradingView Lightweight Charts** with its attribution mark left on. The
  Apache-2.0 licence does not compel the mark; the authors ask for it.
- **The server sends a code beside every refusal; the page translates it.** The English
  sentence is what a `curl` of the route should print. Twenty-three of them used to reach a
  Russian reader untranslated.
- **Verbose logging stays out of the documents.** `work/logs/`, referenced by filename.
- **What is rationed is reaching the chain, not asking a question.** The limiter sits behind
  the caches, so a warm answer costs nobody anything. Three bounds — per caller in flight,
  per caller over time, and a ceiling for the whole board. The ceiling is what makes the
  failure legible: a fast 429 with a retry-after, rather than everyone waiting a minute
  while nothing says why. Measured both ways in `work/logs/001-baseline.md`.

- **On a phone the trade panel is a bottom bar, not a block in the flow.** Ticker, BUY, SELL always on
  screen while a launch is selected; a tap opens the swap as a sheet. Stacking it above the feed put it
  off screen (task 003). Above 860px it stays a 340px column beside the feed.
- **A failed read is never a cached answer.** Retried once automatically, then a button.

### Look

Recorded in full in `DESIGN.md`. The two that constrain code rather than CSS:

- **One accent (cyan), and it is none of the three verdict hues**, so a selected control can
  never be read as a judgement.
- **The feed table has no minimum width.** Columns leave, least useful first, measured
  against the pane — the trade dock takes 340px off it independently of the window.

- **A phone visitor with no wallet is handed to a wallet's in-app browser, not connected remotely.**
  Deep links for MetaMask, Coinbase Wallet and Trust Wallet, each checked against its own
  documentation; discovery by `window.ethereum` then EIP-6963. No dependency, nothing from another
  host, CSP untouched. Rabby is left out because no documented link exists, and a guessed one is worse
  than none. Task 004.

## Proposed — not decided

- **WalletConnect, for connecting from an ordinary phone browser.** Needs a vendored library of hundreds of
  kilobytes, a project id from a third party, and a CSP that allows their relay servers — whose operators
  would see who connects and when, which is what proxying token images exists to avoid. Not taken; revisit
  if many visitors arrive on a phone and leave at "open in wallet".
- **Cloudflare in front of the origin.** It would absorb a volumetric flood and hide the
  VPS address, and the free tier covers it. Two things argue against reaching for it first:
  it puts a third party in the TLS path for every reader, which sits badly beside proxying
  token images so launchers cannot see them; and it does not address the cheap attack that
  actually exists here — walking distinct token addresses to force cache misses on
  `/candles` and `/holders`, each of which costs many `getLogs` against a rate-limited
  public RPC. That was fixed in the board — task 001, done. **What is left after it, measured:**
  a distributed flood still costs readers 7.9 s instead of 0.5 s, and nothing in the
  application can help with a flood that never reaches it. Those two are the honest case for
  a CDN, and they are smaller than the case looked like before the limits existed. Still the
  user's call, still not taken.
- **Holders in the index.** Measured before deferring: ~17 transfers per block chain-wide,
  ~7M rows and ~0.5 GB for the board's window, to speed up a panel opened for a handful of
  tokens. Better shape if it is ever wanted: index a token's transfers lazily on first
  request and keep them, rather than the whole chain.
- **The trader's address in the trades table.** Would give per-wallet bought/sold/PnL per
  launch, the one thing the reference terminal shows that this does not. Costs a schema
  change and a re-ingest.
- **Collapsing the remaining near-duplicate type sizes.** Now seven; four would be a scale.
