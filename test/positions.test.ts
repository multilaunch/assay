import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Address } from "viem";
import { allPositions, closeWithExit, openPosition, openPositions, updatePosition, type Exit } from "../src/trade/positions.js";

const A = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;

/** positions.ts resolves the file on every call, so a temporary ASSAY_DATA is enough to keep the suite off the real ledger. */
function withData<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "assay-positions-"));
  const before = process.env.ASSAY_DATA;
  process.env.ASSAY_DATA = dir;
  try {
    return run(dir);
  } finally {
    if (before === undefined) delete process.env.ASSAY_DATA;
    else process.env.ASSAY_DATA = before;
    rmSync(dir, { recursive: true, force: true });
  }
}

const entry = (symbol: string) => ({
  token: A(1), curve: A(2), symbol, name: symbol, pairSymbol: "ETH", pairDecimals: 18,
  openedAt: 1_700_000_000, dryRun: true, entryQuote: (10n ** 16n).toString(), tokens: (10n ** 21n).toString(),
});

const exit = (reason: string): Exit => ({ at: 1_700_000_100, tokens: "1", quoteOut: "2", reason, dryRun: true });

test("no ledger yet is an empty ledger", () => {
  withData(() => {
    assert.deepEqual(allPositions(), []);
    assert.deepEqual(openPositions(), []);
  });
});

test("open, update and read back", () => {
  withData(() => {
    const a = openPosition(entry("AAA"));
    const b = openPosition(entry("BBB"));
    assert.equal(a.status, "open");
    assert.deepEqual(a.exits, []);
    assert.equal(a.lastQuote, a.entryQuote);
    assert.equal(a.peakQuote, a.entryQuote);
    assert.equal(allPositions().length, 2);

    assert.equal(updatePosition(a.id, { lastQuote: "5", peakQuote: "7" })?.peakQuote, "7");
    assert.equal(allPositions().find((p) => p.id === a.id)?.lastQuote, "5");
    assert.equal(allPositions().find((p) => p.id === b.id)?.lastQuote, b.entryQuote, "a write for one position must not touch another");

    updatePosition(b.id, { status: "closed" });
    assert.deepEqual(openPositions().map((p) => p.id), [a.id]);
    assert.equal(updatePosition("nosuchposition", { status: "closed" }), null);
  });
});

test("closing appends to the exits on disk, not to a copy captured before the sell", () => {
  withData(() => {
    const p = openPosition(entry("AAA"));
    closeWithExit(p.id, exit("stop loss"), "3");
    closeWithExit(p.id, exit("closed by hand"), "4");
    const after = allPositions().find((x) => x.id === p.id)!;
    assert.deepEqual(after.exits.map((e) => e.reason), ["stop loss", "closed by hand"]);
    assert.equal(after.status, "closed");
    assert.equal(after.lastQuote, "4");
    assert.equal(closeWithExit("nosuchposition", exit("stop loss"), "1"), null);
  });
});

test("a corrupt ledger is moved aside, never overwritten with what is left of it", () => {
  withData((dir) => {
    const f = join(dir, "positions.json");
    // a half-written file: the two positions in it are tokens the engine is holding
    const truncated = JSON.stringify([{ id: "held1", symbol: "AAA" }, { id: "held2", symbol: "BBB" }]).slice(0, 40);
    writeFileSync(f, truncated);

    assert.throws(() => openPosition(entry("NEW")), /could not be read/);
    assert.equal(existsSync(f), false, "the ledger must not survive as the one entry that was just opened");

    const aside = readdirSync(dir).filter((n) => n.startsWith("positions.json.corrupt-"));
    assert.equal(aside.length, 1, "the unreadable file has to end up somewhere a human can look at it");
    assert.equal(readFileSync(join(dir, aside[0]!), "utf8"), truncated);

    assert.deepEqual(allPositions(), [], "with the bad file out of the way the next run starts clean");
  });
});

test("a ledger that parses but is not a list of positions is corrupt too", () => {
  withData((dir) => {
    writeFileSync(join(dir, "positions.json"), '{"positions":[]}');
    assert.throws(() => allPositions(), /not an array/);
  });
});
