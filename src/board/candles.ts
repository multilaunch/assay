import { parseEventLogs, type Address } from "viem";
import { curveAbi, factoryAbi } from "../abi/pons.js";
import { blockClock } from "../chain/clock.js";
import { client } from "../chain/clients.js";
import { poolManagerAbi } from "../abi/uniswap.js";
import { PONS, UNI } from "../chain/config.js";
import { searchLaunchEvent } from "../pons/detect.js";
import { pairInfo } from "../pons/enrich.js";
import { poolId, poolKeyFor } from "../trade/v4.js";
import { coverage } from "../index/db.js";
import { launchOf, pointsFor } from "../index/read.js";
import { curvePoint } from "../index/ingest.js";

/**
 * Price over time, folded out of the curve's own trade log.
 *
 * Both curve events carry their legs, so the price is recoverable without an archive node and
 * without a price feed: a buy is `(quoteIn − fee − tax) / tokensOut`, a sell is
 * `(quoteOut + fee + tax) / tokensIn`. Netting the legs off matters — inside the opening window the
 * tax is 99%, and the amount a sniper *paid* is a hundred times the price the curve was at.
 *
 * A graduated launch stops trading on the curve entirely and continues in a Uniswap v4 pool, whose
 * swaps come from the PoolManager singleton keyed by pool id. Both halves are drawn on one axis,
 * which is only honest because they are in the same units — checked against a live graduation, the
 * last curve print was 2.0291e-8 ETH per token and the first pool swap 2.0875e-8, three per cent
 * apart. Had they differed by orders of magnitude the join would have been a lie.
 *
 * Most launches will not fill one. Of forty consecutive launches, seventeen had eight trades or
 * more; the rest are a couple of prints and an empty box is the honest way to draw that.
 */

const BUY = curveAbi.find((x) => x.type === "event" && x.name === "CurveBuy")!;
const SELL = curveAbi.find((x) => x.type === "event" && x.name === "CurveSell")!;
const SWAP = poolManagerAbi.find((x) => x.type === "event" && x.name === "Swap")!;

/**
 * Pair units per whole token, out of a v4 swap's `sqrtPriceX96`.
 *
 * The raw square root gives currency1 per currency0 in the smallest units of each. Which of the two
 * our token is depends on how the addresses sorted, and the answer has to be flipped when it landed
 * second — quoting the reciprocal would draw a chart that looks plausible and is upside down.
 */
export function priceFromSqrt(sqrtPriceX96: bigint, tokenIsCurrency1: boolean, tokenDecimals: number, pairDecimals: number): number {
  const sp = Number(sqrtPriceX96) / 2 ** 96;
  const ratio = sp * sp; // currency1 per currency0, raw
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  return tokenIsCurrency1
    ? (1 / ratio) * 10 ** (tokenDecimals - pairDecimals)
    : ratio * 10 ** (tokenDecimals - pairDecimals);
}

const CHUNK = 20_000n;
/** Blocks at the head the index does not answer for: about three minutes. */
const LIVE_TAIL = 2_000;
const MAX_LOGS = 30_000;
const TTL_MS = 20_000;
/** Aim for about this many candles, whatever the launch's age. */
const TARGET_CANDLES = 48;
/** The ladder the automatic choice steps through. 900 is here because the jump from 600 to 1800
 *  halved the candle count on any launch older than about eight hours, and 900 is a size the
 *  reader can also pick by hand. */
const BUCKETS_SEC = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

export interface Candle {
  /** unix ms at the start of the bucket */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** trades in the bucket, and how much quote moved through it */
  n: number;
  vol: number;
}

export interface Candles {
  token: Address;
  curve: Address;
  bucketSec: number;
  candles: Candle[];
  trades: number;
  /** the curve is closed and the rest of the chart comes from the pool */
  graduated: boolean;
  /** unix ms of the first pool swap, or null when the launch never left the curve */
  poolFrom: number | null;
  failedChunks: number;
  truncated: boolean;
}

interface Point { t: number; p: number; vol: number }

/** Buckets price points into OHLC. Pure, so the arithmetic can be checked without a chain. */
export function toCandles(points: readonly Point[], bucketMs: number): Candle[] {
  if (points.length === 0 || bucketMs <= 0) return [];
  const byBucket = new Map<number, Point[]>();
  for (const p of points) {
    const k = Math.floor(p.t / bucketMs) * bucketMs;
    const list = byBucket.get(k);
    if (list) list.push(p);
    else byBucket.set(k, [p]);
  }
  return [...byBucket.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, ps]) => {
      const prices = ps.map((x) => x.p);
      return {
        t,
        o: prices[0]!,
        h: Math.max(...prices),
        l: Math.min(...prices),
        c: prices[prices.length - 1]!,
        n: ps.length,
        vol: ps.reduce((s, x) => s + x.vol, 0),
      };
    });
}

/**
 * A bucket size, from the span and — the part that was missing — how much actually traded in it.
 *
 * Cutting every launch into forty-eight candles is right for one that traded four thousand times
 * and absurd for one that traded three: each bucket holds a single print, open equals close, and a
 * candle with no body is a one-pixel line. The result was a chart that looked broken rather than
 * quiet, which is a worse lie than an empty box — the launch was fine, the slicing was not.
 *
 * So the target is set by the trades and only then divided into the span: roughly three prints per
 * candle, never fewer than five candles and never more than forty-eight.
 */
export function pickBucketSec(spanSec: number, trades = TARGET_CANDLES * 3): number {
  const target = Math.min(TARGET_CANDLES, Math.max(5, Math.round(trades / 3)));
  const want = spanSec / target;
  return BUCKETS_SEC.find((b) => b >= want) ?? BUCKETS_SEC[BUCKETS_SEC.length - 1]!;
}

const cache = new Map<string, { at: number; data: Candles }>();

export async function candlesFor(token: Address, bucketSec?: number): Promise<Candles | null> {
  const key = `${token.toLowerCase()}:${bucketSec ?? "auto"}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const rec = await client.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] }).catch(() => null);
  if (!rec || !rec.exists) return null;

  /**
   * Where the launch happened. `searchLaunchEvent` finds it by walking backwards through the chain
   * in hundred-thousand-block steps until the log turns up, which for a launch half a day old is
   * several getLogs before the chart has drawn anything. The index wrote that block down the first
   * time it saw the launch, so when it has the token this costs nothing.
   */
  const known = launchOf(token);
  const head = await client.getBlockNumber();
  let from: bigint;
  if (known) from = BigInt(known.block);
  else {
    const found = await searchLaunchEvent(token).catch(() => null);
    from = found?.ev?.blockNumber ?? (head > 400_000n ? head - 400_000n : 0n);
  }
  const clock = await blockClock(head);

  const points: Point[] = [];
  let failedChunks = 0;
  let truncated = false;

  /**
   * Whatever the index already holds, taken from disk; the rest from the chain.
   *
   * Asking whether the index "covers the chart" is the wrong question — its cursor sits a few
   * blocks behind a head that moves ten times a second, so the answer would be no forever. It owns
   * everything up to its cursor and the live tail is read as before, which leaves no gap and, for a
   * launch that is hours old, replaces almost every request with a query.
   */
  let liveFrom = from;
  const { from: idxFrom, cursor } = coverage();
  if (idxFrom !== null && cursor !== null && Number(from) >= idxFrom) {
    // the last stretch stays live. The index dates a block by interpolating between seals sampled a
    // thousand apart, good to about a second, while `blockClock` is anchored two hundred blocks off
    // the head and is better than that right there — which is exactly where a minute-old launch is
    // drawn in one-second candles. Older launches use buckets of thirty seconds and up, where a
    // second does not show.
    const upTo = Math.min(cursor, Number(head) - LIVE_TAIL);
    if (upTo > Number(from)) {
      const stored = pointsFor(rec.curve, Number(from), upTo);
      if (stored) {
        for (const pt of stored) points.push({ t: Math.round(pt.t), p: pt.p, vol: pt.vol });
        liveFrom = BigInt(upTo) + 1n;
      }
    }
  }

  for (let lo = liveFrom; lo <= head; lo += CHUNK) {
    const hi = lo + CHUNK - 1n > head ? head : lo + CHUNK - 1n;
    let logs;
    try { logs = await client.getLogs({ address: rec.curve, events: [BUY, SELL], fromBlock: lo, toBlock: hi }); }
    catch { failedChunks++; continue; }
    for (const l of parseEventLogs({ abi: curveAbi, logs })) {
      if (l.blockNumber === null) continue;
      const pt = curvePoint(l.eventName, l.args as Record<string, unknown>);
      if (!pt) continue;
      points.push({ t: Math.round(clock.at(l.blockNumber)), p: pt.p, vol: pt.vol });
    }
    if (points.length > MAX_LOGS) { truncated = true; break; }
  }

  // Every pons token is the same contract with three addresses baked in — 3248 bytes of which 60
  // differ — so its decimals are the template's and do not need reading per launch.
  const TOKEN_DECIMALS = 18;
  const graduated = rec.phase === 2 || rec.phase === 3;
  let poolFrom: number | null = null;

  if (graduated) {
    const pair = await pairInfo(rec.pairToken).catch(() => null);
    const key = poolKeyFor(token, rec);
    const id = poolId(key);
    const tokenIsC1 = key.currency1.toLowerCase() === token.toLowerCase();
    const start = points.length ? points[points.length - 1]!.t : null;
    for (let lo = from; lo <= head; lo += CHUNK) {
      const hi = lo + CHUNK - 1n > head ? head : lo + CHUNK - 1n;
      let logs;
      try { logs = await client.getLogs({ address: UNI.poolManager, event: SWAP, args: { id }, fromBlock: lo, toBlock: hi }); }
      catch { failedChunks++; continue; }
      for (const l of logs) {
        if (l.blockNumber === null) continue;
        const a = l.args as { sqrtPriceX96?: bigint; amount0?: bigint; amount1?: bigint };
        if (a.sqrtPriceX96 === undefined) continue;
        const p = priceFromSqrt(a.sqrtPriceX96, tokenIsC1, TOKEN_DECIMALS, pair?.decimals ?? 18);
        if (p <= 0) continue;
        const t = Math.round(clock.at(l.blockNumber));
        const quote = tokenIsC1 ? a.amount0 : a.amount1;
        points.push({ t, p, vol: quote === undefined ? 0 : Math.abs(Number(quote)) });
        if (poolFrom === null || t < poolFrom) poolFrom = t;
      }
      if (points.length > MAX_LOGS) { truncated = true; break; }
    }
    if (start !== null && poolFrom !== null && poolFrom < start) poolFrom = start;
  }

  points.sort((a, b) => a.t - b.t);
  const spanSec = points.length > 1 ? (points[points.length - 1]!.t - points[0]!.t) / 1000 : 60;
  const bucket = bucketSec && bucketSec > 0 ? bucketSec : pickBucketSec(Math.max(spanSec, 30), points.length);

  const data: Candles = {
    token,
    curve: rec.curve,
    bucketSec: bucket,
    candles: toCandles(points, bucket * 1000),
    trades: points.length,
    graduated,
    /** where the curve stopped and the pool took over, so the chart can mark the seam */
    poolFrom,
    failedChunks,
    truncated,
  };

  cache.set(key, { at: Date.now(), data });
  if (cache.size > 200) { const oldest = [...cache].sort((a, b) => a[1].at - b[1].at)[0]; if (oldest) cache.delete(oldest[0]); }
  return data;
}
