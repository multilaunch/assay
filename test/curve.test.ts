import assert from "node:assert/strict";
import { test } from "node:test";
import { amountIn, amountOut, clampSlippageBps, effectiveOpeningBps, minOutWithSlippage, progress, quoteBuy, quoteSell, supplyPct, type CurveState } from "../src/pons/curve.js";

/** The fresh ETH-paired curve shape read on chain: 1.68 ETH phantom, 4.2 ETH threshold, 28.57 % reserved. */
function fresh(over: Partial<CurveState> = {}): CurveState {
  const supply = 1_000_000_000n * 10n ** 18n;
  const reserved = (supply * 2857n) / 10_000n;
  return {
    quoteReserve: 1_680_000_000_000_000_000n,
    tokenReserve: supply,
    realQuoteReserve: 0n,
    phantomQuote: 1_680_000_000_000_000_000n,
    sellableTokens: supply - reserved,
    reservedTokens: reserved,
    graduationThreshold: 4_200_000_000_000_000_000n,
    feeBps: 100n,
    creatorTaxBps: 0n,
    openingTaxBps: 0n,
    graduated: false,
    readyToGraduate: false,
    launchedAt: 1_700_000_000,
    readAtMs: 0,
    ...over,
  };
}

test("constant-product out/in are inverses in the contract's integer order", () => {
  const rIn = 1_680n * 10n ** 18n, rOut = 10n ** 27n;
  const out = amountOut(10n ** 17n, rIn, rOut);
  const back = amountIn(out, rIn, rOut);
  // getAmountIn adds +1 like the Solidity, so it lands at or one wei above the input
  assert.ok(back >= 10n ** 17n && back <= 10n ** 17n + 2n, `${back}`);
});

test("a buy takes fee and creator tax off the input before the swap", () => {
  const s = fresh({ creatorTaxBps: 200n });
  const q = quoteBuy(s, 10n ** 18n);
  assert.equal(q.fee, 10n ** 16n);          // 1 %
  assert.equal(q.tax, 2n * 10n ** 16n);     // 2 %
  assert.equal(q.opening, 0n);
  assert.equal(q.spent, 10n ** 18n);
  assert.equal(q.refund, 0n);
  // 0.97 ETH reaches the swap, and with no fee leg amountOut is in·reserveOut/(reserveIn+in):
  // 0.97e18 · 1e27 / 2.65e18, floored
  assert.equal(q.tokensOut, 366_037_735_849_056_603_773_584_905n);
  assert.equal(q.clamped, false);
});

test("the opening tax is one more input leg, capped so the buyer keeps 1 %", () => {
  const s = fresh({ openingTaxBps: 9_900n, creatorTaxBps: 100n });
  assert.equal(effectiveOpeningBps(s), 10_000n - 100n - 100n - 100n);
  const q = quoteBuy(s, 10n ** 18n);
  assert.equal(q.inputBps, 100n + 100n + 9_700n);
  assert.equal(q.tokensOut, 5_917_159_763_313_609_467_455_621n);
  // a 62nd of the untaxed fill, not a hundredth: the untaxed buy puts 0.98 ETH into a 1.68 ETH
  // reserve and pays for its own price impact, so the two fills do not scale with the spend
  const clean = quoteBuy(fresh({ creatorTaxBps: 100n }), 10n ** 18n).tokensOut;
  assert.equal((clean * 1_000n) / q.tokensOut, 62_263n);
});

test("a huge buy clamps to the sellable allocation and refunds the rest", () => {
  const s = fresh();
  const q = quoteBuy(s, 1_000n * 10n ** 18n);
  assert.equal(q.clamped, true);
  assert.equal(q.tokensOut, s.sellableTokens);
  assert.ok(q.spent < 1_000n * 10n ** 18n);
  assert.equal(q.refund, 1_000n * 10n ** 18n - q.spent);
  // the grossed-up spend re-derives the same fee legs the contract charges on `spent`
  assert.equal(q.fee, (q.spent * s.feeBps) / 10_000n);
});

test("a round trip on a fresh curve costs exactly the four fee legs; price impact reverses", () => {
  const s = fresh({ creatorTaxBps: 100n });
  const buy = quoteBuy(s, 10n ** 17n);
  const after: CurveState = { ...s, quoteReserve: s.quoteReserve + buy.spent - buy.fee - buy.tax, tokenReserve: s.tokenReserve - buy.tokensOut };
  const sell = quoteSell(after, buy.tokensOut);
  assert.ok(sell.quoteOut < 10n ** 17n);
  const lossBps = ((10n ** 17n - sell.quoteOut) * 10_000n) / 10n ** 17n;
  // 1 % fee + 1 % tax on the way in, the same on the way out, a few bps of integer rounding
  assert.ok(lossBps >= 390n && lossBps <= 410n, `loss ${lossBps} bps`);
});

test("minTokensOut bounds the rate, not the quantity", () => {
  assert.equal(minOutWithSlippage(1_000_000n, 300), 970_000n);
});

test("slippage is rounded and bounded before it reaches BigInt", () => {
  // a fraction used to throw a RangeError inside the buy, and the entry was lost to an error line
  assert.equal(clampSlippageBps(2.5), 3);
  assert.equal(minOutWithSlippage(1_000_000n, 2.5), 999_700n);
  // above BPS the bound went negative, which is no bound at all
  assert.equal(minOutWithSlippage(1_000_000n, 20_000), 0n);
  // below zero it demanded more than the quote, a guaranteed revert
  assert.equal(minOutWithSlippage(1_000_000n, -100), 1_000_000n);
  assert.equal(clampSlippageBps(Number.NaN), 0);
});

test("fee legs past 99 % floor the opening tax instead of turning it into a rebate", () => {
  const s = fresh({ openingTaxBps: 9_900n, feeBps: 5_000n, creatorTaxBps: 4_950n });
  assert.equal(effectiveOpeningBps(s), 0n);
  const q = quoteBuy(s, 10n ** 18n);
  assert.equal(q.opening, 0n);
  // 0.005 ETH reaches the swap; a negative leg would have added itself back and swapped 0.01
  assert.equal(q.tokensOut, 2_967_359_050_445_103_857_566_765n);
});

test("progress uses real quote against the threshold and clamps to 1", () => {
  assert.equal(progress(fresh()), 0);
  assert.equal(progress(fresh({ realQuoteReserve: 2_100_000_000_000_000_000n })), 0.5);
  assert.equal(progress(fresh({ realQuoteReserve: 9n * 10n ** 18n })), 1);
});

test("supply share of the opening buy", () => {
  assert.equal(supplyPct(30_000_000n * 10n ** 18n), 3);
  assert.equal(supplyPct(0n), 0);
});
