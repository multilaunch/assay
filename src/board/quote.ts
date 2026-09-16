import { encodeFunctionData, isAddress, type Address, type Hex } from "viem";
import { curveAbi, erc20Abi, factoryAbi } from "../abi/pons.js";
import { client } from "../chain/clients.js";
import { CHAIN_ID, PONS, ZERO } from "../chain/config.js";
import { minOutWithSlippage, quoteBuy, quoteSell } from "../pons/curve.js";
import { curveState } from "../trade/state.js";

/**
 * A buy the visitor signs with their own wallet.
 *
 * The board holds a key for one operator and nobody else, and it is never going to hold anyone
 * else's. So a visitor who wants in gets the transaction, not the execution: this works out the
 * amounts and hands back the exact bytes, and their wallet does the signing and the sending. No
 * custody, no session key, no key material anywhere near this process.
 *
 * That trade costs almost nothing here. A pons launch opens behind a 99% tax that decays over three
 * seconds, so there is no first-block race to lose — the entry window is "any time after the tax is
 * gone", which is minutes wide. A person clicking is not meaningfully slower than a bot.
 *
 * The opening tax is read *for the buyer's own address*, because wallets on the launch's exemption
 * list pay a different one. Quoting the operator's tax to a visitor would be quoting a fill they
 * cannot get.
 */

/**
 * The chain, stated inside the transaction the wallet signs.
 *
 * Without it the page's own "are you on Robinhood Chain" check was the only guard, and that check
 * runs before the wallet popup — a reader who switches network while the popup is open signs our
 * calldata on whatever chain they switched to. The `to` of a buy is a curve address and the value
 * is real ETH; on another chain that address is somebody else's contract, or nobody's. A wallet
 * that sees a `chainId` it is not on refuses to sign, which turns a race into a refusal.
 */
const CHAIN_HEX = `0x${CHAIN_ID.toString(16)}` as Hex;

/** How long a quote is worth acting on. The curve moves with every trade. */
export const QUOTE_TTL_MS = 20_000;

export type Side = "buy" | "sell";

export interface BuyQuote {
  chainId: number;
  side: Side;
  /** the transaction to sign, exactly as the wallet needs it */
  tx: { to: Address; data: Hex; value: string; from: Address; chainId: Hex };
  /**
   * A sell has to be allowed before it can happen: the curve pulls the tokens, so the token
   * contract must be told first. That is a second signature, and hiding it behind the first would
   * mean a wallet popup the reader did not ask for. It is handed over separately, and it is null
   * when the standing allowance already covers the amount.
   */
  approve?: { to: Address; data: Hex; value: string; from: Address; chainId: Hex } | null;
  /** what the numbers mean, so the page can show them before the wallet does */
  token: Address;
  curve: Address;
  /** what goes in: wei of the pair on a buy, raw token units on a sell */
  quoteIn: string;
  /** what comes out: raw token units on a buy, wei of the pair on a sell */
  tokensOut: string;
  minOut: string;
  /** the seller's token balance, so the page can offer a share of it and refuse more */
  balance?: string;
  slippageBps: number;
  openingTaxBps: number;
  feeBps: number;
  creatorTaxBps: number;
  pairSymbol: string;
  expiresAt: number;
}

/**
 * A refusal carries a code as well as a sentence.
 *
 * The sentence is English and always will be — it is what a `curl` of this route should print. The
 * code is what the page looks up to say the same thing in the language the reader chose. Without it
 * a Russian reader clicking buy got "that amount is too small to be worth the gas", which is the
 * bug this project already fixed once for the score's reasons and had left standing here.
 */
export type QuoteResult = { ok: true; quote: BuyQuote } | { ok: false; error: string; code: string };

/** Bounds on what a page may ask for. A quote is a read, but it is a read someone can spam. */
const MAX_ETH = 10n ** 18n; // one whole ETH per buy through the page
const MIN_ETH = 10n ** 12n;

/**
 * Prices a buy on the bonding curve and encodes it.
 *
 * Deliberately narrow: native-ETH pairs, on a curve that has not graduated. An ERC-20 pair needs an
 * approve first, and a graduated launch trades through the Uniswap router with a different shape —
 * both are real, both are more than one signature, and quoting them here would produce bytes that
 * fail in the wallet. Refusing with a reason is better than that.
 */
export async function buyQuote(input: { token: string; buyer: string; quoteIn: string; slippageBps?: number }): Promise<QuoteResult> {
  if (!isAddress(input.token, { strict: false })) return { ok: false, error: "that is not a token address", code: "bad_token" };
  if (!isAddress(input.buyer, { strict: false })) return { ok: false, error: "connect a wallet first", code: "no_wallet" };

  let quoteIn: bigint;
  // BigInt("") is 0n rather than a throw, and an empty box deserves a better answer than being
  // told its amount is too small
  const raw = (input.quoteIn ?? "").trim();
  if (!/^\d+$/.test(raw)) return { ok: false, error: "amount must be an integer number of wei", code: "amount_nan" };
  try { quoteIn = BigInt(raw); } catch { return { ok: false, error: "amount must be an integer number of wei", code: "amount_nan" }; }
  if (quoteIn < MIN_ETH) return { ok: false, error: "that amount is too small to be worth the gas", code: "amount_small" };
  if (quoteIn > MAX_ETH) return { ok: false, error: "the page will not quote more than 1 ETH at a time", code: "amount_big" };

  const slippageBps = Math.max(0, Math.min(5_000, Math.round(input.slippageBps ?? 300)));
  const token = input.token as Address;
  const buyer = input.buyer as Address;

  const rec = await client.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] }).catch(() => null);
  if (!rec || !rec.exists) return { ok: false, error: "the factory has no record of that token", code: "no_token" };
  if (rec.pairToken.toLowerCase() !== ZERO) return { ok: false, error: "this launch is not paired with ETH; buy it from the terminal instead", code: "not_eth_pair" };

  // read the curve as the buyer, so the opening tax is theirs and not somebody else's
  const cv = await curveState(rec.curve, buyer).catch(() => null);
  if (!cv) return { ok: false, error: "could not read the curve just now; try again", code: "curve_unread" };
  if (cv.graduated || cv.readyToGraduate) return { ok: false, error: "this launch has left the curve; it trades in its Uniswap pool now", code: "graduated" };

  const q = quoteBuy(cv, quoteIn);
  if (q.tokensOut === 0n) return { ok: false, error: "the curve quotes zero tokens for that amount", code: "zero_out" };
  const minOut = minOutWithSlippage(q.tokensOut, slippageBps);

  return {
    ok: true,
    quote: {
      chainId: CHAIN_ID,
      side: "buy",
      approve: null,
      tx: {
        to: rec.curve,
        data: encodeFunctionData({ abi: curveAbi, functionName: "buy", args: [quoteIn, minOut, buyer] }),
        value: `0x${quoteIn.toString(16)}`,
        from: buyer,
        chainId: CHAIN_HEX,
      },
      token, curve: rec.curve,
      quoteIn: quoteIn.toString(),
      tokensOut: q.tokensOut.toString(),
      minOut: minOut.toString(),
      slippageBps,
      openingTaxBps: Number(cv.openingTaxBps),
      feeBps: Number(cv.feeBps),
      creatorTaxBps: Number(cv.creatorTaxBps),
      pairSymbol: "ETH",
      expiresAt: Date.now() + QUOTE_TTL_MS,
    },
  };
}

/**
 * Prices a sell on the bonding curve and encodes it.
 *
 * Two differences from a buy, and both are the reader's problem rather than the code's. There is no
 * opening tax on the way out, so the 99% window does not apply. And the curve takes the tokens with
 * `transferFrom`, which needs an allowance — so this may hand back two transactions, and the page
 * has to say so before the first popup rather than after it.
 *
 * The amount is in raw token units, not a share: a percentage computed here would be computed
 * against a balance read at a different moment than the one the reader saw.
 */
export async function sellQuote(input: { token: string; seller: string; tokensIn: string; slippageBps?: number }): Promise<QuoteResult> {
  if (!isAddress(input.token, { strict: false })) return { ok: false, error: "that is not a token address", code: "bad_token" };
  if (!isAddress(input.seller, { strict: false })) return { ok: false, error: "connect a wallet first", code: "no_wallet" };

  const raw = (input.tokensIn ?? "").trim();
  if (!/^\d+$/.test(raw)) return { ok: false, error: "amount must be an integer number of token units", code: "amount_nan" };
  let tokensIn: bigint;
  try { tokensIn = BigInt(raw); } catch { return { ok: false, error: "amount must be an integer number of token units", code: "amount_nan" }; }
  if (tokensIn <= 0n) return { ok: false, error: "nothing to sell", code: "amount_small" };

  const slippageBps = Math.max(0, Math.min(5_000, Math.round(input.slippageBps ?? 300)));
  const token = input.token as Address;
  const seller = input.seller as Address;

  const rec = await client.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] }).catch(() => null);
  if (!rec || !rec.exists) return { ok: false, error: "the factory has no record of that token", code: "no_token" };
  if (rec.pairToken.toLowerCase() !== ZERO) return { ok: false, error: "this launch is not paired with ETH; sell it from the terminal instead", code: "not_eth_pair" };

  const [cv, balance, allowed] = await Promise.all([
    curveState(rec.curve, seller).catch(() => null),
    client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [seller] }).catch(() => 0n),
    client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [seller, rec.curve] }).catch(() => 0n),
  ]);
  if (!cv) return { ok: false, error: "could not read the curve just now; try again", code: "curve_unread" };
  if (cv.graduated || cv.readyToGraduate) return { ok: false, error: "this launch has left the curve; it trades in its Uniswap pool now", code: "graduated" };
  if (balance < tokensIn) return { ok: false, error: "that is more than the wallet holds", code: "over_balance" };

  const q = quoteSell(cv, tokensIn);
  if (q.quoteOut === 0n) return { ok: false, error: "the curve gives zero back for that amount", code: "zero_out" };
  const minOut = minOutWithSlippage(q.quoteOut, slippageBps);

  return {
    ok: true,
    quote: {
      chainId: CHAIN_ID,
      side: "sell",
      tx: {
        to: rec.curve,
        data: encodeFunctionData({ abi: curveAbi, functionName: "sell", args: [tokensIn, minOut, seller] }),
        value: "0x0",
        from: seller,
        chainId: CHAIN_HEX,
      },
      // exactly this sell, not an unlimited allowance: a board that leaves a standing permission
      // behind is handing the curve a claim on tokens the reader may keep for months
      approve: allowed >= tokensIn ? null : {
        to: token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [rec.curve, tokensIn] }),
        value: "0x0",
        from: seller,
        chainId: CHAIN_HEX,
      },
      token, curve: rec.curve,
      quoteIn: tokensIn.toString(),
      tokensOut: q.quoteOut.toString(),
      minOut: minOut.toString(),
      balance: balance.toString(),
      slippageBps,
      openingTaxBps: 0,
      feeBps: Number(cv.feeBps),
      creatorTaxBps: Number(cv.creatorTaxBps),
      pairSymbol: "ETH",
      expiresAt: Date.now() + QUOTE_TTL_MS,
    },
  };
}
