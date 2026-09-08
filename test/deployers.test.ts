import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import { catchupRanges, DeployerIndex } from "../src/pons/deployers.js";
import type { LaunchEvent } from "../src/pons/detect.js";

const A = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;
const launch = (token: number, deployer: number, block: bigint): LaunchEvent => ({
  token: A(token), curve: A(token + 1000), deployer: A(deployer), pairToken: A(0),
  launchConfigId: 0n, graduationThreshold: 0n, blockNumber: block, txHash: "0x00", logIndex: 0, seenAtMs: 0,
});

test("launches that fall out of the window are evicted, not kept forever", () => {
  // the live stream never stops: at ~35 launches a minute a board left up for a week took in ~350 000
  // entries, and "prior launches in the window" quietly counted launches from days outside it
  const idx = new DeployerIndex(100n);
  for (let i = 1; i <= 5; i++) idx.note(launch(i, 1, BigInt(i)));
  assert.equal(idx.stats().launches, 5);
  assert.equal(idx.trim(), 0, "nothing is out of the window yet");

  idx.note(launch(99, 2, 1_000n));
  assert.equal(idx.trim(), 5, "everything older than head − 100 blocks goes");
  assert.deepEqual(idx.stats(), { launches: 1, graduations: 0, deployers: 1 }, "the emptied deployer goes with its last launch");
});

test("a graduation scan an hour behind is chunked and capped instead of asked for in one range", () => {
  // the failure this replaces: one refusal at 60 s widened the next ask to 1 200 blocks, then 1 800,
  // then 2 400, until the endpoint refused 36 000 for good and graduations froze with nothing said
  const { ranges, skipped } = catchupRanges(1_000n, 37_000n, 2_000n, 20_000n);
  assert.equal(skipped, 16_000n, "the oldest blocks are given up on, and the caller is told how many");
  assert.equal(ranges.length, 10);
  assert.ok(ranges.every(([a, b]) => b - a <= 2_000n), "no range is bigger than the chunk size");
  assert.equal(ranges[0]![0], 17_001n);
  assert.equal(ranges[ranges.length - 1]![1], 37_000n, "the newest block is always covered");
});

test("a scan that is barely behind asks for one range and gives up on nothing", () => {
  const { ranges, skipped } = catchupRanges(1_000n, 1_600n, 2_000n, 20_000n);
  assert.equal(skipped, 0n);
  assert.deepEqual(ranges, [[1_001n, 1_600n]]);
  assert.deepEqual(catchupRanges(1_600n, 1_600n, 2_000n, 20_000n), { ranges: [], skipped: 0n });
});
