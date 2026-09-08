import type { Address } from "viem";
import { curveAbi } from "../abi/pons.js";
import { client } from "../chain/clients.js";
import { DEAD } from "../chain/config.js";
import type { CurveState } from "../pons/curve.js";

/** One multicall for the whole curve state, for the recipient whose opening tax we care about. */
export async function curveState(curve: Address, recipient: Address = DEAD): Promise<CurveState> {
  const c = { address: curve, abi: curveAbi } as const;
  const readAtMs = Date.now();
  const r = await client.multicall({
    contracts: [
      { ...c, functionName: "getReserves" },
      { ...c, functionName: "realQuoteReserve" },
      { ...c, functionName: "phantomQuote" },
      { ...c, functionName: "sellableTokens" },
      { ...c, functionName: "reservedTokens" },
      { ...c, functionName: "graduationThreshold" },
      { ...c, functionName: "feeBps" },
      { ...c, functionName: "creatorTaxBps" },
      { ...c, functionName: "currentSnipeTaxBps", args: [recipient] },
      { ...c, functionName: "graduated" },
      { ...c, functionName: "readyToGraduate" },
      { ...c, functionName: "launchedAt" },
    ],
    allowFailure: true,
  });
  const v = <T,>(i: number, fallback: T): T => (r[i]?.status === "success" ? (r[i]!.result as T) : fallback);
  const reserves = r[0]?.status === "success" ? (r[0].result as readonly [bigint, bigint]) : null;
  if (!reserves) throw new Error("curve reserves unreadable");
  return {
    quoteReserve: reserves[0], tokenReserve: reserves[1],
    realQuoteReserve: v(1, 0n), phantomQuote: v(2, 0n), sellableTokens: v(3, 0n), reservedTokens: v(4, 0n),
    graduationThreshold: v(5, 0n), feeBps: v(6, 100n), creatorTaxBps: v(7, 0n), openingTaxBps: v(8, 0n),
    graduated: v(9, false), readyToGraduate: v(10, false), launchedAt: Number(v(11, 0n)), readAtMs,
  };
}

/** Poll the opening tax for one recipient until it is at or under the ceiling, or give up. */
export async function waitForOpeningTax(curve: Address, recipient: Address, maxBps: number, maxWaitMs: number, everyMs = 150): Promise<{ ok: boolean; taxBps: number; waitedMs: number }> {
  const t0 = Date.now();
  for (;;) {
    let tax = 0n;
    try { tax = await client.readContract({ address: curve, abi: curveAbi, functionName: "currentSnipeTaxBps", args: [recipient] }); } catch { /* treat a failed read as "not yet" */ tax = 10_000n; }
    if (tax <= BigInt(maxBps)) return { ok: true, taxBps: Number(tax), waitedMs: Date.now() - t0 };
    if (Date.now() - t0 > maxWaitMs) return { ok: false, taxBps: Number(tax), waitedMs: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
