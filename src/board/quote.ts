import { encodeFunctionData, isAddress, type Address, type Hex } from "viem";
import { curveAbi, factoryAbi } from "../abi/pons.js";
import { client } from "../chain/clients.js";
import { CHAIN_ID, PONS, ZERO } from "../chain/config.js";
import { minOutWithSlippage, quoteBuy } from "../pons/curve.js";
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

/** How long a quote is worth acting on. The curve moves with every trade. */
export const QUOTE_TTL_MS = 20_000;

export interface BuyQuote {
  chainId: number;
  /** the transaction to sign, exactly as the wallet needs it */
  tx: { to: Address; data: Hex; value: string; from: Address };
  /** what the numbers mean, so the page can show them before the wallet does */
  token: Address;
  curve: Address;
  quoteIn: string;
  tokensOut: string;
  minOut: string;
  slippageBps: number;
  openingTaxBps: number;
  feeBps: number;
  creatorTaxBps: number;
  pairSymbol: string;
  expiresAt: number;
}

export type QuoteResult = { ok: true; quote: BuyQuote } | { ok: false; error: string };

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
  if (!isAddress(input.token, { strict: false })) return { ok: false, error: "that is not a token address" };
  if (!isAddress(input.buyer, { strict: false })) return { ok: false, error: "connect a wallet first" };

  let quoteIn: bigint;
  // BigInt("") is 0n rather than a throw, and an empty box deserves a better answer than being
  // told its amount is too small
  const raw = (input.quoteIn ?? "").trim();
  if (!/^\d+$/.test(raw)) return { ok: false, error: "amount must be an integer number of wei" };
  try { quoteIn = BigInt(raw); } catch { return { ok: false, error: "amount must be an integer number of wei" }; }
  if (quoteIn < MIN_ETH) return { ok: false, error: "that amount is too small to be worth the gas" };
  if (quoteIn > MAX_ETH) return { ok: false, error: "the page will not quote more than 1 ETH at a time" };

  const slippageBps = Math.max(0, Math.min(5_000, Math.round(input.slippageBps ?? 300)));
  const token = input.token as Address;
  const buyer = input.buyer as Address;

  const rec = await client.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] }).catch(() => null);
  if (!rec || !rec.exists) return { ok: false, error: "the factory has no record of that token" };
  if (rec.pairToken.toLowerCase() !== ZERO) return { ok: false, error: "this launch is not paired with ETH; buy it from the terminal instead" };

  // read the curve as the buyer, so the opening tax is theirs and not somebody else's
  const cv = await curveState(rec.curve, buyer).catch(() => null);
  if (!cv) return { ok: false, error: "could not read the curve just now; try again" };
  if (cv.graduated || cv.readyToGraduate) return { ok: false, error: "this launch has left the curve; it trades in its Uniswap pool now" };

  const q = quoteBuy(cv, quoteIn);
  if (q.tokensOut === 0n) return { ok: false, error: "the curve quotes zero tokens for that amount" };
  const minOut = minOutWithSlippage(q.tokensOut, slippageBps);

  return {
    ok: true,
    quote: {
      chainId: CHAIN_ID,
      tx: {
        to: rec.curve,
        data: encodeFunctionData({ abi: curveAbi, functionName: "buy", args: [quoteIn, minOut, buyer] }),
        value: `0x${quoteIn.toString(16)}`,
        from: buyer,
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
