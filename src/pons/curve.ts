import { BPS, LAUNCH_SUPPLY } from "../chain/config.js";

/**
 * Bonding-curve arithmetic in the exact integer order of PonsV2BondingCurve.sol and
 * PonsV2BondingCurveMath.sol (contractsV2/src/v2). Every division rounds the way the
 * contract rounds, so a quote here is the number the chain will produce for the same state.
 *
 * Fee legs, from the source:
 *   buy : fee = spent*feeBps/BPS, tax = spent*creatorTaxBps/BPS, tokensOut = out(spent - fee - tax)
 *   sell: gross = out(tokensIn), fee = gross*feeBps/BPS, tax = gross*creatorTaxBps/BPS, quoteOut = gross - fee - tax
 *
 * The opening (snipe) tax is not in the public source. The deployed curve exposes
 * `currentSnipeTaxBps(recipient)`; observed on chain it behaves as one more input leg on buys,
 * capped so the buyer always keeps at least 1 % of the spend. We model it that way and `doctor`
 * cross-checks a modelled quote against an `eth_call` simulation of `buy` on a live curve.
 */

// ---- PonsV2BondingCurveMath ------------------------------------------------------------------

export function amountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps = 0n): bigint {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n || feeBps >= BPS) return 0n;
  const inWithFee = amountIn * (BPS - feeBps);
  return (inWithFee * reserveOut) / (reserveIn * BPS + inWithFee);
}

export function amountIn(amountOutWanted: bigint, reserveIn: bigint, reserveOut: bigint, feeBps = 0n): bigint {
  if (amountOutWanted === 0n || reserveIn === 0n || reserveOut <= amountOutWanted || feeBps >= BPS) return 0n;
  const num = amountOutWanted * reserveIn * BPS;
  const den = (reserveOut - amountOutWanted) * (BPS - feeBps);
  return num / den + 1n;
}

const mulDivCeil = (a: bigint, b: bigint, d: bigint): bigint => (a * b + d - 1n) / d;

// ---- state -----------------------------------------------------------------------------------

export interface CurveState {
  /** getReserves(): phantom + tracked − fee balances, and trackedTokens. */
  quoteReserve: bigint;
  tokenReserve: bigint;
  realQuoteReserve: bigint;
  phantomQuote: bigint;
  sellableTokens: bigint;
  reservedTokens: bigint;
  graduationThreshold: bigint;
  feeBps: bigint;
  creatorTaxBps: bigint;
  /** currentSnipeTaxBps(recipient) at read time; 0 once the window has passed or for exempt wallets. */
  openingTaxBps: bigint;
  graduated: boolean;
  readyToGraduate: boolean;
  /** unix seconds */
  launchedAt: number;
  readAtMs: number;
}

/** The opening tax as the curve will actually apply it: never more than leaves the buyer 1 %. */
export function effectiveOpeningBps(s: Pick<CurveState, "openingTaxBps" | "feeBps" | "creatorTaxBps">): bigint {
  if (s.openingTaxBps <= 0n) return 0n;
  // Fee and creator tax past 99 % would put the cap below zero, and a negative opening leg is
  // *added* back to the swap input rather than taken off it: the quote would come out larger than
  // an untaxed buy. The factory caps creator tax at 10 %, so this is a floor, not a live case.
  const cap = BPS - s.feeBps - s.creatorTaxBps - 100n;
  if (cap <= 0n) return 0n;
  return s.openingTaxBps > cap ? cap : s.openingTaxBps;
}

export interface BuyQuote {
  tokensOut: bigint;
  /** What the curve keeps; the rest of `quoteIn` is refunded on a clamped fill. */
  spent: bigint;
  refund: bigint;
  fee: bigint;
  tax: bigint;
  opening: bigint;
  /** All input legs together, for display. */
  inputBps: bigint;
  clamped: boolean;
}

/** Mirrors `buy()`: fee legs off the input, constant product, clamp to the sellable allocation. */
export function quoteBuy(s: CurveState, quoteIn: bigint): BuyQuote {
  const openBps = effectiveOpeningBps(s);
  let spent = quoteIn;
  let fee = (spent * s.feeBps) / BPS;
  let tax = (spent * s.creatorTaxBps) / BPS;
  let opening = (spent * openBps) / BPS;
  let tokensOut = amountOut(spent - fee - tax - opening, s.quoteReserve, s.tokenReserve);
  let clamped = false;
  if (tokensOut > s.sellableTokens) {
    clamped = true;
    tokensOut = s.sellableTokens;
    const net = amountIn(s.sellableTokens, s.quoteReserve, s.tokenReserve);
    const grossed = mulDivCeil(net, BPS, BPS - s.feeBps - s.creatorTaxBps - openBps);
    spent = grossed < quoteIn ? grossed : quoteIn;
    fee = (spent * s.feeBps) / BPS;
    tax = (spent * s.creatorTaxBps) / BPS;
    opening = (spent * openBps) / BPS;
  }
  return { tokensOut, spent, refund: quoteIn - spent, fee, tax, opening, inputBps: s.feeBps + s.creatorTaxBps + openBps, clamped };
}

export interface SellQuote { quoteOut: bigint; gross: bigint; fee: bigint; tax: bigint }

/** Mirrors `sell()`: constant product first, fee legs off the output. No opening tax on sells. */
export function quoteSell(s: Pick<CurveState, "quoteReserve" | "tokenReserve" | "feeBps" | "creatorTaxBps">, tokensIn: bigint): SellQuote {
  const gross = amountOut(tokensIn, s.tokenReserve, s.quoteReserve);
  const fee = (gross * s.feeBps) / BPS;
  const tax = (gross * s.creatorTaxBps) / BPS;
  return { quoteOut: gross - fee - tax, gross, fee, tax };
}

/**
 * Slippage reaches us as a raw Number from a flag or the environment, and three values break the
 * bound rather than loosen it: a fraction like 2.5 throws inside BigInt(), anything over 10 000 makes
 * minOut negative so nothing can revert, and a negative makes minOut exceed the quote so everything
 * reverts. Round it and hold it inside 0..BPS at every door.
 */
export function clampSlippageBps(bps: number): number {
  if (!Number.isFinite(bps)) return 0;
  return Math.min(Number(BPS), Math.max(0, Math.round(bps)));
}

/**
 * `buy()` bounds the *rate*, not the quantity: it reverts only when spent*minOut > received*tokensOut.
 * So minTokensOut is the quoted amount less slippage, and a clamped partial fill at that rate settles.
 */
export const minOutWithSlippage = (quoted: bigint, slippageBps: number): bigint => (quoted * (BPS - BigInt(clampSlippageBps(slippageBps)))) / BPS;

// ---- read-only helpers -----------------------------------------------------------------------

/** Marginal price of one whole token, in quote units (display only). */
export function spotPrice(s: Pick<CurveState, "quoteReserve" | "tokenReserve">, quoteDecimals: number): number {
  if (s.tokenReserve === 0n) return 0;
  return (Number(s.quoteReserve) / 10 ** quoteDecimals) / (Number(s.tokenReserve) / 1e18);
}

/** Fully diluted value of the launch supply at the marginal price, in quote units. */
export function fdvInQuote(s: Pick<CurveState, "quoteReserve" | "tokenReserve">, quoteDecimals: number): number {
  return spotPrice(s, quoteDecimals) * Number(LAUNCH_SUPPLY / 10n ** 18n);
}

/** 0..1 toward graduation. The threshold is in *real* quote, the phantom reserve does not count. */
export function progress(s: Pick<CurveState, "realQuoteReserve" | "graduationThreshold">): number {
  if (s.graduationThreshold === 0n) return 0;
  const p = Number(s.realQuoteReserve) / Number(s.graduationThreshold);
  return p > 1 ? 1 : p < 0 ? 0 : p;
}

/** Share of the launch supply, as a percentage number. */
export const supplyPct = (tokens: bigint): number => Number((tokens * 1_000_000n) / LAUNCH_SUPPLY) / 10_000;
