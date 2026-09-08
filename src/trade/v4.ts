import { encodeAbiParameters, keccak256, parseAbiParameters, type Address, type Hex } from "viem";
import { quoterAbi, stateViewAbi } from "../abi/uniswap.js";
import { client } from "../chain/clients.js";
import { PONS, UNI, ZERO } from "../chain/config.js";
import type { LaunchRecord } from "../pons/enrich.js";

/**
 * After graduation a pons launch trades in a Uniswap v4 pool behind the pons hook. The pool is keyed
 * by the pair token and the tick spacing the *factory recorded for that launch*, so both come from
 * the launch record rather than being guessed.
 */

export interface PoolKey { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }

/** v4 sorts currencies by address; native ETH is address(0) and therefore always currency0. */
export function poolKeyFor(token: Address, record: Pick<LaunchRecord, "pairToken" | "poolFee" | "tickSpacing">): PoolKey {
  const a = record.pairToken.toLowerCase() === ZERO ? ZERO : record.pairToken;
  const [currency0, currency1] = a.toLowerCase() < token.toLowerCase() ? [a, token] : [token, a];
  return { currency0: currency0 as Address, currency1: currency1 as Address, fee: record.poolFee, tickSpacing: record.tickSpacing, hooks: PONS.hook };
}

/** PoolId is keccak256 of the abi-encoded key, exactly as v4-core computes it. */
export function poolId(key: PoolKey): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
}

/** true when selling `token` means swapping currency0 → currency1. */
export const sellIsZeroForOne = (key: PoolKey, token: Address): boolean => key.currency0.toLowerCase() === token.toLowerCase();

export async function poolLiquidity(key: PoolKey): Promise<bigint | null> {
  try { return await client.readContract({ address: UNI.stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [poolId(key)] }); } catch { return null; }
}

export async function poolExists(key: PoolKey): Promise<boolean> {
  try {
    const slot0 = await client.readContract({ address: UNI.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [poolId(key)] });
    return slot0[0] > 0n;
  } catch { return false; }
}

/**
 * What the pool would pay for `amountIn` of `tokenIn`. V4Quoter is not a view function (it reverts
 * to return), so this goes through `simulateContract`.
 */
export async function quoteV4(key: PoolKey, tokenIn: Address, amountIn: bigint): Promise<bigint | null> {
  try {
    const { result } = await client.simulateContract({
      address: UNI.quoter, abi: quoterAbi, functionName: "quoteExactInputSingle",
      args: [{ poolKey: key, zeroForOne: key.currency0.toLowerCase() === tokenIn.toLowerCase(), exactAmount: amountIn, hookData: "0x" }],
    });
    return (result as readonly [bigint, bigint])[0];
  } catch { return null; }
}
