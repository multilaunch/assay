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

```sh
git clone <this repo> && cd hoodterm
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

```sh
npm run doctor -- --probe
npm run hunt
npm run hunt -- --fire-only --min-score 70
npm run hunt -- --json --for 300 > launches.jsonl
npx tsx src/cli/main.ts scan 0x…
```

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

## What the chain actually looks like

Measured by this tool, 2026-09-08:

- **22 524 launches, 224 graduations** in the last 400 000 blocks (~11 h) — about **one in a hundred** graduates.
- 183–197 launches per 3 000 blocks (~5 min).
- Most launches are **not** paired with ETH. NVDA, USDG and other stock tokens are common, with different
  decimals, so every number is rendered in its own pair's units.

## Deliberately not here

Bundling, multi-wallet, copy trading, a hosted service, MEV tricks. There is no ordering to exploit on
this chain and no server to trust. Reading is free; the parts that can move money are dry run until
`--live`, which is not built yet.

## Built against

- [`ponsdotdev/ponsfamily`](https://github.com/ponsdotdev/ponsfamily) — `contractsV2/src/v2`, for the curve
  math, the launch entrypoints and the exemption path. Three functions the deployed curve exposes and the
  public source does not (`currentSnipeTaxBps`, `launchedAt`, `snipeTaxExempt`) were read from a live curve;
  see [docs/GROUND_TRUTH.md](./docs/GROUND_TRUTH.md).
- [Robinhood Chain docs](https://docs.robinhood.com/chain/) — sequencer model, RPC.

Independent of pons, Uniswap and Robinhood; uses none of their marks.

## Tests

```sh
npm test        # 23 checks, no network
npm run typecheck
```

The curve tests reproduce the fee legs, the 99 % cap, clamped fills and the round-trip cost from the
Solidity. The RPC tests drive the gate with a scripted `fetch`: capability routing, a 429 benching an
endpoint, a real revert not being retried, and the in-flight cap holding.

## License

MIT. Read [docs/GROUND_TRUTH.md](./docs/GROUND_TRUTH.md) before you trust a number.
