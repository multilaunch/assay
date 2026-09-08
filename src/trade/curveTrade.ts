import { encodeFunctionData, type Address, type Hex } from "viem";
import { curveAbi, erc20Abi } from "../abi/pons.js";
import { client, fast } from "../chain/clients.js";
import { DEAD } from "../chain/config.js";
import { minOutWithSlippage, quoteBuy, quoteSell, type CurveState } from "../pons/curve.js";
import { getAccount, walletClient } from "./wallet.js";

export interface TradeResult {
  /** what the quote said before sending */
  quoted: bigint;
  /** what the chain returned; undefined on a dry run */
  actual?: bigint | undefined;
  hash?: Hex | undefined;
  dryRun: boolean;
  venue: "curve";
}

/**
 * Buy on the bonding curve.
 *
 * `minTokensOut` bounds the *rate*, not the quantity: the contract reverts only when
 * `spent * minOut > received * tokensOut`, so a clamped partial fill at the accepted rate still
 * settles and the unspent quote is refunded in the same transaction.
 *
 * Native-ETH curves take the quote as msg.value. ERC-20-paired curves need an allowance first.
 */
export async function buyOnCurve(curve: Address, state: CurveState, quoteIn: bigint, slippageBps: number, opts: { dryRun: boolean; pairToken: Address; native: boolean }): Promise<TradeResult> {
  const q = quoteBuy(state, quoteIn);
  if (q.tokensOut === 0n) throw new Error("the curve quotes zero tokens for that amount");
  const minOut = minOutWithSlippage(q.tokensOut, slippageBps);
  if (opts.dryRun) return { quoted: q.tokensOut, dryRun: true, venue: "curve" };

  const acct = getAccount();
  if (!acct) throw new Error("live buy needs PRIVATE_KEY");
  const wallet = walletClient();

  if (!opts.native) await ensureAllowance(opts.pairToken, curve, quoteIn, acct.address);

  const hash = await wallet.writeContract({
    address: curve, abi: curveAbi, functionName: "buy",
    args: [quoteIn, minOut, acct.address],
    value: opts.native ? quoteIn : 0n,
    account: acct, chain: null,
  });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`buy reverted: ${hash}`);
  // what actually landed, from the token balance delta the receipt records
  const actual = tokensFromReceiptLogs(receipt.logs, curve) ?? q.tokensOut;
  return { quoted: q.tokensOut, actual, hash, dryRun: false, venue: "curve" };
}

/** Sell back to the curve. Fees come off the output here, and there is no opening tax on sells. */
export async function sellOnCurve(curve: Address, state: CurveState, tokensIn: bigint, slippageBps: number, opts: { dryRun: boolean; token: Address }): Promise<TradeResult> {
  const q = quoteSell(state, tokensIn);
  if (q.quoteOut === 0n) throw new Error("the curve quotes zero out for that amount");
  const minOut = minOutWithSlippage(q.quoteOut, slippageBps);
  if (opts.dryRun) return { quoted: q.quoteOut, dryRun: true, venue: "curve" };

  const acct = getAccount();
  if (!acct) throw new Error("live sell needs PRIVATE_KEY");
  const wallet = walletClient();
  await ensureAllowance(opts.token, curve, tokensIn, acct.address);

  const hash = await wallet.writeContract({ address: curve, abi: curveAbi, functionName: "sell", args: [tokensIn, minOut, acct.address], account: acct, chain: null });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`sell reverted: ${hash}`);
  return { quoted: q.quoteOut, actual: q.quoteOut, hash, dryRun: false, venue: "curve" };
}

/** Approve only what this trade needs, and only when the current allowance is short. */
async function ensureAllowance(token: Address, spender: Address, need: bigint, owner: Address): Promise<void> {
  const have = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }).catch(() => 0n);
  if (have < need) throw new Error(`balance ${have} is short of ${need}`);
  const wallet = walletClient();
  const hash = await wallet.writeContract({ address: token, abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }], functionName: "approve", args: [spender, need], account: owner, chain: null });
  await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
}

/** Tokens minted to us by this curve in the receipt, from its CurveBuy log. */
function tokensFromReceiptLogs(logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[], curve: Address): bigint | null {
  for (const l of logs) {
    if (l.address.toLowerCase() !== curve.toLowerCase()) continue;
    // CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)
    if (l.data.length >= 2 + 64 * 4) {
      const words = l.data.slice(2).match(/.{64}/g);
      if (words && words[1]) return BigInt(`0x${words[1]}`);
    }
  }
  return null;
}

/** A simulated `buy()` on the live curve: the number the contract itself would return, right now. */
export async function simulateBuy(curve: Address, quoteIn: bigint, from: Address = DEAD): Promise<bigint | null> {
  try {
    const res = await fast.call({ to: curve, data: encodeFunctionData({ abi: curveAbi, functionName: "buy", args: [quoteIn, 0n, from] }), value: quoteIn, account: from });
    return res.data ? BigInt(res.data) : null;
  } catch { return null; }
}
