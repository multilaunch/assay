# hoodterm

Launch terminal for **Robinhood Chain** (pons v2). Reads every launch off the chain, scores it with
rules you can read, and shows the reason for every point. Local, open, non-custodial, dry run by default.

```
 ok  rpc          publicnode → robinhood  832 ms  chain 4663  block 57929559
 ok  economics    launch fee 0.0005 ETH   opening tax 99% over 3 s   max creator tax 10%
 ok  tempo        183 launches in the last 3 000 blocks (~5 min)
 ok  quote check  local 497624.475150350905096897 vs chain 497624.475150350905096897 tokens
                  for 0.001 ETH  (diff 0 bps)
```

## Why the opening tax is the whole problem

Every pons v2 launch opens behind a **99 % tax on buys that decays to zero over 3 seconds**
(`snipeTaxStartBps() = 9900`, `snipeTaxSeconds() = 3`, read live). Robinhood Chain seals a block every
~100 ms, orders transactions by arrival, and has no public mempool and no priority-fee auction.

So the usual race is not just useless here, it is the losing move: being first hands almost the whole
buy to the creator's fee bucket, and no amount of gas changes the ordering. The only variable left is
**when**. hoodterm reads `currentSnipeTaxBps` *for your own address* and treats the wait as the strategy.

## What it reads, per launch

One `aggregate3` through Multicall3 plus the launch transaction:

| Signal | Where it comes from |
|---|---|
| opening buy, as a share of the 1 B supply | the curve's own `CurveBuy` logs inside the launch tx |
| creator tax, fee recipient, pool key, phase | the factory's `getLaunchedToken` record |
| **wallets exempt from the opening tax** | decoded from the launch calldata — this is the *declared bundle* |
| deployer history | in-memory index of every launch and graduation in the last 400 000 blocks |
| launch-farm fingerprint | identical opening buy, tax, links and exemption count from another wallet inside 30 min |
| curve fill, FDV, live opening tax | the curve, in the protocol's own integer order |

The quote path is a line-by-line port of `PonsV2BondingCurve.buy/sell` and
`PonsV2BondingCurveMath`, so `minTokensOut` is computed with the rounding the contract will use.
`doctor --probe` proves it: it simulates a real `buy()` on a live curve with `eth_call` and compares.
On 2026-09-08 the two agreed **to the wei, 0 bps apart**.

## Install

### Docker

```sh
docker compose run --rm doctor          # is the chain there, does our math match it
docker compose up board                 # the web UI on http://127.0.0.1:4663
docker compose run --rm hunt            # live feed in the terminal
docker compose run --rm snipe           # the engine, dry run
docker compose run --rm cli fees 0x…    # any other command
```

The image runs `typecheck` and the whole test suite **at build time**, so a broken tree never produces
one. It runs as `node`, not root — the process that can hold a private key should not be uid 0 — and
positions persist in a named volume.

Two things about the board in a container that are easy to get wrong, so they are written down:

- Inside a container `127.0.0.1` is the *container's* loopback, and Docker's port forwarding cannot
  reach it. The service binds `0.0.0.0` and the restriction moves to the host side of the publish,
  `127.0.0.1:4663:4663`. Same protection, different layer.
- Nothing in `compose.yaml` is live. Going live is a `--live` you add yourself, and it needs
  `PRIVATE_KEY` in `.env` (mounted through `env_file`, never baked into the image).

### Without Docker

```sh
npm install
cp .env.example .env
npm run doctor
```

Node ≥ 20. Three runtime dependencies: `viem`, `commander`, `ws`. No key is needed for anything that
only reads. `.env` works as shipped on the public endpoints.

## Commands

| Command | What it does | Needs a key |
|---|---|---|
| `doctor [--probe]` | RPC, chain id, live pons parameters, address cross-check, and the quote proof | no |
| `hunt` | live feed of launches with a score and reasons; `--json` for pipelines | no |
| `scan [token]` | everything on chain about one token, or the newest launch | no |
| `inspect <token>` | the full card plus the fee ledger for one token | no |
| `snipe` | enter launches that pass the rules, manage exits | `--live` only |
| `board` | the same engine behind a page on 127.0.0.1 | `--live` only |
| `watch <token>` | follow one launch: curve fill, flow, tax, then the pool | no |
| `fees <token>` | who is paid on this token and every claim | no |
| `dev <address>` | every launch by one deployer, with its phase | no |
| `positions` | open and closed positions, marked live | no |
| `accuracy` | what the score has actually been worth, from your own journal | no |
| `farms` | one operator, many wallets, the same token — who is doing it right now | no |
| `rules` | sweeps the journal for rules that survive launches they were not fitted to | no |
| `wallet` | the signer: address, balance, unclaimed creator fees | yes |
| `buy <token> <amt>` | buy wherever it trades: curve before graduation, v4 pool after | `--live` only |
| `sell <token> [pct]` | sell a share of your balance, routed the same way | `--live` only |
| `claim [token]` | take your creator fees out of the pons escrow | `--live` only |

```sh
npm run doctor -- --probe
npm run hunt
npm run hunt -- --fire-only --min-score 70
npm run hunt -- --json --for 300 > launches.jsonl
npx tsx src/cli/main.ts scan 0x…
```

## snipe and board

`snipe` runs the loop in the terminal; `board` runs the same engine behind a page on `127.0.0.1:4663`.
Both are dry run unless started with `--live`, and `--live` is a launch flag, not a button on the page.

```sh
npm run snipe                              # dry run, defaults from .env
npm run snipe -- --min-score 70 --eth 0.02
npm run snipe -- --keyword "grok|claude"   # only launches whose text matches
npm run board                              # feed only until you press start
```

**Four walls around a live session.** A confirmation that prints the signer, its balance and every
limit and waits for you to type `arm`; the entry size; the position cap; and a session budget after
which nothing fires whatever the score. A wallet funded with only the budget cannot lose more than it.

The board binds loopback only and has no route that buys on demand. Its four verbs are pause, resume,
close a position, and edit one of five bounded rules — which take effect on the next launch, so you can
watch `minScore` reshape the feed while it runs. Loopback is not on its own a fence: any page you have
open can post a form to `127.0.0.1`, and any hostname an attacker controls can be pointed at it, so
every request has to name a host the board answers to and every write has to be same-origin JSON.
`BOARD_READONLY=1` drops the four verbs entirely, for a board that is meant to be looked at.

The page carries a nine-stop walkthrough pinned to real elements rather than to a screenshot, so it
cannot drift out of date; it runs itself once on a first visit and lives behind the **guide** button
after that. English and Russian, switchable without a reload.

**Venue routing.** `buy`, `sell` and the engine all go through the same router. Before graduation the curve is the venue. After it, the Uniswap v4 pool behind the
pons hook, keyed by the pair token and tick spacing *the factory recorded for that launch*. Between the
two there is a gap of seconds to minutes where nothing trades at all, and every function refuses during
it instead of quoting a fill nobody can honour.

## The score

Starts at 50, clamps to 0–100, and every line is printed next to the card. FIRE ≥ 75, WATCH ≥ 45.

| Signal | Points |
|---|---|
| opening buy inside the 1–6 % band | +15 |
| opening buy over 10 % | −25 |
| no opening buy | −10 |
| creator tax ≤ 2 % | +10 |
| creator tax over 5 % | −25 |
| fees routed to a third party (the builder / KOL shape) | +5 and a flag |
| X / website / telegram | +8 / +8 / +3 |
| no socials at all | −15 |
| 1–3 / 4+ wallets exempt from the opening tax | −5 / −20 |
| deployer graduated ≥ 30 % of recent launches | +15 |
| serial deployer, 5+ launches, none graduated | −25 |
| one / two+ launch-farm twins in 30 min | −8 / −25 |
| **launch transaction unreadable** | **−20** |
| no factory record / curve unreadable | −15 / −10 |

That last block matters more than it looks. Every other rule is skipped when its input is missing, so
without it a launch nobody could read *outscores* one that was read and looked bad — the penalties never
fire. Caught live: `$ADSTOCKS` scored FIRE 81 with `opening buy ?`. There is a regression test for it.

## Checking the score against what happened

A score nobody checks is an opinion with a number on it. Every launch the terminal judges is written
to `data/journal.jsonl` **before** any decision is taken about it, so the record is of what the score
said and not of what was done about it — checking yourself only means something when you cannot pick
which calls to keep. Hours later `accuracy --resolve` reads each one's phase off the factory and fills
in whether it graduated.

```sh
npx tsx src/cli/main.ts accuracy --backfill --limit 900   # score launches that already happened
npx tsx src/cli/main.ts accuracy --resolve                # then, later, look up the outcomes
npx tsx src/cli/main.ts accuracy --live-only              # only what this terminal saw as it happened
```

`--backfill` exists because the journal starts empty and a launch is not judged until it is six hours
old, which left the feature saying nothing for most of a day. It walks a window of history oldest
first and rebuilds every input **as of the launch's own block** — the deployer's prior launches, how
many of those had graduated *by then*, the farm fingerprints seen before it. Scoring an old launch
against the chain as it looks now would be worthless: the deployer's record already contains the
launches that came after, and the number falling out of that is a report on hindsight. Backfilled rows
are marked in the journal and countable apart from live ones.

The report gives each verdict its graduation rate, a **Wilson 95 % lower bound**, and the lift over the
base rate — because three graduations out of twelve is 25 % only in the sense that a coin landing heads
twice is a 100 % heads rate.

**And it will tell you when it cannot tell you anything.** Graduation here is rare, so the bar for
significance is derived from the measured base rate rather than fixed: at 1.2 %, a bucket needs about
**318 judged launches** before twice that rate could be told apart from luck, and the report says so,
along with how many launches you would have to watch to get there. Every scanner shows you a score.
This one shows you whether its score has earned anything yet.

## Mining the rules instead of guessing them

Every number in `score.ts` started as my judgement. `rules` checks them against the journal:

```sh
npx tsx src/cli/main.ts rules          # what survived
npx tsx src/cli/main.ts rules --all    # and what did not
```

It sweeps thresholds over every signal already recorded per launch, and it splits the journal **by
time, never at random** — earlier launches propose a rule, later launches judge it. A rule fitted to
a farm that ran on Tuesday and was gone by Thursday looks perfect until it meets Thursday, and a
random split would hide exactly that. Thirty predicates are tested, so about one or two clear the
fitting half on luck alone; the holdout column is the only one worth reading, and the count is
printed next to the results so you can do that arithmetic yourself.

First run, 4 375 launches to fit and 1 875 held back: ten rules survived — and **four of them
contradict the score**. Over 10 % opening buy graduated 2.5x more often than average, not less. Four
or more exempt wallets, 2.4x more. Five or more prior launches from the deployer, 2.2x more. No
exempt wallets at all graduated *less* often than the base rate.

None of that was acted on, because graduation is the wrong thing to measure. It only means the curve
filled, and an operator with a bundle and a large opening buy can fill his own curve. Those rules
were probably measuring who can manufacture a graduation, not who is worth buying.

So there is now a second label, read from the curve's own trade logs:

```sh
npx tsx src/cli/main.ts accuracy --price      # what holding each launch would have been worth
npx tsx src/cli/main.ts rules --label peak2x  # and mine against that instead
```

Both curve events carry their legs, so the price is recoverable without any archive state:
`CurveBuy` gives `(quoteIn − fee − tax) / tokensOut`, `CurveSell` gives
`(quoteOut + fee + tax) / tokensIn`. Entry is the first trade **outside the opening-tax window**,
because that is the first moment an outsider could buy at a normal price and it is where this
terminal enters; everything before it belongs to the launcher and his exempt wallets. `peakX` is the
best the curve reached afterwards, as a multiple of that entry, and `endX` where it finished.

The window is counted in blocks from the curve's first trade, not read off the event. The `tax` word
is the **creator's** tax, not the opening one — checked against a live launch, where 293 of 293 buys
on `$HOODFUND` carried exactly its 200 bps from the first to the last. Reading a non-zero `tax` as
"this was sniped" would have handed every trade on every token with a creator fee to the launcher.

Two things this label still cannot see, and they are written here rather than glossed over: once a
launch graduates the curve stops trading and everything that happens in the v4 pool afterwards is
invisible to it, so `endX` on a graduated launch means "price at graduation"; and a launch nobody
traded outside the opening window has no entry price at all, which is recorded as *no entry*, never
as a zero.

The composite held up on its own terms: `score >= 75` graduated 2.2x the base rate on launches it
was not fitted to.

## The one place a model earns its keep

`FarmDetector` catches the operator who reuses the same numbers: same opening buy, same tax, same
link pattern, same exemption count. It cannot catch the one who keeps the idea and changes the
words. `farms --semantic` embeds each launch's name and description and clusters what is merely
alike:

```sh
npx tsx src/cli/main.ts farms --blocks 40000            # exact name and symbol collisions
npx tsx src/cli/main.ts farms --blocks 40000 --semantic # and the ones that only mean the same thing
```

Measured over 646 launches on 2026-09-09, the semantic pass found **ten clusters the exact match
missed**, and about half of them are out of reach of any string comparison: `KEYTURNIP / KT /
KTURN`, `BUTTER / BTTR`, `NVDASH / NVDAI / NVDOGE` — six wallets riding one ticker under names that
share almost no characters. Real, and small.

So it is a tool to look at, not a rule. **It is deliberately not wired into the score.** Everything
that costs points here has to move the lift in `accuracy` first, and this has not been measured that
way yet. It runs offline and batched, never in the three-second entry window, and everything else in
the terminal works with the key unset.

There is no chatbot and there will not be one. The product is that every number was read from the
chain and every point has a reason you can check; a paraphrase of those numbers would be the only
part of the page a reader could not verify, and the one most able to sound confident while wrong.

## What the chain actually looks like

Measured by this tool, 2026-09-09:

- **25 789 launches, 308 graduations** in the last 400 000 blocks (~11 h): a base rate of **1.19 %**.
  That number sets the price of every claim anyone makes about picking launches on this chain. To show
  that a filter doubles it you need a few hundred judged launches inside the filter, not thirty.
- 183–197 launches per 3 000 blocks (~5 min).
- Most launches are **not** paired with ETH. NVDA, USDG and other stock tokens are common, with different
  decimals, so every number is rendered in its own pair's units.

## What running it changed

Defects that only a live run, or a stranger reading the code, could show:

**Missing data read as good news.** Every rule is skipped when its input is missing, so a launch nobody
could read outscored one that was read and looked bad. `$ADSTOCKS` scored FIRE 81 on `opening buy ?`.
Unreadable data is now its own penalty, and a refusal in the engine.

**The websocket outran the RPC.** A launch arrives the moment its log appears, which is routinely before
the endpoint we then query has the block: receipts answer "not found" and contract calls return `0x`.
Measured over 45 s of live launches: **57 % of launch transactions and 29 % of curves failed on the
first read**, and 11 of 13 healed on one retry 800 ms later. That was not noise, it was a hole in the
data the rules run on. `enrichLaunch` retries and merges now — keeping the first value for immutable
fields and the newest for the curve, which moves. Re-measured after the fix: **34 launches, zero
failures**. Retrying is free in the hot path because the engine has to sit out the ~3 s opening tax anyway.

**Commands that start from an address invented their own launch.** `scan` and `inspect` built a
synthetic event with an empty transaction hash, so the launch read failed every single time and the
token collected the "unreadable" penalty it had not earned. They look up the real `TokenLaunched` log
now. The same token went from WATCH 52 to **FIRE 92** once its opening buy (2.00 %, no exempt wallets,
via the router) could actually be read — and that token had in fact graduated.

**Every live exit was impossible, and the tests could not see it.** `ensureAllowance` and
`ensurePermit2` handed viem the signer's *address* where the account object belongs. viem reads a hex
string as a json-rpc account and emits `eth_sendTransaction`, which a public endpoint has no key for —
so a stop loss, a take profit, a trailing stop and the board's close button all died at the approve
step and the position was never sold. An ETH-paired buy worked, which is why nothing looked wrong.
Reproduced by pointing a local account at a recording transport and watching it emit exactly one
method. The whole class of bug is invisible to a test suite that never signs.

**Loopback was doing less work than it looked.** The board bound `127.0.0.1` and that was the entire
protection. `POST /resume` took no body, so any page open in the same browser could arm the engine
with a plain HTML form — no CORS preflight, no JavaScript, response unreadable but the side effect
lands. Any hostname an attacker owns, pointed at 127.0.0.1, became same-origin and could read
positions and sizes. Now every request has to name a host the board answers to and every write has to
be same-origin JSON, which a cross-site form cannot produce. Four attack shapes were tried against the
running process and all four return 403.

**Thirty was the wrong number.** `accuracy` labelled a bucket "thin" below thirty judged launches.
Then the base graduation rate turned out to be 1.19 %, at which a bucket of thirty with nothing in it
is the single most likely outcome whether the score works or not. The bar is derived from the measured
base now, and the honest answer for a young journal is that there is no answer yet.

## Deliberately not here

Bundling, multi-wallet, copy trading, a hosted service, MEV tricks. There is no ordering to exploit on
this chain and no server to trust.

Not proven with real funds: no live trade has ever been executed. Both directions are encoded,
decoded, checked against the chain's own bytes and simulated against the live router — but never
signed. See below.

## Built against

- [`ponsdotdev/ponsfamily`](https://github.com/ponsdotdev/ponsfamily) — `contractsV2/src/v2`, for the curve
  math, the launch entrypoints and the exemption path. Three functions the deployed curve exposes and the
  public source does not (`currentSnipeTaxBps`, `launchedAt`, `snipeTaxExempt`) were read from a live curve;
  see [docs/GROUND_TRUTH.md](./docs/GROUND_TRUTH.md).
- [Robinhood Chain docs](https://docs.robinhood.com/chain/) — sequencer model, RPC.

Independent of pons, Uniswap and Robinhood; uses none of their marks.

## Proving the v4 sell without spending anything

Selling a graduated launch means one `V4_SWAP` through UniversalRouter: swap, settle what we owe, take
what we are owed. Getting that byte layout wrong is the classic way to burn gas on a revert, and there
is no way to test it properly without a funded position.

So it is verified three ways instead:

1. **Round trip.** Every field we encode is decoded back and checked — pool key, hook, `zeroForOne`,
   amounts, and the two `(currency, amount)` legs.
2. **Against the chain's own bytes.** A real UniversalRouter transaction from Robinhood Chain
   (`0xe2ab1c7c…`) is kept in `test/fixtures/`. It decodes cleanly with *our* struct definition and
   carries the same `commands 0x10` and `actions 0x060c0f` we emit. Someone else's calldata is the
   only honest proof that our layout is the real one.
3. **Simulated before sending.** Every live pool trade runs `simulateContract` against the real
   router first and only signs if it passes.

The buy direction gets its own test for the thing a sell can never exercise: native ETH is not pulled
through Permit2, it rides along as `msg.value`, so the encoder has to set `value` or the router
settles nothing.

The read side needs no such hedging: `poolExists`, `getLiquidity` and `quoteV4` were run against three
real graduated pons pools and all three answered.

## Tests

```sh
npm test        # 81 checks, no network
npm run typecheck
```

The curve tests reproduce the fee legs, the 99 % cap, clamped fills and the round-trip cost from the
Solidity. The RPC tests drive the gate with a scripted `fetch`: capability routing, a 429 benching an
endpoint, a real revert not being retried, and the in-flight cap holding. The engine tests check that
every gate refuses by name, that the session budget stops the entry that would cross it and not the one
that lands on it, that each exit rule fires on its own, and that v4 pool ids are stable whichever side
of the pair the token sits on.

Several of these exist because a test that could not fail was found where a test should have been: an
assertion that re-implemented the function it was checking, a range so wide any answer fit inside it,
a regex that passed on `null`, and a helper that read the developer's own `.env` so the suite's result
depended on whose machine it ran on. Every regression test added since was checked by reverting the
fix, watching it fail for the stated reason, and putting the fix back.

## Deploying it on a VPS

`compose.yaml` is the laptop file. For a public box there is a second one:

```sh
BOARD_DOMAIN=board.example.com ACME_EMAIL=you@example.com sudo ./deploy/bootstrap.sh
```

That takes a fresh Ubuntu 24.04 box to a running deployment — Docker, `ufw` down to 22/80/443,
unattended security upgrades, a `hoodterm` user, `0600` on the secrets, a generated board password,
and the stack up behind Caddy with a real certificate. It is idempotent; run it again after a
change. `MODE=systemd` gets the same thing without Docker, using `deploy/hoodterm.service`.

What changes when the board is not on loopback any more:

- **The loopback bind was the whole protection, and on a public box it is gone.** The page can
  pause the engine, resume it and close a position. So `deploy/Caddyfile` puts the entire origin
  behind basic auth over TLS, and additionally pins the four verbs that move money — all of them
  `POST`, while every read is a `GET` — to a source-IP allowlist that defaults to nobody. Full
  control without either is still one `ssh -N -L 4663:127.0.0.1:4663` away.
- **A public board should not be a control panel.** `BOARD_READONLY=1` makes the four verbs that
  move money answer 403 in the process itself and hides their controls on the page, so read access
  and control access stop being the same thing. The proxy allowlist does this too, but it is a
  config file; this one travels with the process.
- **`PRIVATE_KEY` is now on a machine you rent.** Root on the box, a volume snapshot, or the
  provider's console all read it, and no file mode changes that. Use a wallet funded with
  `SESSION_BUDGET_ETH` and nothing else: it is the only one of the limits an attacker cannot edit.
- **The board's Host fence needs the public name.** `guard` in `src/board/server.ts` refuses any
  `Host` it does not recognise, and Caddy forwards the client's `Host` unchanged — so
  `BOARD_HOSTS` has to list the domain or every proxied request is a 403. `bootstrap.sh` sets it.
- **The live feed goes through a proxy**, which is the usual way an SSE stream quietly dies. The
  Caddyfile turns off response buffering and every write and idle timeout on `/events`, and
  [docs/DEPLOY.md](./docs/DEPLOY.md) has a `curl -N` whose output proves it end to end.

Files: `compose.prod.yaml`, `deploy/Caddyfile`, `deploy/hoodterm.service`, `deploy/bootstrap.sh`,
`deploy/env.prod.example`, `deploy/backup.sh`, `deploy/update.sh`. The guide, including how to
verify, read logs, update, back up `positions.json` and roll back, is
**[docs/DEPLOY.md](./docs/DEPLOY.md)**.

## Credit

The shape of this thing is not original. [bodkin](https://github.com/Phosphenq/bodkin) by
phosphenq got to Robinhood Chain first and worked out the parts that are not obvious: that the
99% opening tax makes racing the first block pointless, so the only real question is when to
release; that the exempt wallets are declared in the launch calldata and can therefore be counted;
that a score is worth nothing unless it hands you the reasons behind it. hoodterm follows that
architecture, and parts of it are reused directly.

Where it goes its own way: the journal and `accuracy`, which check the score against what actually
happened instead of asking you to trust it; the board, with the guide and the second language; the
opening tax drawn decaying in real time rather than frozen at read time; and a refusal to treat a
failed read as good news anywhere.

bodkin is MIT, and its notice is in [LICENSE](./LICENSE) alongside ours.

## License

MIT. Read [docs/GROUND_TRUTH.md](./docs/GROUND_TRUTH.md) before you trust a number.
