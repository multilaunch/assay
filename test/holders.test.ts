import assert from "node:assert/strict";
import { test } from "node:test";
import { foldTransfers } from "../src/board/holders.js";

const Z = "0x0000000000000000000000000000000000000000";
const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const C = "0x00000000000000000000000000000000000000cc";

test("a mint is not a wallet sending anything", () => {
  const bal = foldTransfers([{ from: Z, to: A, value: 1000n }]);
  assert.equal(bal.get(A.toLowerCase()), 1000n);
  assert.equal(bal.has(Z), false, "the zero address must never appear as a holder");
});

test("a burn removes supply rather than crediting the zero address", () => {
  const bal = foldTransfers([{ from: Z, to: A, value: 1000n }, { from: A, to: Z, value: 400n }]);
  assert.equal(bal.get(A.toLowerCase()), 600n);
  assert.equal(bal.has(Z), false);
  assert.equal([...bal.values()].reduce((s, v) => s + v, 0n), 600n);
});

test("balances follow the whole chain of transfers", () => {
  const bal = foldTransfers([
    { from: Z, to: A, value: 1000n },   // mint to the curve
    { from: A, to: B, value: 300n },    // a buy
    { from: A, to: C, value: 200n },    // another
    { from: B, to: C, value: 100n },    // B sells to C directly
  ]);
  assert.equal(bal.get(A.toLowerCase()), 500n);
  assert.equal(bal.get(B.toLowerCase()), 200n);
  assert.equal(bal.get(C.toLowerCase()), 300n);
  assert.equal([...bal.values()].reduce((s, v) => s + v, 0n), 1000n, "supply must be conserved");
});

test("a wallet that sold everything is not a holder of zero", () => {
  const bal = foldTransfers([{ from: Z, to: A, value: 100n }, { from: A, to: B, value: 100n }]);
  assert.equal(bal.has(A.toLowerCase()), false);
  assert.equal(bal.size, 1);
});

test("addresses are folded case-insensitively", () => {
  const bal = foldTransfers([
    { from: Z, to: "0x00000000000000000000000000000000000000AA", value: 50n },
    { from: Z, to: "0x00000000000000000000000000000000000000aa", value: 50n },
  ]);
  assert.equal(bal.size, 1);
  assert.equal(bal.get(A.toLowerCase()), 100n);
});

test("no transfers is no holders, not a crash", () => {
  assert.equal(foldTransfers([]).size, 0);
});
