import { encodeFunctionData, type Address, type Hex } from "viem";
import { curveAbi, erc20Abi, TOPIC } from "../abi/pons.js";
import { client, fast } from "../chain/clients.js";
import { DEAD } from "../chain/config.js";
import { minOutWithSlippage, quoteBuy, quoteSell, type CurveState } from "../pons/curve.js";
import { getAccount, walletClient } from "./wallet.js";
import type { PrivateKeyAccount } from "viem/accounts";

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

  if (!opts.native) await ensureAllowance(opts.pairToken, curve, quoteIn, acct);

  const hash = await wallet.writeContract({
    address: curve, abi: curveAbi, functionName: "buy",
    args: [quoteIn, minOut, acct.address],
    value: opts.native ? quoteIn : 0n,
    account: acct, chain: null,
  });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`buy reverted: ${hash}`);
  // what actually landed, from the token balance delta the receipt records
  // CurveBuy(buyer, recipient, quoteIn, tokensOut, fee, tax) -> tokensOut is data word 1
  const actual = amountFromReceipt(receipt.logs, curve, TOPIC.curveBuy, 1) ?? q.tokensOut;
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
  await ensureAllowance(opts.token, curve, tokensIn, acct);

  const hash = await wallet.writeContract({ address: curve, abi: curveAbi, functionName: "sell", args: [tokensIn, minOut, acct.address], account: acct, chain: null });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`sell reverted: ${hash}`);
  // CurveSell(seller, recipient, tokensIn, quoteOut, fee, tax) -> quoteOut is data word 1.
  // Recording the quote here instead would bias every realized P&L up by the slippage allowance.
  const actual = amountFromReceipt(receipt.logs, curve, TOPIC.curveSell, 1) ?? q.quoteOut;
  return { quoted: q.quoteOut, actual, hash, dryRun: false, venue: "curve" };
}

const approveAbi = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;

/**
 * Approve only what this trade needs, and only when the standing allowance is short.
 *
 * `account` has to be the account object. Handed an address string, viem classifies it as a
 * json-rpc account and emits eth_sendTransaction, which a public endpoint has no key for: every
 * exit then dies at the approve and the position is never sold.
 */
async function ensureAllowance(token: Address, spender: Address, need: bigint, owner: PrivateKeyAccount): Promise<void> {
  const [have, allowed] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner.address] }).catch(() => 0n),
    client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner.address, spender] }).catch(() => 0n),
  ]);
  if (have < need) throw new Error(`balance ${have} is short of ${need}`);
  if (allowed >= need) return;
  const hash = await walletClient().writeContract({ address: token, abi: approveAbi, functionName: "approve", args: [spender, need], account: owner, chain: null });
  await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
}

/**
 * What the curve actually gave us, from the receipt.
 *
 * Matching on the topic matters: CurveSell has the same four-word data shape, and picking it up
 * from a buy receipt would record a quantity the wallet does not hold.
 */
function amountFromReceipt(logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[], curve: Address, topic: Hex, word: number): bigint | null {
  for (const l of logs) {
    if (l.address.toLowerCase() !== curve.toLowerCase()) continue;
    if (l.topics[0] !== topic) continue;
    const words = l.data.slice(2).match(/.{64}/g);
    const w = words?.[word];
    if (w) return BigInt(`0x${w}`);
  }
  return null;
}

export async function simulateBuy(curve: Address, quoteIn: bigint, from: Address = DEAD): Promise<bigint | null> {
  try {
    const res = await fast.call({ to: curve, data: encodeFunctionData({ abi: curveAbi, functionName: "buy", args: [quoteIn, 0n, from] }), value: quoteIn, account: from });
    return res.data ? BigInt(res.data) : null;
  } catch { return null; }
}
