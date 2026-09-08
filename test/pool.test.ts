import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeAbiParameters, decodeFunctionData, parseAbiParameters, slice, type Address, type Hex } from "viem";
import { ACTION, CMD_V4_SWAP, universalRouterAbi } from "../src/abi/uniswap.js";
import { PONS, ZERO } from "../src/chain/config.js";
import { encodeV4Sell } from "../src/trade/poolTrade.js";
import { poolKeyFor } from "../src/trade/v4.js";

const TOKEN = "0x9AdA7c2A1A860dcE1a8809731732D915D97D2053" as Address;
const KEY = poolKeyFor(TOKEN, { pairToken: ZERO as Address, poolFee: 0, tickSpacing: 200 });
const EXACT_IN_SINGLE = parseAbiParameters("((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)");
const OUTER = parseAbiParameters("bytes actions, bytes[] params");
const SETTLE_TAKE = parseAbiParameters("address, uint256");

test("a sell encodes as one V4_SWAP with swap, settle and take", () => {
  const { commands, inputs, value } = encodeV4Sell(KEY, TOKEN, 10n ** 18n, 900n);
  assert.equal(commands, `0x${CMD_V4_SWAP.toString(16).padStart(2, "0")}`);
  assert.equal(inputs.length, 1);
  assert.equal(value, 0n, "selling a token carries no ETH");

  const [actions, params] = decodeAbiParameters(OUTER, inputs[0]!);
  assert.equal(actions, "0x060c0f");
  assert.equal(Number(slice(actions as Hex, 0, 1)), ACTION.SWAP_EXACT_IN_SINGLE);
  assert.equal(Number(slice(actions as Hex, 1, 2)), ACTION.SETTLE_ALL);
  assert.equal(Number(slice(actions as Hex, 2, 3)), ACTION.TAKE_ALL);
  assert.equal(params.length, 3);
});

test("the swap params round-trip with the pons hook and the recorded pool key", () => {
  const { inputs } = encodeV4Sell(KEY, TOKEN, 10n ** 18n, 900n);
  const [, params] = decodeAbiParameters(OUTER, inputs[0]!);
  const [p] = decodeAbiParameters(EXACT_IN_SINGLE, params[0]!);
  assert.equal(p.poolKey.currency0, ZERO, "native ETH is always currency0");
  assert.equal(p.poolKey.currency1.toLowerCase(), TOKEN.toLowerCase());
  assert.equal(p.poolKey.hooks, PONS.hook);
  assert.equal(p.poolKey.tickSpacing, 200);
  assert.equal(p.zeroForOne, false, "selling currency1 for currency0 is one-for-zero");
  assert.equal(p.amountIn, 10n ** 18n);
  assert.equal(p.amountOutMinimum, 900n);
  assert.equal(p.hookData, "0x");
});

test("settle pays the token in, take collects the pair out at the minimum", () => {
  const { inputs } = encodeV4Sell(KEY, TOKEN, 5n, 3n);
  const [, params] = decodeAbiParameters(OUTER, inputs[0]!);
  const [settleCur, settleAmt] = decodeAbiParameters(SETTLE_TAKE, params[1]!);
  const [takeCur, takeAmt] = decodeAbiParameters(SETTLE_TAKE, params[2]!);
  assert.equal((settleCur as string).toLowerCase(), TOKEN.toLowerCase());
  assert.equal(settleAmt, 5n);
  assert.equal(takeCur, ZERO, "we are owed the pair asset, native ETH here");
  assert.equal(takeAmt, 3n);
});

test("selling the other side of the pair flips zeroForOne and swaps settle/take", () => {
  // 0xff… sorts above the 0x9AdA… token, so here the token is currency0 and the pair is currency1
  const erc20Pair = "0xffffffffffffffffffffffffffffffffffffffff" as Address;
  const key = poolKeyFor(TOKEN, { pairToken: erc20Pair, poolFee: 0, tickSpacing: 200 });
  assert.equal(key.currency0.toLowerCase(), TOKEN.toLowerCase());
  assert.equal(key.currency1.toLowerCase(), erc20Pair.toLowerCase());
  const { inputs } = encodeV4Sell(key, TOKEN, 7n, 1n);
  const [, params] = decodeAbiParameters(OUTER, inputs[0]!);
  const [p] = decodeAbiParameters(EXACT_IN_SINGLE, params[0]!);
  assert.equal(p.zeroForOne, true);
  const [takeCur] = decodeAbiParameters(SETTLE_TAKE, params[2]!);
  assert.equal((takeCur as string).toLowerCase(), erc20Pair.toLowerCase());
});

test("our layout is the one the chain actually uses", () => {
  // A real UniversalRouter transaction pulled from Robinhood Chain on 2026-09-08. If our struct
  // definition were wrong, this decode would throw or produce nonsense — which is the whole point
  // of keeping someone else's bytes in the repo rather than only our own.
  const fx = JSON.parse(readFileSync(new URL("./fixtures/router-v4-swap.json", import.meta.url), "utf8")) as { input: Hex; to: string };
  const d = decodeFunctionData({ abi: universalRouterAbi, data: fx.input });
  assert.equal(d.functionName, "execute");
  const [commands, inputs] = d.args as [Hex, readonly Hex[]];
  assert.equal(commands, "0x10", "one V4_SWAP command");
  const [actions, params] = decodeAbiParameters(OUTER, inputs[0]!);
  assert.equal(actions, "0x060c0f", "swap, settle, take — the same three we emit");
  assert.equal(params.length, 3);

  const [p] = decodeAbiParameters(EXACT_IN_SINGLE, params[0]!);
  assert.ok(p.amountIn > 0n);
  assert.equal(typeof p.zeroForOne, "boolean");
  assert.equal(p.poolKey.tickSpacing, 200);
  // and the two trailing params decode as (currency, amount) exactly as we build them
  const [c1] = decodeAbiParameters(SETTLE_TAKE, params[1]!);
  const [c2] = decodeAbiParameters(SETTLE_TAKE, params[2]!);
  assert.match(c1 as string, /^0x[0-9a-fA-F]{40}$/);
  assert.match(c2 as string, /^0x[0-9a-fA-F]{40}$/);
});
