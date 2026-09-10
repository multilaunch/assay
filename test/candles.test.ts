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
