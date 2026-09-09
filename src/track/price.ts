import { parseEventLogs, type Address } from "viem";
import { curveAbi } from "../abi/pons.js";
import { blockClock } from "../chain/clock.js";
import { client } from "../chain/clients.js";

/**
 * What a launch was actually worth to hold, rather than whether its pool opened.
 *
 * `rules` mined the journal against graduation and came back saying a large opening buy and a
 * declared bundle both graduate *more* often. That is probably true and useless: graduation only
 * means the curve filled, and an operator holding most of the supply with wallets exempt from the
 * opening tax can fill his own curve. The label was wrong for the question.
 *
 * So this reads the price out of the curve's own trade logs instead. Both events carry the legs, so
 * the curve price is recoverable without touching state:
 *
 *   CurveBuy(buyer, recipient, quoteIn, tokensOut, fee, tax)   price = (quoteIn − fee − tax) / tokensOut
 *   CurveSell(seller, recipient, tokensIn, quoteOut, fee, tax) price = (quoteOut + fee + tax) / tokensIn
 *
 * Netting the fee and the tax off matters more than it looks: inside the opening window the tax is
 * 99%, so the amount a sniper *paid* is a hundred times the price the curve was actually at.
 *
 * Entry is the first trade outside the opening-tax window, because that is the first moment an
 * outsider could buy at a normal price and it is exactly where this terminal enters. Everything
 * before it belongs to the launcher and his exempt wallets.
 *
 * The window is measured in blocks from the curve's first trade, not read off the event. The `tax`
 * word is the *creator's* tax — checked against a live launch: 293 of 293 buys on $HOODFUND carried
 * exactly its 200 bps, from the first to the last. Treating a non-zero `tax` as "sniped" would have
 * marked every trade on every token with a creator fee as belonging to the launcher.
 */

const BUY = curveAbi.find((x) => x.type === "event" && x.name === "CurveBuy")!;
const SELL = curveAbi.find((x) => x.type === "event" && x.name === "CurveSell")!;

/** getLogs is asked for this many blocks at a time, across many curves at once. */
const CHUNK = 20_000n;
/** how many curve addresses go into one filter */
const ADDRESSES = 400;

export interface CurveOutcome {
  trades: number;
  /** price of the first trade outside the opening window, in pair units per whole token */
  entry: number | null;
  /** highest and last price inside the horizon */
  peak: number | null;
  end: number | null;
  /** peak and end as a multiple of entry */
  peakX: number | null;
  endX: number | null;
  /** trades inside the opening-tax window, which belong to the launcher and his exempt wallets */
  earlyTrades: number;
}

const EMPTY: CurveOutcome = { trades: 0, entry: null, peak: null, end: null, peakX: null, endX: null, earlyTrades: 0 };

interface Point { block: bigint; price: number }

/**
 * Price points per curve over one block range.
 *
 * Curves are batched into one filter because a journal covering a day is thousands of curves and
 * one getLogs each would be thousands of calls. A refused chunk is counted, never treated as
 * "nothing traded" — that mistake is what made `fees` report a refusal as a clean zero.
 */
async function pointsOver(curves: Address[], from: bigint, to: bigint): Promise<{ points: Map<string, Point[]>; chunks: number; failed: number }> {
  const points = new Map<string, Point[]>();
  let chunks = 0;
  let failed = 0;

  for (let i = 0; i < curves.length; i += ADDRESSES) {
    const slice = curves.slice(i, i + ADDRESSES);
    for (let lo = from; lo <= to; lo += CHUNK) {
      const hi = lo + CHUNK - 1n > to ? to : lo + CHUNK - 1n;
      chunks++;
      let logs;
      try {
        logs = await client.getLogs({ address: slice, events: [BUY, SELL], fromBlock: lo, toBlock: hi });
      } catch { failed++; continue; }
      for (const l of parseEventLogs({ abi: curveAbi, logs })) {
        if (l.blockNumber === null) continue;
        let price: number;
        if (l.eventName === "CurveBuy") {
          const net = l.args.quoteIn - l.args.fee - l.args.tax;
          if (l.args.tokensOut === 0n || net <= 0n) continue;
          price = Number(net) / Number(l.args.tokensOut);
        } else if (l.eventName === "CurveSell") {
          if (l.args.tokensIn === 0n) continue;
          price = Number(l.args.quoteOut + l.args.fee + l.args.tax) / Number(l.args.tokensIn);
        } else continue;
        const key = l.address.toLowerCase();
        const list = points.get(key);
        if (list) list.push({ block: l.blockNumber, price });
        else points.set(key, [{ block: l.blockNumber, price }]);
      }
    }
  }
  return { points, chunks, failed };
}

export function summarise(points: Point[], horizonBlocks: bigint, windowBlocks: bigint): CurveOutcome {
  if (points.length === 0) return { ...EMPTY };
  points.sort((a, b) => (a.block === b.block ? 0 : a.block < b.block ? -1 : 1));
  const start = points[0]!.block;
  const inHorizon = points.filter((p) => p.block <= start + horizonBlocks);
  const earlyTrades = inHorizon.filter((p) => p.block < start + windowBlocks).length;

  const firstClean = inHorizon.find((p) => p.block >= start + windowBlocks);
  if (!firstClean) return { ...EMPTY, trades: inHorizon.length, earlyTrades };

  const after = inHorizon.filter((p) => p.block >= firstClean.block);
  const entry = firstClean.price;
  const peak = Math.max(...after.map((p) => p.price));
  const end = after[after.length - 1]!.price;
  return {
    trades: inHorizon.length,
    entry, peak, end,
    peakX: entry > 0 ? peak / entry : null,
    endX: entry > 0 ? end / entry : null,
    earlyTrades,
  };
}

export interface PriceScanResult {
  outcomes: Map<string, CurveOutcome>;
  chunks: number;
  failed: number;
}

export interface PriceScanOptions {
  /** how long after its first trade a launch is judged, in ms */
  horizonMs?: number;
  /** the opening-tax window, in seconds; read from the factory by the caller */
  windowSec?: number;
  /** launches per cohort; a cohort shares one block range */
  cohort?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Reads price outcomes for a set of curves, keyed by lowercase curve address.
 *
 * The journal records when a launch happened but not in which block, so the range is estimated from
 * the measured block time with a cohort's worth of slack either side. An estimate is fine here: it
 * only decides how much to ask for, and the horizon itself is measured from the curve's own first
 * trade, which is exact.
 */
export async function priceOutcomes(launches: { curve: Address; t: number }[], opts: PriceScanOptions = {}): Promise<PriceScanResult> {
  const horizonMs = opts.horizonMs ?? 6 * 60 * 60 * 1000;
  const cohortSize = opts.cohort ?? 600;
  const outcomes = new Map<string, CurveOutcome>();
  if (launches.length === 0) return { outcomes, chunks: 0, failed: 0 };

  const head = await client.getBlockNumber();
  const clock = await blockClock(head);
  const horizonBlocks = BigInt(Math.ceil(horizonMs / 1000 / clock.secs));
  // one extra block of slack: the window closes on a timestamp and blocks land where they land
  const windowBlocks = BigInt(Math.ceil((opts.windowSec ?? 3) / clock.secs)) + 1n;

  const sorted = [...launches].sort((a, b) => a.t - b.t);
  let chunks = 0;
  let failed = 0;

  for (let i = 0; i < sorted.length; i += cohortSize) {
    opts.onProgress?.(i, sorted.length);
    const cohort = sorted.slice(i, i + cohortSize);
    // a chunk of slack on the near side, because t is an estimate and a launch can precede it
    const from = clock.block(cohort[0]!.t) - CHUNK;
    const to = clock.block(cohort[cohort.length - 1]!.t) + horizonBlocks;
    const r = await pointsOver(cohort.map((c) => c.curve), from < 0n ? 0n : from, to > head ? head : to);
    chunks += r.chunks;
    failed += r.failed;
    for (const c of cohort) {
      const pts = r.points.get(c.curve.toLowerCase());
      outcomes.set(c.curve.toLowerCase(), pts ? summarise(pts, horizonBlocks, windowBlocks) : { ...EMPTY });
    }
  }
  opts.onProgress?.(sorted.length, sorted.length);
  return { outcomes, chunks, failed };
}
