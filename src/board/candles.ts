import { parseEventLogs, type Address } from "viem";
import { curveAbi, factoryAbi } from "../abi/pons.js";
import { blockClock } from "../chain/clock.js";
import { client } from "../chain/clients.js";
import { poolManagerAbi } from "../abi/uniswap.js";
import { PONS, UNI } from "../chain/config.js";
import { searchLaunchEvent } from "../pons/detect.js";
import { pairInfo } from "../pons/enrich.js";
import { poolId, poolKeyFor } from "../trade/v4.js";

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
const MAX_LOGS = 30_000;
const TTL_MS = 20_000;
/** Aim for about this many candles, whatever the launch's age. */
const TARGET_CANDLES = 48;
const BUCKETS_SEC = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

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

/** A bucket size that gives roughly TARGET_CANDLES over the span, from a fixed ladder. */
export function pickBucketSec(spanSec: number): number {
  const want = spanSec / TARGET_CANDLES;
  return BUCKETS_SEC.find((b) => b >= want) ?? BUCKETS_SEC[BUCKETS_SEC.length - 1]!;
}

const cache = new Map<string, { at: number; data: Candles }>();

export async function candlesFor(token: Address, bucketSec?: number): Promise<Candles | null> {
  const key = `${token.toLowerCase()}:${bucketSec ?? "auto"}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const rec = await client.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] }).catch(() => null);
  if (!rec || !rec.exists) return null;

  const found = await searchLaunchEvent(token).catch(() => null);
  const head = await client.getBlockNumber();
  const from = found?.ev?.blockNumber ?? (head > 400_000n ? head - 400_000n : 0n);
  const clock = await blockClock(head);

  const points: Point[] = [];
  let failedChunks = 0;
  let truncated = false;
  for (let lo = from; lo <= head; lo += CHUNK) {
    const hi = lo + CHUNK - 1n > head ? head : lo + CHUNK - 1n;
    let logs;
    try { logs = await client.getLogs({ address: rec.curve, events: [BUY, SELL], fromBlock: lo, toBlock: hi }); }
    catch { failedChunks++; continue; }
    for (const l of parseEventLogs({ abi: curveAbi, logs })) {
      if (l.blockNumber === null) continue;
      const t = Math.round(clock.at(l.blockNumber));
      if (l.eventName === "CurveBuy") {
        const net = l.args.quoteIn - l.args.fee - l.args.tax;
        if (l.args.tokensOut === 0n || net <= 0n) continue;
        points.push({ t, p: Number(net) / Number(l.args.tokensOut), vol: Number(net) });
      } else if (l.eventName === "CurveSell") {
        if (l.args.tokensIn === 0n) continue;
        const gross = l.args.quoteOut + l.args.fee + l.args.tax;
        points.push({ t, p: Number(gross) / Number(l.args.tokensIn), vol: Number(gross) });
      }
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
  const bucket = bucketSec && bucketSec > 0 ? bucketSec : pickBucketSec(Math.max(spanSec, 30));

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
