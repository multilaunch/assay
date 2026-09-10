import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The index is a cache of public data, so the tests are about the two ways a cache lies: claiming
 * to hold a range it does not, and dating a row wrong.
 */

// every module here reads ASSAY_DATA at call time, so the directory has to be set before the import
const dir = mkdtempSync(join(tmpdir(), "assay-index-"));
process.env.ASSAY_DATA = dir;
const { db, closeDb, coverage, covers, meta, prune, stats } = await import("../src/index/db.js");
const { curvePoint } = await import("../src/index/ingest.js");
const { timeOf, pointsFor, launchOf, launchesByDeployer } = await import("../src/index/read.js");

process.on("exit", () => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

const seed = () => {
  const d = db();
  d.exec("DELETE FROM trades; DELETE FROM launches; DELETE FROM graduations; DELETE FROM blocks; DELETE FROM meta");
  meta.set("from", "1000");
  meta.set("cursor", "2000");
};

test("a range outside what was ingested gets no answer rather than a short one", () => {
  seed();
  assert.equal(covers(1000n, 2000n), true);
  assert.equal(covers(999n, 2000n), false, "before the start of ingestion");
  assert.equal(covers(1000n, 2001n), false, "past the cursor");
  assert.equal(pointsFor("0xcurve", 900, 2000), null);
});

test("with nothing ingested the index answers nothing at all", () => {
  const d = db();
  d.exec("DELETE FROM meta");
  closeDb();
  assert.deepEqual(coverage(), { from: null, cursor: null });
  assert.equal(covers(0n, 1n), false);
});

test("a block between two seals is dated by interpolating them", () => {
  const list = [{ number: 100, ts: 1_000_000 }, { number: 200, ts: 1_010_000 }];
  assert.equal(timeOf(100, list), 1_000_000);
  assert.equal(timeOf(200, list), 1_010_000);
  assert.equal(timeOf(150, list), 1_005_000);
  // outside the sampled span it extrapolates at the nearest measured rate rather than clamping
  assert.equal(timeOf(250, list), 1_015_000);
  assert.equal(timeOf(50, list), 995_000);
});

test("with no seals at all there is no time axis, and the reader says so", () => {
  assert.equal(timeOf(100, []), null);
  assert.equal(timeOf(100, [{ number: 7, ts: 42 }]), 42);
});

test("a trade's price is netted of the fee and the opening tax", () => {
  // a snipe inside the 99% window: 100 in, 99 taxed away, 1 of value for 2 tokens
  const buy = curvePoint("CurveBuy", { quoteIn: 100n, fee: 0n, tax: 99n, tokensOut: 2n });
  assert.equal(buy?.p, 0.5, "the price is what reached the curve, not what the buyer paid");
  assert.equal(buy?.side, 1);

  const sell = curvePoint("CurveSell", { tokensIn: 4n, quoteOut: 1n, fee: 1n, tax: 2n });
  assert.equal(sell?.p, 1, "a sale is priced before the cut was taken out of it");
  assert.equal(sell?.side, -1);
});

test("a trade that cannot be priced is dropped instead of becoming a zero", () => {
  assert.equal(curvePoint("CurveBuy", { quoteIn: 100n, fee: 0n, tax: 100n, tokensOut: 2n }), null, "wholly taxed");
  assert.equal(curvePoint("CurveBuy", { quoteIn: 100n, fee: 0n, tax: 0n, tokensOut: 0n }), null, "no tokens out");
  assert.equal(curvePoint("CurveSell", { tokensIn: 0n, quoteOut: 5n, fee: 0n, tax: 0n }), null);
  assert.equal(curvePoint("Transfer", { value: 1n }), null, "not a curve trade at all");
});

test("re-ingesting a range writes nothing twice", () => {
  seed();
  const d = db();
  const ins = d.prepare("INSERT OR IGNORE INTO trades (curve, block, log_index, side, price, quote) VALUES (?, ?, ?, ?, ?, ?)");
  for (let i = 0; i < 2; i++) ins.run("0xc", 1500, 3, 1, 0.5, 10);
  assert.equal(stats().trades, 1);

  const lin = d.prepare("INSERT OR IGNORE INTO launches (token, curve, deployer, pair, block, log_index) VALUES (?, ?, ?, ?, ?, ?)");
  lin.run("0xt", "0xc", "0xd", "0xp", 1400, 0);
  lin.run("0xt", "0xc", "0xd", "0xp", 1400, 0);
  assert.equal(stats().launches, 1);
});

test("a stored launch comes back with its graduation, and an unknown one comes back null", () => {
  seed();
  const d = db();
  d.prepare("INSERT INTO launches (token, curve, deployer, pair, block, log_index) VALUES (?, ?, ?, ?, ?, ?)").run("0xaa", "0xc1", "0xdead", "0xp", 1100, 0);
  d.prepare("INSERT INTO launches (token, curve, deployer, pair, block, log_index) VALUES (?, ?, ?, ?, ?, ?)").run("0xbb", "0xc2", "0xdead", "0xp", 1200, 0);
  d.prepare("INSERT INTO graduations (token, block) VALUES (?, ?)").run("0xbb", 1900);

  assert.equal(launchOf("0xaa" as `0x${string}`)?.graduatedAt, null);
  assert.equal(launchOf("0xbb" as `0x${string}`)?.graduatedAt, 1900);
  assert.equal(launchOf("0xcc" as `0x${string}`), null);

  const byDev = launchesByDeployer("0xDEAD");
  assert.equal(byDev.length, 2, "the lookup is case-insensitive on the address");
  assert.deepEqual(byDev.map((r) => r.token), ["0xbb", "0xaa"], "newest first");
});

test("trades come back in chain order and dated from the seals", () => {
  seed();
  const d = db();
  d.prepare("INSERT INTO blocks (number, ts) VALUES (?, ?)").run(1000, 1_000_000);
  d.prepare("INSERT INTO blocks (number, ts) VALUES (?, ?)").run(2000, 1_100_000);
  const ins = d.prepare("INSERT INTO trades (curve, block, log_index, side, price, quote) VALUES (?, ?, ?, ?, ?, ?)");
  ins.run("0xc", 1500, 2, 1, 5, 10);
  ins.run("0xc", 1500, 1, -1, 4, 20);
  ins.run("0xc", 1200, 0, 1, 3, 30);
  ins.run("0xother", 1300, 0, 1, 99, 1);

  const pts = pointsFor("0xC", 1000, 2000);
  assert.ok(pts);
  assert.deepEqual(pts.map((x) => x.p), [3, 4, 5], "ordered by block then log index, and only this curve");
  assert.equal(pts[0]!.t, 1_020_000);
  assert.equal(pts[1]!.t, 1_050_000);
});

test("pruning moves the start of coverage, so a trimmed range reads as missing not as empty", () => {
  seed();
  const d = db();
  const ins = d.prepare("INSERT INTO trades (curve, block, log_index, side, price, quote) VALUES (?, ?, ?, ?, ?, ?)");
  for (const b of [1100, 1400, 1700, 1950]) ins.run("0xc", b, 0, 1, 1, 1);
  d.prepare("INSERT INTO launches (token, curve, deployer, pair, block, log_index) VALUES (?, ?, ?, ?, ?, ?)").run("0xt", "0xc", "0xd", "0xp", 1100, 0);
  d.prepare("INSERT INTO blocks (number, ts) VALUES (?, ?)").run(1000, 1_000_000);
  d.prepare("INSERT INTO blocks (number, ts) VALUES (?, ?)").run(2000, 1_100_000);

  // cursor is 2000, so keeping 500 blocks leaves everything from 1500 on
  const r = prune(500);
  assert.equal(r?.from, 1500);
  assert.equal(stats().trades, 2, "1100 and 1400 are gone");
  assert.equal(stats().launches, 0, "the launch went with them");
  assert.equal(coverage().from, 1500, "and coverage says so");
  assert.equal(pointsFor("0xc", 1000, 2000), null, "the old range is refused rather than half-answered");
  assert.ok(pointsFor("0xc", 1500, 2000), "what survived still reads");
});

test("pruning shallower than what is held does nothing", () => {
  seed();
  db().prepare("INSERT INTO trades (curve, block, log_index, side, price, quote) VALUES (?, ?, ?, ?, ?, ?)").run("0xc", 1100, 0, 1, 1, 1);
  assert.equal(prune(5000), null, "the depth is deeper than the index is old");
  assert.equal(stats().trades, 1);
  assert.equal(coverage().from, 1000);
});
