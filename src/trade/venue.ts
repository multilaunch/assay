import type { Address } from "viem";
import { factoryAbi } from "../abi/pons.js";
import { client } from "../chain/clients.js";
import { PONS } from "../chain/config.js";
import { quoteSell, type CurveState } from "../pons/curve.js";
import type { LaunchRecord } from "../pons/enrich.js";
import { curveState } from "./state.js";
import { poolExists, poolKeyFor, quoteV4 } from "./v4.js";

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

export interface Mark { quote: bigint; venue: Venue }

/**
 * What the whole position is worth right now, as a real sell quote: it already carries the 1 % fee,
 * the creator tax and the price impact of selling that size. A fresh entry therefore marks negative;
 * that is the round trip, not a loss.
 */
export async function markPosition(token: Address, curveAddr: Address, tokens: bigint): Promise<Mark | null> {
  const v = await resolveVenue(token).catch(() => null);
  if (!v) return null;
  if (v.venue === "swept") return null;
  if (v.venue === "curve") {
    const cv = v.curve ?? (await curveState(curveAddr).catch(() => null));
    if (!cv) return null;
    return { quote: quoteSell(cv, tokens).quoteOut, venue: "curve" };
  }
  const out = await quoteV4(poolKeyFor(token, v.record), token, tokens);
  return out === null ? null : { quote: out, venue: "pool" };
}
