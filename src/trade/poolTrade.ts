import { encodeAbiParameters, encodePacked, parseAbiParameters, type Address, type Hex } from "viem";
import { erc20Abi } from "../abi/pons.js";
import { ACTION, CMD_V4_SWAP, permit2Abi, universalRouterAbi } from "../abi/uniswap.js";
import { client } from "../chain/clients.js";
import { UNI, ZERO } from "../chain/config.js";
import { minOutWithSlippage } from "../pons/curve.js";
import { poolKeyFor, quoteV4, sellIsZeroForOne, type PoolKey } from "./v4.js";
import { getAccount, walletClient } from "./wallet.js";
import type { LaunchRecord } from "../pons/enrich.js";

/**
 * Selling a graduated launch into its Uniswap v4 pool.
 *
 * v4 has no per-pool router: everything goes through UniversalRouter as a `V4_SWAP` command whose
 * input is an (actions, params) pair. For one exact-input swap that is three actions:
 *
 *   SWAP_EXACT_IN_SINGLE  the swap itself
 *   SETTLE_ALL            pay what we owe (the token we are selling)
 *   TAKE_ALL              collect what we are owed (ETH), with the minimum we will accept
 *
 * The pool key is not ours to choose: the factory recorded the pair token and tick spacing for that
 * launch, and the hook is always the pons singleton.
 */

const POOL_KEY_PARAMS = "(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)";

/** v4-periphery `IV4Router.ExactInputSingleParams`. */
const EXACT_IN_SINGLE = parseAbiParameters(`((${POOL_KEY_PARAMS.slice(1, -1)}) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)`);
const SETTLE_TAKE = parseAbiParameters("address currency, uint256 amount");

export interface SwapCalldata { commands: Hex; inputs: readonly Hex[]; value: bigint }

/**
 * The exact bytes UniversalRouter.execute expects for "sell `amountIn` of `tokenIn` out of this pool,
 * and do not accept less than `minOut`".
 */
export function encodeV4Sell(key: PoolKey, tokenIn: Address, amountIn: bigint, minOut: bigint): SwapCalldata {
  const zeroForOne = sellIsZeroForOne(key, tokenIn);
  const currencyOut = zeroForOne ? key.currency1 : key.currency0;

  const actions = encodePacked(["uint8", "uint8", "uint8"], [ACTION.SWAP_EXACT_IN_SINGLE, ACTION.SETTLE_ALL, ACTION.TAKE_ALL]);
  const params: Hex[] = [
    encodeAbiParameters(EXACT_IN_SINGLE, [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut, hookData: "0x" }]),
    encodeAbiParameters(SETTLE_TAKE, [tokenIn, amountIn]),
    encodeAbiParameters(SETTLE_TAKE, [currencyOut, minOut]),
  ];

  return {
    commands: encodePacked(["uint8"], [CMD_V4_SWAP]),
    inputs: [encodeAbiParameters(parseAbiParameters("bytes actions, bytes[] params"), [actions, params])],
    // selling a token costs no ETH; a buy would carry the quote as msg.value
    value: 0n,
  };
}

export interface PoolSellResult { quoted: bigint; minOut: bigint; hash?: Hex | undefined; dryRun: boolean; venue: "pool" }

/**
 * Sell a position into the graduated pool. Dry run quotes and returns; live needs two approvals
 * (the token to Permit2, then Permit2 to the router) and only sends when the simulation passes.
 */
export async function sellIntoPool(token: Address, record: Pick<LaunchRecord, "pairToken" | "poolFee" | "tickSpacing">, amountIn: bigint, slippageBps: number, opts: { dryRun: boolean }): Promise<PoolSellResult> {
  const key = poolKeyFor(token, record);
  const quoted = await quoteV4(key, token, amountIn);
  if (quoted === null || quoted === 0n) throw new Error("the v4 quoter would not price that swap");
  const minOut = minOutWithSlippage(quoted, slippageBps);
  if (opts.dryRun) return { quoted, minOut, dryRun: true, venue: "pool" };

  const acct = getAccount();
  if (!acct) throw new Error("live sell needs PRIVATE_KEY");
  const wallet = walletClient();

  await ensurePermit2(token, acct.address, amountIn);

  const { commands, inputs, value } = encodeV4Sell(key, token, amountIn, minOut);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  // Prove the router accepts these bytes before spending gas on them.
  await client.simulateContract({ address: UNI.universalRouter, abi: universalRouterAbi, functionName: "execute", args: [commands, inputs, deadline], value, account: acct.address });

  const hash = await wallet.writeContract({ address: UNI.universalRouter, abi: universalRouterAbi, functionName: "execute", args: [commands, inputs, deadline], value, account: acct, chain: null });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`pool sell reverted: ${hash}`);
  return { quoted, minOut, hash, dryRun: false, venue: "pool" };
}

/** UniversalRouter pulls tokens through Permit2, so the token is approved to Permit2 and Permit2 to the router. */
async function ensurePermit2(token: Address, owner: Address, need: bigint): Promise<void> {
  const wallet = walletClient();
  const bal = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
  if (bal < need) throw new Error(`balance ${bal} is short of ${need}`);

  const erc20Approve = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
  const allowanceAbi = [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] }] as const;

  const toPermit2 = await client.readContract({ address: token, abi: allowanceAbi, functionName: "allowance", args: [owner, UNI.permit2] }).catch(() => 0n);
  if (toPermit2 < need) {
    const h = await wallet.writeContract({ address: token, abi: erc20Approve, functionName: "approve", args: [UNI.permit2, need], account: owner, chain: null });
    await client.waitForTransactionReceipt({ hash: h, timeout: 60_000 });
  }

  const [amount, expiration] = await client.readContract({ address: UNI.permit2, abi: permit2Abi, functionName: "allowance", args: [owner, token, UNI.universalRouter] }).catch(() => [0n, 0, 0] as const);
  const nowSec = Math.floor(Date.now() / 1000);
  if (BigInt(amount) < need || Number(expiration) < nowSec + 60) {
    const h = await wallet.writeContract({ address: UNI.permit2, abi: permit2Abi, functionName: "approve", args: [token, UNI.universalRouter, need, nowSec + 3600], account: owner, chain: null });
    await client.waitForTransactionReceipt({ hash: h, timeout: 60_000 });
  }
}

/** True when the pons pool for this launch pairs against native ETH. */
export const poolIsNative = (record: Pick<LaunchRecord, "pairToken">): boolean => record.pairToken.toLowerCase() === ZERO;
