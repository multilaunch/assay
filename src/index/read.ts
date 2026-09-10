import type { Address } from "viem";
import { covers, coverage, reader } from "./db.js";

/**
 * Questions the index can answer without the chain, and an honest no when it cannot.
 *
 * Every function here returns null rather than a partial answer when the range it needs falls
 * outside what has been ingested. A cache that quietly serves less than it was asked for is worse
 * than no cache: the chart shortens, the holder count drops, and nothing on screen says why.
 */

export interface IndexPoint { t: number; p: number; vol: number; side: 1 | -1 }

interface Anchor { number: number; ts: number }

let anchors: Anchor[] = [];
let anchorsAt = 0;

/** The sampled seals, cached briefly: ingestion adds one per chunk, not one per block. */
function loadAnchors(): Anchor[] {
  if (Date.now() - anchorsAt < 5_000 && anchors.length) return anchors;
  const d = reader();
  if (!d) return [];
  anchors = d.prepare("SELECT number, ts FROM blocks ORDER BY number").all() as unknown as Anchor[];
  anchorsAt = Date.now();
  return anchors;
}

/**
 * Unix ms for a block, interpolated between the two real seals either side of it.
 *
 * Between anchors this is linear, which is exactly right on a chain that seals every hundred
 * milliseconds and only wrong across a halt — and a halt is visible in the anchors themselves, so
 * the error stays inside the range that actually stalled instead of smearing over the whole chart.
 * Outside the anchors it extrapolates at the nearest measured rate, and says so by having none.
 */
export function timeOf(block: number, list = loadAnchors()): number | null {
  if (list.length === 0) return null;
  if (list.length === 1) return list[0]!.ts;

  let lo = 0;
  let hi = list.length - 1;
  if (block <= list[0]!.number) { lo = 0; hi = 1; }
  else if (block >= list[hi]!.number) { lo = hi - 1; }
  else {
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.number <= block) lo = mid; else hi = mid;
    }
  }
  const a = list[lo]!;
  const b = list[lo + 1] ?? list[lo]!;
  const dn = b.number - a.number;
  if (dn <= 0) return a.ts;
  return a.ts + ((block - a.number) * (b.ts - a.ts)) / dn;
}

export interface LaunchRow {
  token: string;
  curve: string;
  deployer: string;
  pair: string;
  block: number;
  graduatedAt: number | null;
}

/** The launch record, or null when the index has not reached it. */
export function launchOf(token: Address): LaunchRow | null {
  const d = reader();
  if (!d) return null;
  const row = d.prepare(
    `SELECT l.token, l.curve, l.deployer, l.pair, l.block, g.block AS graduatedAt
       FROM launches l LEFT JOIN graduations g ON g.token = l.token
      WHERE l.token = ?`,
  ).get(token.toLowerCase()) as LaunchRow | undefined;
  return row ?? null;
}

/**
 * Every curve trade for one launch, timed.
 *
 * Null when the index does not cover the launch's whole life so far, because a chart missing its
 * first hour looks like a launch that opened flat rather than one we did not watch.
 */
export function pointsFor(curve: string, fromBlock: number, toBlock: number): IndexPoint[] | null {
  const d = reader();
  if (!d) return null;
  if (!covers(BigInt(fromBlock), BigInt(toBlock))) return null;
  const list = loadAnchors();
  const rows = d.prepare(
    "SELECT block, log_index, side, price, quote FROM trades WHERE curve = ? AND block BETWEEN ? AND ? ORDER BY block, log_index",
  ).all(curve.toLowerCase(), fromBlock, toBlock) as { block: number; side: number; price: number; quote: number }[];

  const out: IndexPoint[] = [];
  for (const r of rows) {
    const t = timeOf(r.block, list);
    if (t === null) return null; // no anchors means no honest x axis
    out.push({ t, p: r.price, vol: r.quote, side: r.side >= 0 ? 1 : -1 });
  }
  return out;
}

/** Launches by one deployer that the index has seen, newest first. */
export function launchesByDeployer(deployer: string, limit = 200): LaunchRow[] {
  const d = reader();
  if (!d) return [];
  return d.prepare(
    `SELECT l.token, l.curve, l.deployer, l.pair, l.block, g.block AS graduatedAt
       FROM launches l LEFT JOIN graduations g ON g.token = l.token
      WHERE l.deployer = ? ORDER BY l.block DESC LIMIT ?`,
  ).all(deployer.toLowerCase(), limit) as unknown as LaunchRow[];
}

/**
 * The graduation rate over the ingested window, and the two counts behind it.
 *
 * This is the number the whole scoring system is calibrated against, and until now it came from a
 * one-off scan that took the better part of an hour. Here it is a count over rows.
 */
export function baseRate(): { launches: number; graduated: number; rate: number; from: number | null; to: number | null } | null {
  const { from, cursor } = coverage();
  if (from === null || cursor === null) return null;
  const d = reader();
  if (!d) return null;
  const n = (sql: string): number => Number((d.prepare(sql).get() as { n?: number } | undefined)?.n ?? 0);
  const launches = n("SELECT count(*) AS n FROM launches");
  const graduated = n("SELECT count(*) AS n FROM graduations");
  return { launches, graduated, rate: launches > 0 ? graduated / launches : 0, from, to: cursor };
}
