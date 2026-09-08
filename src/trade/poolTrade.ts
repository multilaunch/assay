import { encodeAbiParameters, encodePacked, parseAbiParameters, type Address, type Hex } from "viem";
import { erc20Abi } from "../abi/pons.js";
import { ACTION, CMD_V4_SWAP, permit2Abi, universalRouterAbi } from "../abi/uniswap.js";
import { client } from "../chain/clients.js";
import { UNI, ZERO } from "../chain/config.js";
import { minOutWithSlippage } from "../pons/curve.js";
import { poolKeyFor, quoteV4, type PoolKey } from "./v4.js";
import { getAccount, walletClient } from "./wallet.js";
import type { PrivateKeyAccount } from "viem/accounts";
import type { LaunchRecord } from "../pons/enrich.js";

/**
 * Trading a graduated launch in its Uniswap v4 pool.
 *
 * v4 has no per-pool router: everything goes through UniversalRouter as a `V4_SWAP` command whose
 * input is an (actions, params) pair. One exact-input swap is three actions:
 *
 *   SWAP_EXACT_IN_SINGLE  the swap itself
 *   SETTLE_ALL            pay what we owe (whatever we are selling)
 *   TAKE_ALL              collect what we are owed, with the minimum we will accept
 *
 * The pool key is not ours to choose: the factory recorded the pair token and tick spacing for that
 * launch, and the hook is always the pons singleton.
 */

const POOL_KEY = "(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey";
/** v4-periphery `IV4Router.ExactInputSingleParams`. */
const EXACT_IN_SINGLE = parseAbiParameters(`(${POOL_KEY}, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)`);
const SETTLE_TAKE = parseAbiParameters("address currency, uint256 amount");

export interface SwapCalldata { commands: Hex; inputs: readonly Hex[]; value: bigint }

export const isNative = (a: Address): boolean => a.toLowerCase() === ZERO;

/**
 * The exact bytes UniversalRouter.execute expects for "swap `amountIn` of `currencyIn` through this
 * pool and do not accept less than `minOut`". Works in both directions: selling the launch token for
 * the pair asset, and buying it with the pair asset.
 *
 * When the input side is native ETH the router is paid with msg.value; an ERC-20 input is pulled
 * through Permit2 instead and `value` stays zero.
 */
export function encodeV4Swap(key: PoolKey, currencyIn: Address, amountIn: bigint, minOut: bigint): SwapCalldata {
  const zeroForOne = key.currency0.toLowerCase() === currencyIn.toLowerCase();
  const currencyOut = zeroForOne ? key.currency1 : key.currency0;

  const actions = encodePacked(["uint8", "uint8", "uint8"], [ACTION.SWAP_EXACT_IN_SINGLE, ACTION.SETTLE_ALL, ACTION.TAKE_ALL]);
  const params: Hex[] = [
    encodeAbiParameters(EXACT_IN_SINGLE, [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut, hookData: "0x" }]),
    encodeAbiParameters(SETTLE_TAKE, [currencyIn, amountIn]),
    encodeAbiParameters(SETTLE_TAKE, [currencyOut, minOut]),
  ];

  return {
    commands: encodePacked(["uint8"], [CMD_V4_SWAP]),
    inputs: [encodeAbiParameters(parseAbiParameters("bytes actions, bytes[] params"), [actions, params])],
    value: isNative(currencyIn) ? amountIn : 0n,
  };
}

/** Kept for readers who only care about the sell path. */
export const encodeV4Sell = encodeV4Swap;

export interface PoolSwapResult { quoted: bigint; minOut: bigint; hash?: Hex | undefined; dryRun: boolean; venue: "pool" }

type Rec = Pick<LaunchRecord, "pairToken" | "poolFee" | "tickSpacing">;

/**
 * One exact-input swap in the graduated pool. `currencyIn` decides the direction: the launch token
 * to sell it, the pair asset to buy it. Dry run quotes and returns; live approves only what the
 * trade needs and refuses to sign until the router accepts a simulation of the very same bytes.
 */
export async function swapInPool(token: Address, record: Rec, currencyIn: Address, amountIn: bigint, slippageBps: number, opts: { dryRun: boolean }): Promise<PoolSwapResult> {
  const key = poolKeyFor(token, record);
  const quoted = await quoteV4(key, currencyIn, amountIn);
  if (quoted === null || quoted === 0n) throw new Error("the v4 quoter would not price that swap");
  const minOut = minOutWithSlippage(quoted, slippageBps);
  if (opts.dryRun) return { quoted, minOut, dryRun: true, venue: "pool" };

  const acct = getAccount();
  if (!acct) throw new Error("a live pool trade needs PRIVATE_KEY");
  const wallet = walletClient();

  // native ETH rides along as msg.value; an ERC-20 has to be lent to the router through Permit2
  if (!isNative(currencyIn)) await ensurePermit2(currencyIn, acct, amountIn);

  const { commands, inputs, value } = encodeV4Swap(key, currencyIn, amountIn, minOut);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const args = [commands, inputs, deadline] as const;

  // prove the router accepts these bytes before spending gas on them
  await client.simulateContract({ address: UNI.universalRouter, abi: universalRouterAbi, functionName: "execute", args, value, account: acct.address });

  const hash = await wallet.writeContract({ address: UNI.universalRouter, abi: universalRouterAbi, functionName: "execute", args, value, account: acct, chain: null });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`pool swap reverted: ${hash}`);
  return { quoted, minOut, hash, dryRun: false, venue: "pool" };
}

/** Sell the launch token into the pool for whatever the launch is paired with. */
export const sellIntoPool = (token: Address, record: Rec, amountIn: bigint, slippageBps: number, opts: { dryRun: boolean }): Promise<PoolSwapResult> =>
  swapInPool(token, record, token, amountIn, slippageBps, opts);

/** Buy the launch token out of the pool with the pair asset. */
export const buyFromPool = (token: Address, record: Rec, amountIn: bigint, slippageBps: number, opts: { dryRun: boolean }): Promise<PoolSwapResult> =>
  swapInPool(token, record, record.pairToken, amountIn, slippageBps, opts);

const erc20Approve = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
const allowanceAbi = [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] }] as const;

/** UniversalRouter pulls ERC-20s through Permit2, so the token is approved to Permit2 and Permit2 to the router. */
async function ensurePermit2(currency: Address, owner: PrivateKeyAccount, need: bigint): Promise<void> {
  const wallet = walletClient();
  const bal = await client.readContract({ address: currency, abi: erc20Abi, functionName: "balanceOf", args: [owner.address] });
  if (bal < need) throw new Error(`balance ${bal} is short of ${need}`);

  const toPermit2 = await client.readContract({ address: currency, abi: allowanceAbi, functionName: "allowance", args: [owner.address, UNI.permit2] }).catch(() => 0n);
  if (toPermit2 < need) {
    const h = await wallet.writeContract({ address: currency, abi: erc20Approve, functionName: "approve", args: [UNI.permit2, need], account: owner, chain: null });
    await client.waitForTransactionReceipt({ hash: h, timeout: 60_000 });
  }

  const [amount, expiration] = await client.readContract({ address: UNI.permit2, abi: permit2Abi, functionName: "allowance", args: [owner.address, currency, UNI.universalRouter] }).catch(() => [0n, 0, 0] as const);
  const nowSec = Math.floor(Date.now() / 1000);
  if (BigInt(amount) < need || Number(expiration) < nowSec + 60) {
    const h = await wallet.writeContract({ address: UNI.permit2, abi: permit2Abi, functionName: "approve", args: [currency, UNI.universalRouter, need, nowSec + 3600], account: owner, chain: null });
    await client.waitForTransactionReceipt({ hash: h, timeout: 60_000 });
  }
}

/** True when the pons pool for this launch pairs against native ETH. */
export const poolIsNative = (record: Pick<LaunchRecord, "pairToken">): boolean => isNative(record.pairToken);
