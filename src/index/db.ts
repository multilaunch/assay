import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The local copy of what the chain already told us.
 *
 * Every read on this board used to go back to the chain: open a chart and it is several getLogs,
 * open the holders and it is several more, and a backfill of two thousand launches was fifty
 * minutes of almost nothing but RPC. None of that is a query problem — it is the same ranges being
 * fetched again and again. So they are fetched once and kept.
 *
 * SQLite because Node 22 ships it: no service to run, no dependency to add, no second thing to back
 * up or secure, and a file that can be deleted and rebuilt from the chain whenever it is wrong. It
 * is flagged experimental in Node, which is a risk worth taking for a cache that is derived data by
 * construction. Two hundred thousand inserts measured at 99 ms and a range count at 1 ms; the row
 * counts here are in that league, not beyond it.
 *
 * The one invariant that matters: `cursor` is the last block whose logs are *completely* stored.
 * A refused range stops it dead rather than being stepped over, because a hole that nobody knows
 * about turns every count taken afterwards into a quiet lie.
 */

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS launches (
  token      TEXT PRIMARY KEY,
  curve      TEXT NOT NULL,
  deployer   TEXT NOT NULL,
  pair       TEXT NOT NULL,
  block      INTEGER NOT NULL,
  log_index  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS launches_block ON launches (block);
CREATE INDEX IF NOT EXISTS launches_deployer ON launches (deployer, block);

CREATE TABLE IF NOT EXISTS graduations (
  token TEXT PRIMARY KEY,
  block INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS graduations_block ON graduations (block);

-- one row per curve trade. side 1 is a buy, -1 a sell. price is pair units per whole token and
-- quote is what moved, both already netted of the fee and the opening tax.
CREATE TABLE IF NOT EXISTS trades (
  curve     TEXT NOT NULL,
  block     INTEGER NOT NULL,
  log_index INTEGER NOT NULL,
  side      INTEGER NOT NULL,
  price     REAL NOT NULL,
  quote     REAL NOT NULL,
  PRIMARY KEY (curve, block, log_index)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS trades_block ON trades (block);

-- sampled block timestamps. One per ingested chunk, not one per block: a chain at ten blocks a
-- second would need a million rows a day to store them all, and the answer in between two real
-- anchors an hour apart is good to a second or two, which is finer than any candle drawn from it.
CREATE TABLE IF NOT EXISTS blocks (
  number INTEGER PRIMARY KEY,
  ts     INTEGER NOT NULL
);
`;

let handle: DatabaseSync | null = null;
let ro: DatabaseSync | null = null;
let roTried = false;

export const dbPath = (): string =>
  resolve(process.env.ASSAY_DATA ?? resolve(process.cwd(), "data"), "index.sqlite");

export function db(): DatabaseSync {
  if (handle) return handle;
  const f = dbPath();
  mkdirSync(dirname(f), { recursive: true });
  const d = new DatabaseSync(f);
  // WAL so a reader is never blocked by the writer, and normal sync because losing the last few
  // blocks to a crash costs one catch-up rather than anything irreplaceable.
  d.exec("PRAGMA journal_mode = WAL");
  d.exec("PRAGMA synchronous = NORMAL");
  d.exec(SCHEMA);
  const have = Number(readMeta(d, "schema") ?? "0");
  if (have === 0) writeMeta(d, "schema", String(SCHEMA_VERSION));
  handle = d;
  return d;
}

/**
 * The same file, opened read-only, or null when there is no usable index.
 *
 * Everything that serves a page goes through here rather than through `db()`. The board must not
 * create this file, must not need a writable directory to start, and must not fail a chart because
 * a cache it does not depend on is missing — in a container the data volume may be absent entirely.
 * The failure is remembered so a missing index costs one syscall rather than one per request.
 */
export function reader(): DatabaseSync | null {
  if (ro || roTried) return ro;
  roTried = true;
  if (handle) { ro = handle; return ro; }
  try {
    if (!existsSync(dbPath())) return null;
    ro = new DatabaseSync(dbPath(), { readOnly: true });
  } catch { ro = null; }
  return ro;
}

/** For tests and for `index reset`: forget the open handles so the next call reopens. */
export function closeDb(): void {
  handle?.close();
  if (ro && ro !== handle) ro.close();
  handle = null;
  ro = null;
  roTried = false;
}

function readMeta(d: DatabaseSync, k: string): string | null {
  const row = d.prepare("SELECT v FROM meta WHERE k = ?").get(k) as { v?: string } | undefined;
  return row?.v ?? null;
}

function writeMeta(d: DatabaseSync, k: string, v: string): void {
  d.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
}

export const meta = {
  get: (k: string): string | null => readMeta(db(), k),
  set: (k: string, v: string): void => writeMeta(db(), k, v),
};

/**
 * The window the index can answer for: `[from, cursor]`.
 *
 * `from` is where ingestion started, because a database built from block N knows nothing before it
 * and must not pretend otherwise. Both null when nothing has been ingested.
 */
export function coverage(): { from: number | null; cursor: number | null } {
  const d = reader();
  if (!d) return { from: null, cursor: null };
  const from = readMeta(d, "from");
  const cursor = readMeta(d, "cursor");
  return { from: from === null ? null : Number(from), cursor: cursor === null ? null : Number(cursor) };
}

/** True when every block in the range has been stored, so a reader may skip the chain entirely. */
export function covers(fromBlock: bigint, toBlock: bigint): boolean {
  const { from, cursor } = coverage();
  if (from === null || cursor === null) return false;
  return Number(fromBlock) >= from && Number(toBlock) <= cursor;
}

export interface Stats {
  launches: number;
  graduations: number;
  trades: number;
  from: number | null;
  cursor: number | null;
  bytes: number;
}

export function stats(): Stats {
  const d = db();
  const one = (sql: string): number => Number((d.prepare(sql).get() as { n?: number } | undefined)?.n ?? 0);
  const { from, cursor } = coverage();
  const pages = one("SELECT page_count AS n FROM pragma_page_count()");
  const size = one("SELECT page_size AS n FROM pragma_page_size()");
  return {
    launches: one("SELECT count(*) AS n FROM launches"),
    graduations: one("SELECT count(*) AS n FROM graduations"),
    trades: one("SELECT count(*) AS n FROM trades"),
    from, cursor,
    bytes: pages * size,
  };
}
