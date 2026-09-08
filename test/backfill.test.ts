import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import { recordAsOf } from "../src/track/backfill.js";
import { sampleNeeded, wilsonLower } from "../src/track/accuracy.js";

const a = (n: number): Address => `0x${String(n).padStart(40, "0")}` as Address;

test("a graduation that happened after the launch is not evidence the scorer could have had", () => {
  const prior = [a(1), a(2), a(3)];
  const graduatedAt = new Map<string, bigint>([
    [a(1).toLowerCase(), 100n],  // before
    [a(2).toLowerCase(), 900n],  // after: must not count
  ]);
  const at500 = recordAsOf(prior, graduatedAt, 500n);
  assert.equal(at500.prior, 3);
  assert.equal(at500.graduated, 1);

  // and by block 1000 the same deployer looks better, which is exactly why the block matters
  assert.equal(recordAsOf(prior, graduatedAt, 1000n).graduated, 2);
});

test("a graduation in the same block as the launch is not counted either", () => {
  const graduatedAt = new Map<string, bigint>([[a(1).toLowerCase(), 500n]]);
  assert.equal(recordAsOf([a(1)], graduatedAt, 500n).graduated, 0);
});

test("a deployer with no history reads as fresh, not as failed", () => {
  assert.deepEqual(recordAsOf([], new Map(), 1n), { prior: 0, graduated: 0 });
});

test("the sample a rare outcome needs is far larger than a fixed threshold suggests", () => {
  // measured on Robinhood Chain: 308 graduations in 25 789 launches
  const base = 308 / 25_789;
  const n = sampleNeeded(base, 2);
  assert.ok(n > 300, `a 1.2% base needs a real sample, got ${n}`);
  // and the answer is self-consistent: at n, a bucket running at 2x really does clear the base
  assert.ok(wilsonLower(Math.round(n * base * 2), n) > base);
  // a common outcome needs far less
  assert.ok(sampleNeeded(0.4, 2) < n);
});
