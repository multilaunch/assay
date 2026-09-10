import { parseEventLogs, type Address, type Log } from "viem";
import { curveAbi, factoryAbi } from "../abi/pons.js";
import { client } from "../chain/clients.js";
import { PONS } from "../chain/config.js";
import { db, meta } from "./db.js";

/**
 * One pass along the chain, writing down what it says, so nothing has to ask twice.
 *
 * The saving is not in the queries — it is in not making them. A chart used to be one getLogs per
 * chunk per token, holders another set, the farm view another, and a backfill of two thousand
 * launches spent almost its whole runtime waiting on ranges it had already fetched for something
 * else. Here every range is fetched once, for every token at once.
 *
 * That last part is what makes it cheap. `CurveBuy` and `CurveSell` are filtered by topic and not
 * by address, so a single getLogs covers every curve alive in that range rather than one call per
 * launch. The price of doing that is that anyone may emit a log with the same topic from a contract
 * of their own — so an event is kept only when its emitter is a curve this index saw the factory
 * announce. Without that check a stranger could write any price they liked into our chart.
 *
 * It also rests on one endpoint. Of the two we use, publicnode refuses an address-less getLogs
 * outright — "please specify an address in your request" — so the whole-chain pass exists only
 * because rpc.mainnet.chain.robinhood.com allows it. If that changes, this falls back to being one
 * call per curve, which is what the on-demand path already does.
 */

const LAUNCHED = factoryAbi.find((x) => x.type === "event" && x.name === "TokenLaunched")!;
const GRADUATED = factoryAbi.find((x) => x.type === "event" && x.name === "PoolGraduated")!;
const BUY = curveAbi.find((x) => x.type === "event" && x.name === "CurveBuy")!;
const SELL = curveAbi.find((x) => x.type === "event" && x.name === "CurveSell")!;

/**
 * How wide a range to ask for.
 *
 * The endpoint's real limit is not a block count — it is ten thousand matched logs, and it says so
 * plainly ("logs matched by query exceeds limit of 10000") rather than quietly returning the first
 * ten thousand, which is the failure that would have been hard to notice. So the width is steered
 * by how many logs the last range actually returned, aiming at somewhat over half the ceiling, and
 * only falls back to halving when a request is refused outright.
 */
const CHUNK = 10_000n;
const MIN_CHUNK = 250n;
const LOG_LIMIT = 10_000;
const AIM = 0.6;

export interface Progress {
  block: number;
  head: number;
  launches: number;
  graduations: number;
  trades: number;
  /** ranges the endpoint refused even at the smallest size; above zero the cursor stopped */
  stalled: number;
}

export interface IngestOptions {
  /** where to begin when the index is empty. Default: 400 000 blocks back, the window the board uses. */
  from?: bigint;
  /** stop here instead of at the head, for a bounded catch-up */
  to?: bigint;
  /** keep going after reaching the head */
  follow?: boolean;
  /** how long to wait at the head before asking again */
  idleMs?: number;
  /** widest block range to ask for. Halved on refusal, restored when the endpoint recovers. */
  chunk?: bigint;
  onProgress?: (p: Progress) => void;
  onError?: (where: string, err: unknown) => void;
}

const DEFAULT_WINDOW = 400_000n;

/** Curves the factory has announced. Held in memory because every trade row is checked against it. */
function loadCurves(): Map<string, string> {
  const rows = db().prepare("SELECT curve, token FROM launches").all() as { curve: string; token: string }[];
  return new Map(rows.map((r) => [r.curve, r.token]));
}

interface Writers {
  launch: ReturnType<ReturnType<typeof db>["prepare"]>;
  graduation: ReturnType<ReturnType<typeof db>["prepare"]>;
  trade: ReturnType<ReturnType<typeof db>["prepare"]>;
  block: ReturnType<ReturnType<typeof db>["prepare"]>;
}

function writers(): Writers {
  const d = db();
  return {
    // a re-ingested range must be harmless: every write is idempotent on its natural key
    launch: d.prepare("INSERT OR IGNORE INTO launches (token, curve, deployer, pair, block, log_index) VALUES (?, ?, ?, ?, ?, ?)"),
    graduation: d.prepare("INSERT OR IGNORE INTO graduations (token, block) VALUES (?, ?)"),
    trade: d.prepare("INSERT OR IGNORE INTO trades (curve, block, log_index, side, price, quote) VALUES (?, ?, ?, ?, ?, ?)"),
    block: d.prepare("INSERT OR IGNORE INTO blocks (number, ts) VALUES (?, ?)"),
  };
}

/**
 * Price and size out of one curve event, netted of the fee and the opening tax.
 *
 * Shared with the on-demand path in board/candles.ts so there is one definition of the rule rather
 * than two that drift. Netting is not cosmetic: inside the opening window the tax is 99%, and what
 * a sniper paid is a hundred times the price the curve was actually at.
 */
export function curvePoint(name: string, args: Record<string, unknown>): { side: 1 | -1; p: number; vol: number } | null {
  const n = (k: string): bigint => (typeof args[k] === "bigint" ? (args[k] as bigint) : 0n);
  if (name === "CurveBuy") {
    const net = n("quoteIn") - n("fee") - n("tax");
    const out = n("tokensOut");
    if (out === 0n || net <= 0n) return null;
    return { side: 1, p: Number(net) / Number(out), vol: Number(net) };
  }
  if (name === "CurveSell") {
    const inn = n("tokensIn");
    if (inn === 0n) return null;
    const gross = n("quoteOut") + n("fee") + n("tax");
    return { side: -1, p: Number(gross) / Number(inn), vol: Number(gross) };
  }
  return null;
}

/**
 * Walks [lo, hi] once. Returns false when the endpoint refused it, which stops the cursor rather
 * than stepping over the gap: a hole nobody knows about turns every later count into a quiet lie.
 */
async function ingestRange(lo: bigint, hi: bigint, w: Writers, curves: Map<string, string>, p: Progress, onError?: IngestOptions["onError"]): Promise<number | null> {
  let factoryLogs: Log[];
  let curveLogs: Log[];
  try {
    [factoryLogs, curveLogs] = await Promise.all([
      client.getLogs({ address: PONS.factory, events: [LAUNCHED, GRADUATED], fromBlock: lo, toBlock: hi }),
      client.getLogs({ events: [BUY, SELL], fromBlock: lo, toBlock: hi }),
    ]);
  } catch (e) {
    onError?.(`logs ${lo}-${hi}`, e);
    return null;
  }

  // this endpoint refuses rather than truncates, but a quieter one might not, and a range that came
  // back exactly at the ceiling is indistinguishable from one that was cut off
  if (curveLogs.length >= LOG_LIMIT || factoryLogs.length >= LOG_LIMIT) {
    onError?.(`logs ${lo}-${hi}`, new Error(`${Math.max(curveLogs.length, factoryLogs.length)} logs is at the endpoint ceiling; narrowing rather than trusting it`));
    return null;
  }

  const d = db();
  d.exec("BEGIN");
  try {
    for (const l of parseEventLogs({ abi: factoryAbi, logs: factoryLogs })) {
      if (l.blockNumber === null || l.logIndex === null) continue;
      if (l.eventName === "TokenLaunched") {
        const a = l.args;
        if (!a.token || !a.curve || !a.deployer) continue;
        const curve = a.curve.toLowerCase();
        w.launch.run(a.token.toLowerCase(), curve, a.deployer.toLowerCase(), (a.pairToken ?? "").toLowerCase(), Number(l.blockNumber), l.logIndex);
        curves.set(curve, a.token.toLowerCase());
        p.launches++;
      } else if (l.eventName === "PoolGraduated") {
        if (!l.args.token) continue;
        w.graduation.run(l.args.token.toLowerCase(), Number(l.blockNumber));
        p.graduations++;
      }
    }

    for (const l of parseEventLogs({ abi: curveAbi, logs: curveLogs })) {
      if (l.blockNumber === null || l.logIndex === null) continue;
      const curve = l.address.toLowerCase();
      // the topic is public; only a curve the factory announced may write a price here
      if (!curves.has(curve)) continue;
      const pt = curvePoint(l.eventName, l.args as Record<string, unknown>);
      if (!pt) continue;
      w.trade.run(curve, Number(l.blockNumber), l.logIndex, pt.side, pt.p, pt.vol);
      p.trades++;
    }
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    onError?.(`write ${lo}-${hi}`, e);
    return null;
  }
  return Math.max(curveLogs.length, factoryLogs.length);
}

/**
 * Seal times, sampled on a fixed stride.
 *
 * The logs themselves carry a `blockTimestamp` field, which would have made this free and exact —
 * but this node returns it as zero for every range query at every depth tried, from a thousand
 * blocks back to a million, so it cannot be used. Timestamps therefore have to be asked for, and
 * asking for all of them is out of the question on a chain that seals ten blocks a second.
 *
 * So: one real seal every STRIDE blocks, and linear interpolation between them. The stride is what
 * sets the error, and it is the whole reason this is not simply one anchor per range — at a range
 * of five thousand blocks the estimate drifted about 1.5 s, which is invisible on an hour-long
 * chart and not invisible at all on the one- and two-second candles a fresh launch is drawn with.
 */
const STRIDE = 1_000n;

async function anchorRange(lo: bigint, hi: bigint, w: Writers): Promise<void> {
  const first = (lo / STRIDE) * STRIDE;
  const want: bigint[] = [];
  for (let b = first < lo ? first + STRIDE : first; b <= hi; b += STRIDE) want.push(b);
  // the block after the range too, so the last trades in it are interpolated rather than extrapolated
  want.push(hi);

  const have = db().prepare("SELECT 1 AS n FROM blocks WHERE number = ?");
  const missing = want.filter((b) => !have.get(Number(b)));
  if (missing.length === 0) return;

  const seals = await Promise.all(
    missing.map((b) => client.getBlock({ blockNumber: b }).then((x) => [b, x.timestamp] as const).catch(() => null)),
  );
  for (const s of seals) {
    if (!s) continue; // one missing anchor is spanned by its neighbours, not worth stopping for
    w.block.run(Number(s[0]), Number(s[1]) * 1000);
  }
}

/**
 * Follows the chain into the index, resolving at `to` — or at the head, unless `follow` is set, in
 * which case only the abort signal ends it.
 */
export async function ingest(opts: IngestOptions = {}, signal?: AbortSignal): Promise<Progress> {
  const d = db();
  const w = writers();
  const curves = loadCurves();

  const head0 = await client.getBlockNumber();
  const stored = meta.get("cursor");
  const start = stored !== null
    ? BigInt(stored) + 1n
    : (opts.from ?? (head0 > DEFAULT_WINDOW ? head0 - DEFAULT_WINDOW : 0n));
  if (stored === null) meta.set("from", String(start));

  const p: Progress = { block: Number(start), head: Number(head0), launches: 0, graduations: 0, trades: 0, stalled: 0 };
  const maxChunk = opts.chunk ?? CHUNK;
  let chunk = maxChunk;
  let lo = start;

  for (;;) {
    if (signal?.aborted) break;
    const head = opts.to ?? (await client.getBlockNumber().catch(() => BigInt(p.head)));
    p.head = Number(head);

    if (lo > head) {
      if (!opts.follow || signal?.aborted) break;
      await new Promise((r) => setTimeout(r, opts.idleMs ?? 2_000));
      continue;
    }

    const hi = lo + chunk - 1n > head ? head : lo + chunk - 1n;
    await anchorRange(lo, hi, w);
    const got = await ingestRange(lo, hi, w, curves, p, opts.onError);

    if (got === null) {
      // a refused range is almost always too wide rather than unreadable; halve it and try again
      if (chunk > MIN_CHUNK) { chunk = chunk / 2n > MIN_CHUNK ? chunk / 2n : MIN_CHUNK; continue; }
      p.stalled++;
      opts.onProgress?.({ ...p });
      if (!opts.follow) break;
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }

    meta.set("cursor", String(hi));
    p.block = Number(hi);
    p.stalled = 0;

    // steer the next range by what this one weighed, so the ceiling is approached and not hit
    const width = hi - lo + 1n;
    lo = hi + 1n;
    const ideal = got > 0 ? (width * BigInt(Math.round(LOG_LIMIT * AIM))) / BigInt(got) : maxChunk;
    chunk = ideal > maxChunk ? maxChunk : ideal < MIN_CHUNK ? MIN_CHUNK : ideal;
    opts.onProgress?.({ ...p });
  }

  // the last anchor keeps the newest rows inside the sampled span rather than past its end
  await anchorRange(BigInt(p.block), BigInt(p.block), w);
  d.exec("PRAGMA wal_checkpoint(PASSIVE)");
  return p;
}
