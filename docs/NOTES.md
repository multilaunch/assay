# Notes

The long version of what is in the README: what was measured, what broke, and what
the journal says. Kept out of the front page because most people do not need it.

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

### What the three labels say together

13 990 launches priced. **9 632 of them were never traded at all** inside six hours; another 1 444
were traded only inside the opening window, by the launcher. Of the 2 914 an outsider could actually
enter, the median best price was **exactly the entry price** — it never went up once. 157 launches
doubled at any point: 5.4 % of the ones you could enter, 1.1 % of all of them.

Asking the same predicates three different questions is what settles the contradiction:

| rule | graduated | doubled | still up at the end |
|---|---|---|---|
| `score >= 75` | 2.2x | 2.4x | 2.0x at `>= 90` |
| `opening buy 1-6%` | — | 2.1x | 1.3x |
| `creator tax > 500 bps` | — | 0 of 318 | 0.2x |
| `opening buy = 0` | 0.2x | 0.2x | — |
| `2+ farm twins` | 0 of 474 | 0.3x | faded |
| **`opening buy > 10%`** | 2.5x | 2.5x | **0.9x — gone** |
| **`4+ exempt wallets`** | 2.4x | 3.7x | **no signal** |

The last two rows are the answer. A launch with a big opening buy and a declared bundle graduates
more often and doubles more often, and by the end of the window it is worth no more than any other
launch. It goes up because somebody is pushing it up, and it does not stay up. That is a pump, seen
from the outside, in three columns — and it is why the hand-set penalties on those two signals turn
out to have been right after all, for a reason I could not have articulated before the price label
existed.

Everything else agrees with the score, and the score orders correctly on its own: 1.7x at `>= 45`,
1.9x at `>= 55`, 2.1x at `>= 65`, 2.4x at `>= 75`, on launches it was not fitted to. `score.ts` has
not been changed, because nothing here says to change it.

One caveat on all of the above: the holdout period was more generous than the fitting period (1.52 %
of launches doubled against 0.95 %). Lift is computed against each side's own base rate, so the
comparison holds, but the absolute rates drift with the mood of the chain.

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
