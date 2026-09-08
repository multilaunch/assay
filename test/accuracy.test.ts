import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import { lift, report, wilsonLower, THIN } from "../src/track/accuracy.js";
import type { Entry, Outcome, Verdict } from "../src/track/journal.js";

const A = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;
let seq = 0;
const row = (verdict: Verdict, outcome: Outcome | undefined, score = 50): Entry => ({
  t: 1_700_000_000_000 + seq, token: A(++seq), curve: A(seq + 5000), deployer: A(1),
  symbol: "T", score, verdict, devPct: 2, taxBps: 100, exempt: 0, farmTwins: 0,
  deployerPrior: 0, deployerGraduated: 0, pair: "ETH", pairNative: true,
  ...(outcome ? { outcome, resolvedAt: 1 } : {}),
});
const many = (n: number, v: Verdict, o: Outcome, score = 50) => Array.from({ length: n }, () => row(v, o, score));

test("a launch too young to judge is counted as pending, never as a failure", async () => {
  const r = await report([...many(4, "FIRE", "graduated"), ...many(6, "FIRE", "died"), row("FIRE", undefined)]);
  const fire = r.buckets.find((b) => b.verdict === "FIRE")!;
  assert.equal(fire.judged, 10, "the unresolved row must not enter the denominator");
  assert.equal(fire.pending, 1);
  assert.equal(fire.rate, 0.4);
});

test("lift is measured against everything judged, not against a fixed number", async () => {
  const r = await report([
    ...many(20, "FIRE", "graduated"), ...many(20, "FIRE", "died"),   // 50%
    ...many(10, "SKIP", "graduated"), ...many(90, "SKIP", "died"),   // 10%
  ]);
  const fire = r.buckets.find((b) => b.verdict === "FIRE")!;
  const skip = r.buckets.find((b) => b.verdict === "SKIP")!;
  assert.equal(+r.base.toFixed(4), 0.2143);                 // 30 of 140
  assert.equal(+lift(fire, r.base)!.toFixed(2), 2.33);
  assert.ok(lift(skip, r.base)! < 1, "a bucket worse than average must land under 1x");
});

test("an empty bucket reports no rate rather than a zero that looks like a result", async () => {
  const r = await report(many(5, "SKIP", "died"));
  const fire = r.buckets.find((b) => b.verdict === "FIRE")!;
  assert.equal(fire.judged, 0);
  assert.equal(fire.rate, 0);
  assert.equal(lift(fire, r.base), null, "no sample means no lift, not 0x");
});

test("the Wilson floor is well under the point estimate on a thin sample and close on a fat one", () => {
  // 3 of 12 looks like 25%; the sample supports far less than that
  assert.ok(wilsonLower(3, 12) < 0.1, `${wilsonLower(3, 12)}`);
  // 300 of 1200 is the same ratio with a hundred times the evidence
  assert.ok(wilsonLower(300, 1200) > 0.22, `${wilsonLower(300, 1200)}`);
  assert.ok(wilsonLower(300, 1200) < 0.25);
  assert.equal(wilsonLower(0, 0), 0);
  assert.ok(wilsonLower(10, 10) > 0.7 && wilsonLower(10, 10) < 1);
});

test("score bands split at the verdict thresholds and cover every score", async () => {
  const r = await report([row("SKIP", "died", 0), row("SKIP", "died", 44), row("WATCH", "died", 45),
                          row("WATCH", "graduated", 74), row("FIRE", "graduated", 75), row("FIRE", "graduated", 100)]);
  assert.deepEqual(r.bands.map((b) => [b.from, b.to]), [[0, 44], [45, 59], [60, 74], [75, 89], [90, 100]]);
  assert.equal(r.bands.reduce((s, b) => s + b.judged, 0), 6, "a score of 100 must land in a band, not fall off the end");
  assert.equal(r.bands.at(-1)!.judged, 1);
});

test("thin samples are recognisable so a rate off nine launches is never quoted as fact", async () => {
  const r = await report(many(THIN - 1, "FIRE", "graduated"));
  assert.ok(r.buckets.find((b) => b.verdict === "FIRE")!.judged < THIN);
});
