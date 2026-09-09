import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import { candidates, mine } from "../src/track/mine.js";
import type { Entry } from "../src/track/journal.js";

let seq = 0;
function row(over: Partial<Entry> = {}): Entry {
  seq++;
  return {
    t: seq, token: `0x${String(seq).padStart(40, "0")}` as Address,
    curve: "0x00" as Address, deployer: "0x00" as Address,
    symbol: null, score: 50, verdict: "WATCH",
    devPct: 3, taxBps: 100, exempt: 0, farmTwins: 0,
    deployerPrior: 0, deployerGraduated: 0, pair: "ETH", pairNative: true,
    outcome: "died",
    ...over,
  };
}

/** n rows, of which `grad` graduated, all matching `over`. */
const batch = (n: number, grad: number, over: Partial<Entry>): Entry[] =>
  Array.from({ length: n }, (_, i) => row({ ...over, outcome: i < grad ? "graduated" : "died" }));

test("a signal that really separates survives the holdout", () => {
  seq = 0;
  // 4+ exempt wallets never graduates; everything else graduates a fifth of the time. Interleaved
  // so both halves of the time split see both populations.
  const rows: Entry[] = [];
  for (let i = 0; i < 200; i++) {
    rows.push(row({ exempt: 0, outcome: i % 5 === 0 ? "graduated" : "died" }));
    rows.push(row({ exempt: 6, outcome: "died" }));
  }
  const rep = mine(rows, { minN: 30 });
  const f = rep.findings.find((x) => x.label === "4+ exempt wallets");
  assert.ok(f, "the predicate should have been tested");
  assert.equal(f.verdict, "keeps");
  assert.equal(f.direction, "down");
});

test("a signal that is pure coincidence does not survive it", () => {
  seq = 0;
  // the flag is set on the first half only, and graduation is unrelated to it
  const rows: Entry[] = [];
  for (let i = 0; i < 400; i++) rows.push(row({ exempt: i < 200 ? 6 : 0, outcome: i % 7 === 0 ? "graduated" : "died" }));
  const rep = mine(rows, { minN: 30 });
  const f = rep.findings.find((x) => x.label === "4+ exempt wallets")!;
  assert.notEqual(f.verdict, "keeps");
});

test("the split is by time, so the holdout is strictly later than the fit", () => {
  seq = 0;
  const rows = batch(100, 10, {});
  const rep = mine(rows, { holdout: 0.3, minN: 5 });
  assert.equal(rep.trainN, 70);
  assert.equal(rep.holdoutN, 30);
  assert.equal(rep.splitAt, rows[70]!.t);
});

test("unresolved launches are not evidence and are left out", () => {
  seq = 0;
  const rows = [...batch(50, 5, {}), ...Array.from({ length: 50 }, () => row({ outcome: "pending" }))];
  const rep = mine(rows, { minN: 5 });
  assert.equal(rep.trainN + rep.holdoutN, 50);
});

test("a side too small to judge is called thin rather than guessed at", () => {
  seq = 0;
  const rows = [...batch(300, 30, { exempt: 0 }), ...batch(6, 6, { exempt: 6 })];
  const rep = mine(rows, { minN: 40 });
  assert.equal(rep.findings.find((x) => x.label === "4+ exempt wallets")!.verdict, "thin");
});

test("every candidate is distinct, so nothing is counted twice against the multiple-testing budget", () => {
  const labels = candidates().map((c) => c.label);
  assert.equal(new Set(labels).size, labels.length);
});
