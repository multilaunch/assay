import assert from "node:assert/strict";
import { test } from "node:test";
import { pickBucketSec, toCandles } from "../src/board/candles.js";

const p = (t: number, price: number, vol = 1) => ({ t, p: price, vol });

test("open is the first print in the bucket and close is the last, not the low and high", () => {
  const [c] = toCandles([p(0, 5), p(100, 9), p(200, 2), p(300, 7)], 1000);
  assert.equal(c!.o, 5);
  assert.equal(c!.c, 7);
  assert.equal(c!.h, 9);
  assert.equal(c!.l, 2);
  assert.equal(c!.n, 4);
});

test("prints land in the bucket they belong to, and empty stretches produce no candle", () => {
  const cs = toCandles([p(0, 1), p(999, 2), p(1000, 3), p(5500, 4)], 1000);
  assert.deepEqual(cs.map((c) => c.t), [0, 1000, 5000]);
  assert.deepEqual(cs.map((c) => c.n), [2, 1, 1]);
});

test("candles come out in time order however the prints arrived", () => {
  const cs = toCandles([p(9000, 3), p(0, 1), p(4000, 2)], 1000);
  assert.deepEqual(cs.map((c) => c.t), [0, 4000, 9000]);
});

test("volume is summed, not averaged", () => {
  const [c] = toCandles([p(0, 1, 10), p(10, 1, 5), p(20, 1, 1)], 1000);
  assert.equal(c!.vol, 16);
});

test("one print is a candle with four equal legs, not a crash", () => {
  const [c] = toCandles([p(0, 42)], 1000);
  assert.deepEqual([c!.o, c!.h, c!.l, c!.c], [42, 42, 42, 42]);
});

test("nothing to plot yields nothing rather than a fake candle", () => {
  assert.deepEqual(toCandles([], 1000), []);
  assert.deepEqual(toCandles([p(0, 1)], 0), []);
});

test("the bucket grows with the span so the chart keeps its shape", () => {
  assert.ok(pickBucketSec(60) <= 5, "a minute of trading wants seconds");
  assert.ok(pickBucketSec(3600) >= 60, "an hour wants minutes");
  assert.ok(pickBucketSec(86_400) >= 600, "a day wants more than minutes");
  // monotonic: a longer span never asks for a finer bucket
  let last = 0;
  for (const span of [30, 60, 300, 1800, 3600, 21_600, 86_400]) {
    const b = pickBucketSec(span);
    assert.ok(b >= last, `${span}s asked for a finer bucket than ${last}`);
    last = b;
  }
});

/**
 * The v4 half of the chart. sqrtPriceX96 is a square root of a raw-unit ratio, and both the square
 * and the orientation are places where a wrong answer still draws a plausible picture.
 */
import { priceFromSqrt } from "../src/board/candles.js";

/** sqrt(ratio) * 2^96, the encoding the pool stores. */
const enc = (ratio: number) => BigInt(Math.round(Math.sqrt(ratio) * 2 ** 96));

test("a pool price comes back as pair units per whole token", () => {
  // 1 token = 2e-8 ETH, so 1 ETH buys 5e7 tokens; with the token as currency1 the raw ratio is that
  const p = priceFromSqrt(enc(5e7), true, 18, 18);
  assert.ok(Math.abs(p - 2e-8) / 2e-8 < 1e-6, `got ${p}`);
});

test("the answer is flipped when the token sorted first", () => {
  // same pool read the other way round: currency0 is the token, so the ratio is already ETH/token
  const p = priceFromSqrt(enc(2e-8), false, 18, 18);
  assert.ok(Math.abs(p - 2e-8) / 2e-8 < 1e-6, `got ${p}`);
  // and the two orientations must not agree, or the flip is doing nothing
  assert.notEqual(priceFromSqrt(enc(5e7), true, 18, 18), priceFromSqrt(enc(5e7), false, 18, 18));
});

test("a six-decimal pair is corrected by twelve orders of magnitude, not left raw", () => {
  const raw = priceFromSqrt(enc(5e7), true, 18, 18);
  const stable = priceFromSqrt(enc(5e7), true, 18, 6);
  assert.ok(Math.abs(stable / raw - 1e12) / 1e12 < 1e-6, `expected a 1e12 factor, got ${stable / raw}`);
});

test("a price the pool cannot have does not become a candle", () => {
  assert.equal(priceFromSqrt(0n, true, 18, 18), 0);
  assert.equal(priceFromSqrt(0n, false, 18, 18), 0);
});

test("the curve and the pool agree at the seam", () => {
  // the live graduation this was checked against: last curve print 2.0291e-8, first swap 2.0875e-8
  const fromPool = priceFromSqrt(enc(1 / 2.0875e-8), true, 18, 18);
  assert.ok(Math.abs(fromPool - 2.0291e-8) / 2.0291e-8 < 0.05, `${fromPool} is not within 5% of the curve's last price`);
});
