import assert from "node:assert/strict";
import { test } from "node:test";
import { cluster, cosine } from "../src/ml/embed.js";

test("cosine ignores magnitude and answers on direction", () => {
  assert.equal(cosine([1, 0], [2, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.ok(cosine([1, 1], [1, 0]) > 0.7 && cosine([1, 1], [1, 0]) < 0.72);
  assert.equal(cosine([0, 0], [1, 1]), 0);
});

test("a farm that drifts its wording stays one cluster, not several", () => {
  // a chain: each link is close to the next, the ends are not close to each other
  const chain = [[1, 0], [0.95, 0.31], [0.85, 0.53], [0.72, 0.69]];
  const ends = cosine(chain[0]!, chain[3]!);
  assert.ok(ends < 0.86, `the ends must be far apart for this to prove anything, got ${ends}`);
  const groups = cluster(chain, 0.86);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.length, 4);
});

test("a vector that could not be embedded is left out rather than grouped with everything", () => {
  const groups = cluster([[1, 0], null, [1, 0]], 0.9);
  assert.deepEqual(groups, [[0, 2]]);
});

test("nothing alike means no clusters at all", () => {
  assert.deepEqual(cluster([[1, 0], [0, 1]], 0.9), []);
});
