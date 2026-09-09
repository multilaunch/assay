import type { Address } from "viem";
import { factoryAbi } from "../abi/pons.js";
import { client } from "../chain/clients.js";
import { DEAD, PONS } from "../chain/config.js";
import { quoteSell, type CurveState } from "../pons/curve.js";
import type { LaunchRecord } from "../pons/enrich.js";
import { curveState } from "./state.js";
import { poolExists, poolKeyFor, quoteV4 } from "./v4.js";
import { buyOnCurve, sellOnCurve } from "./curveTrade.js";
import { buyFromPool, isNative, sellIntoPool } from "./poolTrade.js";
import { quotingAddress } from "./wallet.js";

/**
 * A pons launch trades in two places over its life, and for a stretch between them it trades nowhere.
 *
 *   NotGraduated → the bonding curve
 *   Swept        → the factory has taken the reserves but the pool is not created yet: NOTHING trades
 *   PoolCreated  → the Uniswap v4 pool behind the pons hook
 *
 * The gap is seconds to minutes. Guessing during it produces a quote nobody can fill, so every
 * function here refuses instead.
 */

export type Venue = "curve" | "pool" | "swept";

export interface VenueState {
  venue: Venue;
  record: LaunchRecord;
  curve: CurveState | null;
}

export async function resolveVenue(token: Address): Promise<VenueState> {
  const rec = await client.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] });
  if (!rec.exists) throw new Error("the factory has no record of that token");
  const record: LaunchRecord = {
    deployer: rec.deployer, creatorFeeRecipient: rec.creatorFeeRecipient, pairToken: rec.pairToken,
    graduationThreshold: rec.graduationThreshold, poolFee: Number(rec.poolFee), tickSpacing: Number(rec.tickSpacing),
    creatorTaxBps: BigInt(rec.creatorTaxBps), buybackEnabled: rec.buybackEnabled,
    phase: (["NotGraduated", "Swept", "PoolCreated", "Rescued"] as const)[rec.phase] ?? "NotGraduated", exists: true,
  };

  if (record.phase === "PoolCreated") return { venue: "pool", record, curve: null };
  if (record.phase === "Swept" || record.phase === "Rescued") {
    // Swept can still resolve to a live pool a moment later; ask the pool itself before refusing.
    const key = poolKeyFor(token, record);
    return { venue: (await poolExists(key)) ? "pool" : "swept", record, curve: null };
  }

  const cv = await curveState(rec.curve).catch(() => null);
  if (cv && (cv.graduated || cv.readyToGraduate)) {
    const key = poolKeyFor(token, record);
    return { venue: (await poolExists(key)) ? "pool" : "swept", record, curve: cv };
  }
  return { venue: "curve", record, curve: cv };
}

export interface TradeOutcome { amountOut: bigint; venue: Exclude<Venue, "swept">; hash?: `0x${string}` | undefined; dryRun: boolean }

/**
 * Buy `token` with `quoteIn` of whatever it is paired with, wherever it currently trades.
 * Refuses during the swept gap instead of quoting a fill nobody can honour.
 */
export async function buyAnywhere(token: Address, quoteIn: bigint, slippageBps: number, opts: { dryRun: boolean }): Promise<TradeOutcome> {
  const v = await resolveVenue(token);
  if (v.venue === "swept") throw new Error("nothing trades right now: the launch is between the curve and the pool");
  if (v.venue === "curve") {
    const curve = await curveOf(token);
    const cv = v.curve ?? (await curveState(curve, quotingAddress(DEAD)));
    const r = await buyOnCurve(curve, cv, quoteIn, slippageBps, { dryRun: opts.dryRun, pairToken: v.record.pairToken, native: isNative(v.record.pairToken) });
    return { amountOut: r.actual ?? r.quoted, venue: "curve", hash: r.hash, dryRun: opts.dryRun };
  }
  const r = await buyFromPool(token, v.record, quoteIn, slippageBps, { dryRun: opts.dryRun });
  return { amountOut: r.quoted, venue: "pool", hash: r.hash, dryRun: opts.dryRun };
}

export async function sellAnywhere(token: Address, tokensIn: bigint, slippageBps: number, opts: { dryRun: boolean }): Promise<TradeOutcome> {
  const v = await resolveVenue(token);
  if (v.venue === "swept") throw new Error("nothing trades right now: the launch is between the curve and the pool");
  if (v.venue === "curve") {
    const curve = await curveOf(token);
    const cv = v.curve ?? (await curveState(curve, quotingAddress(DEAD)));
    const r = await sellOnCurve(curve, cv, tokensIn, slippageBps, { dryRun: opts.dryRun, token });
    return { amountOut: r.actual ?? r.quoted, venue: "curve", hash: r.hash, dryRun: opts.dryRun };
  }
  const r = await sellIntoPool(token, v.record, tokensIn, slippageBps, { dryRun: opts.dryRun });
  return { amountOut: r.quoted, venue: "pool", hash: r.hash, dryRun: opts.dryRun };
}

export async function curveOf(token: Address): Promise<Address> {
  const rec = await client.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] });
  if (!rec.exists) throw new Error("the factory has no record of that token");
  return rec.curve;
}

/**
 * Three different answers that all used to be `null`. "Swept" is a fact about the launch and worth
 * telling the user; "unreadable" is a fact about our RPC and must not be dressed up as one.
 */
export type MarkResult =
  | { status: "ok"; quote: bigint; venue: Venue }
  | { status: "swept" }
  | { status: "unreadable"; why: string };

/**
 * What the whole position is worth right now, as a real sell quote: it already carries the 1 % fee,
 * the creator tax and the price impact of selling that size. A fresh entry therefore marks negative;
 * that is the round trip, not a loss.
 */
export async function readMark(token: Address, curveAddr: Address, tokens: bigint): Promise<MarkResult> {
  let v: VenueState;
  try { v = await resolveVenue(token); } catch (e) { return { status: "unreadable", why: `venue unreadable: ${short(e)}` }; }
  if (v.venue === "swept") return { status: "swept" };
  if (v.venue === "curve") {
    let cv = v.curve;
    if (!cv) {
      try { cv = await curveState(curveAddr); } catch (e) { return { status: "unreadable", why: `curve unreadable: ${short(e)}` }; }
    }
    return { status: "ok", quote: quoteSell(cv, tokens).quoteOut, venue: "curve" };
  }
  // quoteV4 swallows its own failures, so null here is "the quoter did not answer" and nothing more:
  // the pool is known to exist, we simply could not price it this cycle.
  const out = await quoteV4(poolKeyFor(token, v.record), token, tokens);
  return out === null ? { status: "unreadable", why: "the v4 quoter did not answer" } : { status: "ok", quote: out, venue: "pool" };
}

/** The mark on its own, for callers that treat every answer other than a price as "no price". */


const short = (e: unknown): string => (e as Error).message.split("\n")[0]?.slice(0, 90) ?? "no reason given";
