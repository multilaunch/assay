import type { Address } from "viem";
import type { DeployerRecord } from "../pons/deployers.js";
import { factoryAbi } from "../abi/pons.js";
import { client } from "../chain/clients.js";
import { DEAD, PONS } from "../chain/config.js";
import { toLaunch, type LaunchEvent } from "../pons/detect.js";
import { devSharePct, enrichLaunch } from "../pons/enrich.js";
import { FarmDetector } from "../pons/farm.js";
import { scoreLaunch } from "../score/score.js";
import { MATURE_MS } from "./accuracy.js";
import { all, record, type Entry } from "./journal.js";

/**
 * Scoring launches that already happened, so `accuracy` says something on the first day instead of
 * on the third.
 *
 * The obvious way to do this is also worthless: score an old launch against the chain as it looks
 * now and the deployer's record already contains the launches that came after, the farm already has
 * its twins, and the number that comes out is a report on hindsight. So the window is walked
 * forwards, oldest first, and every input is reconstructed as of the block the launch was in — the
 * deployer's prior launches, how many of those had graduated *by then*, and the farm fingerprints
 * seen before it. A backfilled row is scored on strictly less information than a live one, never
 * more.
 *
 * One thing is read as it is now and cannot be otherwise: whether the curve answers at all, which
 * is worth −10 when it does not. Curves do not stop answering, so in practice this costs backfilled
 * rows nothing and live rows the occasional penalty — the bias, such as it is, runs against the
 * backfill.
 */

const LAUNCHED = factoryAbi.find((x) => x.type === "event" && x.name === "TokenLaunched")!;
const GRADUATED = factoryAbi.find((x) => x.type === "event" && x.name === "PoolGraduated")!;

/** What one getLogs will serve here. The official endpoint refuses much more than this. */
const CHUNK = 20_000n;

/** How far back to look for graduations that predate the sample, for the deployer's record. */
const HISTORY = 400_000n;

export interface BackfillResult {
  /** launches found in the sampled window */
  found: number;
  /** written to the journal */
  added: number;
  /** already in the journal from a live session or an earlier run */
  known: number;
  /** log ranges the RPC would not serve; the sample is that much thinner than it looks */
  failedChunks: number;
  chunks: number;
  from: number | null;
  to: number | null;
}

type Logs = { logs: unknown[]; chunks: number; failed: number };

/** getLogs over a range, in pieces, counting what was refused instead of pretending it was empty. */
async function logsOver(event: unknown, from: bigint, to: bigint): Promise<Logs> {
  const out: unknown[] = [];
  let chunks = 0;
  let failed = 0;
  for (let lo = from; lo <= to; lo += CHUNK) {
    const hi = lo + CHUNK - 1n > to ? to : lo + CHUNK - 1n;
    chunks++;
    try {
      const part = await client.getLogs({ address: PONS.factory, event: event as never, fromBlock: lo, toBlock: hi });
      out.push(...part);
    } catch { failed++; }
  }
  return { logs: out, chunks, failed };
}

/**
 * Seconds per block, measured rather than assumed, so the maturity offset is right on a slow day.
 *
 * Both samples sit well behind the head: the endpoint that answered getBlockNumber is not always
 * the one that serves the next call, and asking a node one block behind for the tip is an error,
 * not a slow answer.
 */
async function blockClock(head: bigint, span = 10_000n): Promise<{ secs: number; at: (block: bigint) => number }> {
  const near = head > 200n ? head - 200n : 0n;
  const far = near > span ? near - span : 0n;
  let secs = 0.1;
  let anchor = { block: near, ms: Date.now() };
  if (near !== far) {
    try {
      const [a, b] = await Promise.all([client.getBlock({ blockNumber: far }), client.getBlock({ blockNumber: near })]);
      const dt = Number(b.timestamp - a.timestamp);
      const dn = Number(near - far);
      if (dn > 0 && dt > 0) secs = dt / dn;
      anchor = { block: near, ms: Number(b.timestamp) * 1000 };
    } catch { /* the estimate below is still better than pretending a launch happened just now */ }
  }
  return { secs, at: (block) => anchor.ms - Number(anchor.block - block) * secs * 1000 };
}

/**
 * The deployer's record as it stood at `block`, not as it stands now.
 *
 * The whole backfill turns on this one function. A token that graduated *after* the launch being
 * scored is not evidence the scorer could have had, and counting it is how a reconstruction quietly
 * becomes a report on hindsight. A token with no graduation recorded has not graduated at all.
 */
export function recordAsOf(priorTokens: readonly Address[], graduatedAt: ReadonlyMap<string, bigint>, block: bigint): DeployerRecord {
  let graduated = 0;
  for (const t of priorTokens) {
    const at = graduatedAt.get(t.toLowerCase());
    if (at !== undefined && at < block) graduated++;
  }
  return { prior: priorTokens.length, graduated };
}

export interface BackfillOptions {
  /** how many launches to reconstruct, newest mature ones first */
  limit?: number;
  /** give up widening the search after this many blocks */
  maxScan?: bigint;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Reconstructs and journals up to `limit` launches that are already old enough to judge.
 *
 * Launches younger than MATURE_MS are skipped: their outcome is not decided yet, and a row that can
 * never be resolved is dead weight in every rate.
 */
export async function backfill(opts: BackfillOptions = {}): Promise<BackfillResult> {
  const limit = opts.limit ?? 400;
  const maxScan = opts.maxScan ?? 300_000n;

  const head = await client.getBlockNumber();
  const clock = await blockClock(head);
  const matureBlocks = BigInt(Math.ceil(MATURE_MS / 1000 / clock.secs));
  const to = head > matureBlocks ? head - matureBlocks : 0n;
  if (to === 0n) return { found: 0, added: 0, known: 0, failedChunks: 0, chunks: 0, from: null, to: null };

  // Widen backwards until there are enough launches to be worth reporting on.
  let chunks = 0;
  let failed = 0;
  let events: LaunchEvent[] = [];
  let from = to;
  while (events.length < limit && to - from < maxScan && from > 0n) {
    const next = from > CHUNK ? from - CHUNK : 0n;
    const r = await logsOver(LAUNCHED, next, from > 0n ? from - 1n : 0n);
    chunks += r.chunks;
    failed += r.failed;
    events = [...r.logs.map((l) => toLaunch(l as never)).filter((x): x is LaunchEvent => x !== null), ...events];
    from = next;
  }
  events.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber)));
  if (events.length > limit) events = events.slice(events.length - limit);
  if (events.length === 0) return { found: 0, added: 0, known: 0, failedChunks: failed, chunks, from: null, to: null };

  // Graduations from well before the sample, because a deployer's record at the time includes
  // launches older than the window we are scoring.
  const gradFrom = events[0]!.blockNumber > HISTORY ? events[0]!.blockNumber - HISTORY : 0n;
  const g = await logsOver(GRADUATED, gradFrom, head);
  chunks += g.chunks;
  failed += g.failed;
  const graduatedAt = new Map<string, bigint>();
  for (const l of g.logs as { args?: { token?: Address }; blockNumber: bigint }[]) {
    const tok = l.args?.token?.toLowerCase();
    if (tok && !graduatedAt.has(tok)) graduatedAt.set(tok, l.blockNumber);
  }

  // Launches from before the sample too, for the same reason: the prior count has to be a count of
  // everything that came earlier, not of everything inside our slice.
  const priorLogs = await logsOver(LAUNCHED, gradFrom, events[0]!.blockNumber - 1n);
  chunks += priorLogs.chunks;
  failed += priorLogs.failed;
  const byDeployer = new Map<string, Address[]>();
  const push = (dep: string, token: Address) => {
    const list = byDeployer.get(dep);
    if (list) list.push(token);
    else byDeployer.set(dep, [token]);
  };
  const earlier = priorLogs.logs.map((l) => toLaunch(l as never)).filter((x): x is LaunchEvent => x !== null);
  earlier.sort((a, b) => Number(a.blockNumber - b.blockNumber));
  for (const e of earlier) push(e.deployer.toLowerCase(), e.token);

  const journaled = new Set((await all()).map((e) => e.token.toLowerCase()));
  const farms = new FarmDetector();
  let added = 0;
  let known = 0;
  let first: number | null = null;
  let last: number | null = null;

  for (const [i, ev] of events.entries()) {
    opts.onProgress?.(i, events.length);
    const dep = ev.deployer.toLowerCase();

    // Read the deployer's record before this launch joins it, exactly as the live path would.
    const deployer = recordAsOf(byDeployer.get(dep) ?? [], graduatedAt, ev.blockNumber);
    push(dep, ev.token);

    if (journaled.has(ev.token.toLowerCase())) { known++; continue; }

    const intel = await enrichLaunch(ev, DEAD, { retries: 2, retryDelayMs: 300 });
    // The curve knows exactly when it opened. When it will not say — a swept curve, a refused read —
    // the block it launched in still does, near enough. Stamping the row with the current time
    // instead would make a six-hour-old launch look too young to judge and drop it from every rate.
    const t = intel.curve?.launchedAt ? intel.curve.launchedAt * 1000 : Math.round(clock.at(ev.blockNumber));
    const { twins } = farms.observe(intel, t);
    const score = scoreLaunch(intel, { deployer, farmTwins: twins });

    const entry: Entry = {
      t, token: ev.token, curve: ev.curve, deployer: ev.deployer,
      symbol: intel.meta?.symbol ?? null, score: score.total, verdict: score.verdict,
      devPct: intel.tx ? devSharePct(intel.tx) : null,
      taxBps: intel.record ? Number(intel.record.creatorTaxBps) : null,
      exempt: intel.tx?.exemptions.length ?? null,
      farmTwins: twins,
      deployerPrior: deployer.prior, deployerGraduated: deployer.graduated,
      pair: intel.pair.symbol, pairNative: intel.pair.native,
      source: "backfill",
    };
    record(entry);
    added++;
    if (first === null || t < first) first = t;
    if (last === null || t > last) last = t;
  }
  opts.onProgress?.(events.length, events.length);

  return { found: events.length, added, known, failedChunks: failed, chunks, from: first, to: last };
}
