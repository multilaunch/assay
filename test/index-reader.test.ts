import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The board's read-only view of the index, from the side of the process that does not write it.
 * Both failures below were reproduced before they were fixed; see work/tasks/002.
 */

const dir = mkdtempSync(join(tmpdir(), "assay-reader-"));
process.env.ASSAY_DATA = dir;
const { coverage, recheckReader } = await import("../src/index/db.js");
const file = join(dir, "index.sqlite");
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

/** The indexer, which in production is a different process with a handle of its own. */
function writeIndex(from: number, cursor: number): DatabaseSync {
  const w = new DatabaseSync(file);
  w.exec("PRAGMA journal_mode = WAL");
  w.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  w.prepare("INSERT INTO meta (k, v) VALUES ('from', ?), ('cursor', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(from), String(cursor));
  return w;
}

test("a board that looked before the index existed finds it once it does", () => {
  recheckReader();
  assert.deepEqual(coverage(), { from: null, cursor: null }, "nothing there yet");

  const w = writeIndex(100, 200);
  recheckReader();
  assert.deepEqual(coverage(), { from: 100, cursor: 200 },
    "it used to decide there was no index and never ask again until a restart");
  w.close();
});

test("after the index is deleted and rebuilt, the board reads the new file and not the old one", () => {
  const old = writeIndex(100, 999);
  recheckReader();
  assert.equal(coverage().cursor, 999);
  old.close();

  // `assay index reset`, then the follower starts a fresh file at the same path
  for (const s of ["", "-wal", "-shm"]) rmSync(file + s, { force: true });
  const fresh = writeIndex(5000, 6000);
  recheckReader();
  assert.deepEqual(coverage(), { from: 5000, cursor: 6000 },
    "it used to keep reading the deleted file through a handle to its inode, frozen, silently");
  fresh.close();
});

test("when the file goes away the board says there is no index rather than serving the last one", () => {
  const w = writeIndex(1, 2);
  recheckReader();
  assert.equal(coverage().cursor, 2);
  w.close();
  for (const s of ["", "-wal", "-shm"]) rmSync(file + s, { force: true });
  recheckReader();
  assert.deepEqual(coverage(), { from: null, cursor: null });
});
