import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkLimit } from "../src/board/limit.js";

/**
 * The thing being rationed is reaching the chain, so the tests are about the two ways a
 * budget goes wrong: letting one caller monopolise it, and charging an innocent one.
 */

test("a caller may hold only so many pieces of work at once", () => {
  const l = new WorkLimit({ inFlight: 3, burst: 100, refillPerSec: 100 });
  for (let i = 0; i < 3; i++) assert.equal(l.take("a").ok, true, `take ${i}`);
  const fourth = l.take("a");
  assert.equal(fourth.ok, false);
  assert.equal(fourth.ok === false && fourth.reason, "busy");
  l.done("a");
  assert.equal(l.take("a").ok, true, "a finished request frees the slot");
});

test("one caller filling the board does not touch another", () => {
  const l = new WorkLimit({ inFlight: 2, burst: 2, refillPerSec: 0 });
  assert.equal(l.take("noisy").ok, true);
  assert.equal(l.take("noisy").ok, true);
  assert.equal(l.take("noisy").ok, false);
  assert.equal(l.take("quiet").ok, true, "budgets are per caller, not shared");
});

test("the burst is spendable at once and then has to be earned back", () => {
  const l = new WorkLimit({ inFlight: 99, burst: 5, refillPerSec: 0.5 });
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) { assert.equal(l.take("a", t0).ok, true); l.done("a"); }
  const spent = l.take("a", t0);
  assert.equal(spent.ok, false);
  assert.equal(spent.ok === false && spent.reason, "rate");
  assert.equal(spent.ok === false && spent.retryAfterSec, 2, "half a token a second means two seconds for one");

  assert.equal(l.take("a", t0 + 1_900).ok, false, "not yet");
  assert.equal(l.take("a", t0 + 2_100).ok, true, "one token, one request");
});

test("the bucket refills to the burst and no further", () => {
  const l = new WorkLimit({ inFlight: 99, burst: 4, refillPerSec: 1 });
  const t0 = 1_000_000;
  l.take("a", t0); l.done("a");
  // an hour idle must not hand out an hour's worth of tokens
  assert.equal(l.peek("a")?.tokens, 3);
  l.take("a", t0 + 3_600_000); l.done("a");
  assert.equal(l.peek("a")?.tokens, 3, "capped at burst, then charged one");
});

test("a refused caller is charged nothing", () => {
  const l = new WorkLimit({ inFlight: 1, burst: 10, refillPerSec: 0 });
  const t0 = 1_000_000;
  l.take("a", t0);                        // one in flight, nine tokens left
  const before = l.peek("a")?.tokens;
  l.take("a", t0); l.take("a", t0);       // both refused for being busy
  assert.equal(l.peek("a")?.tokens, before, "being told to wait does not cost a token");
});

test("done() on a caller that holds nothing cannot go negative", () => {
  const l = new WorkLimit({ inFlight: 2, burst: 2, refillPerSec: 0 });
  l.done("ghost");
  l.done("ghost");
  assert.equal(l.peek("ghost"), null, "and does not invent one either");
  assert.equal(l.take("ghost").ok, true);
  l.done("ghost"); l.done("ghost"); l.done("ghost");
  assert.equal(l.peek("ghost")?.running, 0);
  assert.equal(l.take("ghost").ok, true, "still able to work, not stuck below zero");
});

test("idle callers are forgotten, but never one still holding a slot", () => {
  const l = new WorkLimit({ inFlight: 2, burst: 2, refillPerSec: 0, idleMs: 1000 });
  const t0 = 1_000_000;
  l.take("gone", t0); l.done("gone");
  l.take("holding", t0);                  // deliberately not finished
  // the sweep runs at most once a minute, so push past both it and the idle window
  l.take("other", t0 + 120_000);
  assert.equal(l.peek("gone"), null, "idle and empty-handed: forgotten");
  assert.equal(l.peek("holding")?.running, 1, "still working: kept, or its slot would leak");
});

test("the board has a ceiling of its own, so many callers cannot queue it to a standstill", () => {
  // the case the per-caller limit does not reach: one request each, from everywhere at once
  const l = new WorkLimit({ inFlight: 4, burst: 20, refillPerSec: 1, boardInFlight: 5 });
  for (let i = 0; i < 5; i++) assert.equal(l.take("caller" + i).ok, true, `caller ${i}`);
  const sixth = l.take("caller5");
  assert.equal(sixth.ok, false);
  assert.equal(sixth.ok === false && sixth.reason, "board", "refused by the board, not by their own budget");
  assert.equal(l.inFlight, 5);
  l.done("caller0");
  assert.equal(l.take("caller5").ok, true, "one finishing lets the next in");
});

test("a caller turned away at the board's ceiling is not even written down", () => {
  const l = new WorkLimit({ inFlight: 4, burst: 3, refillPerSec: 0, boardInFlight: 1 });
  l.take("busy");                       // the board is now full
  const r = l.take("waiting");
  assert.equal(r.ok === false && r.reason, "board");
  // Charged nothing, and no entry created: a flood from a hundred thousand unseen addresses
  // cannot grow the map either, which is the other way a limiter becomes the vulnerability.
  assert.equal(l.peek("waiting"), null);
  assert.equal(l.size, 1, "only the caller actually working is tracked");
  l.done("busy");
  const later = l.take("waiting");
  assert.equal(later.ok, true);
  assert.equal(l.peek("waiting")?.tokens, 2, "and arrives with a full burst, minus this one");
});

test("finishing returns the slot to the board as well as to the caller", () => {
  const l = new WorkLimit({ inFlight: 2, burst: 9, refillPerSec: 0, boardInFlight: 3 });
  l.take("a"); l.take("a"); l.take("b");
  assert.equal(l.inFlight, 3);
  assert.equal(l.take("c").ok, false);
  l.done("a"); l.done("b");
  assert.equal(l.inFlight, 1);
  assert.equal(l.take("c").ok, true);
});
