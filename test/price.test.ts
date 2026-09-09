import assert from "node:assert/strict";
import { test } from "node:test";
import { summarise } from "../src/track/price.js";

const p = (block: number, price: number) => ({ block: BigInt(block), price });

test("the opening window belongs to the launcher and is not the entry", () => {
  // three sniped prints at a wild price, then the real market
  const o = summarise([p(100, 50), p(101, 60), p(131, 1), p(200, 3), p(300, 2)], 10_000n, 31n);
  assert.equal(o.earlyTrades, 2);
  assert.equal(o.entry, 1);
  assert.equal(o.peak, 3);
  assert.equal(o.peakX, 3);
  assert.equal(o.endX, 2);
});

test("a launch nobody outside the window ever traded has no entry to speak of", () => {
  const o = summarise([p(100, 50), p(102, 60)], 10_000n, 31n);
  assert.equal(o.entry, null);
  assert.equal(o.peakX, null);
  assert.equal(o.earlyTrades, 2);
  assert.equal(o.trades, 2);
});

test("trades past the horizon do not count", () => {
  const o = summarise([p(100, 1), p(140, 1), p(200, 9), p(9000, 100)], 500n, 31n);
  assert.equal(o.peak, 9);
  assert.equal(o.trades, 3);
});

test("points arriving out of order are still read in block order", () => {
  const o = summarise([p(300, 2), p(140, 1), p(100, 50)], 10_000n, 31n);
  assert.equal(o.entry, 1);
  assert.equal(o.endX, 2);
});

test("nothing traded at all is not a zero, it is nothing", () => {
  const o = summarise([], 10_000n, 31n);
  assert.equal(o.trades, 0);
  assert.equal(o.peakX, null);
});
