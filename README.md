# assay

A launch terminal for Robinhood Chain. It reads every pons v2 launch straight off the chain, scores
it, and prints the reason behind every point. Runs on your machine, holds your own key, and does
nothing but watch until you tell it otherwise.

```
 ok  rpc          publicnode → robinhood  855 ms  chain 4663  block 58799203
 ok  economics    launch fee 0.0005 ETH   opening tax 99% over 3 s   max creator tax 10%
 ok  tempo        193 launches in the last 3 000 blocks (~5 min)
 ok  quote check  local 579608.263475012363251262 vs chain 579608.263475012363251262 tokens
                  for 0.001 ETH  (diff 0 bps)
```

## Why waiting is the strategy

A pons v2 launch opens behind a 99% tax on buys that decays to zero over three seconds. The chain
seals a block every 100 ms or so, orders transactions by arrival, and has no public mempool and no
priority-fee auction. Win the race and you hand almost the whole buy to the creator's fee bucket, so
speed buys you nothing here. The only variable left is *when*. assay polls
`currentSnipeTaxBps` for your own address and treats the wait as the trade.

## Has the score ever been right

That is the part nobody else answers, so it is the part this thing is built around. Every launch it
judges goes into a journal before any decision is made about it, and hours later the outcome gets
filled in from the chain. Then you can ask.

Measured on 13 990 launches:

```
FIRE graduated 41 of 1141 (3.59%), 2.3x the 1.55% base.
The 95% floor is 2.66%, which clears the base rate.
```

The sobering half of the same data: 9 632 of those launches were never traded at all inside six
hours, and of the ones you could actually enter, the median never went above its entry price. 157
doubled. That is 1.1%.

Asking three different questions of the same launches is what makes the journal worth keeping:

| rule | graduated | doubled | still up at the end |
|---|---|---|---|
| `score >= 75` | 2.2x | 2.4x | 2.0x at `>= 90` |
| `creator tax > 500 bps` | — | 0 of 318 | 0.2x |
| `2+ farm twins` | 0 of 474 | 0.3x | faded |
| `opening buy > 10%` | 2.5x | 2.5x | **0.9x** |
| `4+ exempt wallets` | 2.4x | 3.7x | **no signal** |

Read the last two rows together. A launch with a big opening buy and a declared bundle graduates
more often and doubles more often, and by the end of the window it is worth no more than anything
else. It goes up because someone is pushing it up. It does not stay up.

## Install

```sh
docker compose run --rm doctor      # is the chain there, does our maths match it
docker compose up board             # the page, on http://127.0.0.1:4663
docker compose run --rm hunt        # live feed in the terminal
```

Or without Docker: Node 22, `npm i`, `cp .env.example .env`, `npm run doctor`.

The image runs the typecheck and the whole test suite at build time, so a broken tree never produces
one.

## Commands

| | |
|---|---|
| `doctor [--probe]` | chain, live pons parameters, and a proof that our quote matches the contract |
| `hunt` | live feed with a score and its reasons |
| `board` | the same engine behind a page on loopback |
| `scan` · `inspect` · `watch` · `fees` · `dev` | everything on chain about one token or one deployer |
| `farms` | who is printing the same token from many wallets right now |
| `accuracy` | what the score has been worth, from your own journal |
| `rules` | sweeps the journal for rules that survive launches they were not fitted to |
| `buy` · `sell` · `claim` · `positions` · `wallet` | the trading side; each needs `--live` and a key |

```sh
npm run hunt -- --fire-only --min-score 70
npx tsx src/cli/main.ts accuracy --backfill --limit 2000
npx tsx src/cli/main.ts rules --label peak2x
```

## Going live

`snipe` and `board` are dry runs unless started with `--live`, and `--live` is a launch flag, not a
button on the page. Live mode asks you to type `arm` after printing the signer, its balance and
every limit. There is an entry size, a position cap and a session budget, so a wallet funded with
only the budget cannot lose more than it.

The board binds loopback and has no route that buys on demand. It checks the `Host` on every request
and requires same-origin JSON on the four verbs that move money, because loopback on its own stops
nothing: any page you have open can post a form to `127.0.0.1`.

On a public box the page is meant to be read by anyone — the feed, the ribbon and the track record
need no password. The four verbs do, and so does everything about the wallet: positions, spend and
the activity log are withheld from anyone not signed in, on the event stream as well as on the page.
Set the password with `assay password` into `BOARD_ADMIN_PASSWORD_HASH`; leave it empty and the
controls simply cannot be reached. `BOARD_READONLY=1` removes them even for a signed-in operator.

No live trade has ever been executed with this. Both directions are encoded, decoded against the
chain's own bytes and simulated against the live router, but never signed.

## Deploying it

`compose.prod.yaml`, a Caddyfile, a systemd unit and a bootstrap script are in `deploy/`.
[docs/DEPLOY.md](./docs/DEPLOY.md) covers TLS, auth, backups, updates and rollback.

## Reading further

- [docs/GROUND_TRUTH.md](./docs/GROUND_TRUTH.md) — every protocol number, read from the chain rather
  than from documentation. Read it before you trust anything above.
- [docs/NOTES.md](./docs/NOTES.md) — what broke, what was measured, and how the journal is mined.

## Credit

The shape of this is not original. [bodkin](https://github.com/Phosphenq/bodkin) by phosphenq got to
Robinhood Chain first and worked out the parts that are not obvious: that the 99% opening tax makes
racing pointless, that the exempt wallets are declared in the launch calldata and can be counted,
that a score is worth nothing unless it hands you its reasons. This follows that architecture and
reuses parts of it. bodkin is MIT and its notice sits in [LICENSE](./LICENSE) next to ours.

What is new here is the journal: the score is written down before the outcome is known, checked
against what happened, and reported with a confidence bound rather than a headline.

## License

MIT.
