import { parseEther } from "viem";
import { clampSlippageBps } from "../pons/curve.js";
import { devSharePct, socialsOf, type LaunchIntel, type PairInfo } from "../pons/enrich.js";
import { note, type Note } from "../score/notes.js";
import type { Score } from "../score/score.js";
import type { ExitRules } from "../trade/positions.js";
import { envNum } from "../util/env.js";

export interface EngineRules {
  /** quote spent per entry, in wei of the pair asset (ETH-only by default, so wei of ETH) */
  entryQuote: bigint;
  slippageBps: number;
  /** do not buy while the opening tax for our own address is above this */
  maxOpeningTaxBps: number;
  /** stop waiting for the tax to decay after this long */
  maxWaitMs: number;
  minScore: number;
  maxDevSharePct: number;
  maxCreatorTaxBps: number;
  requireSocials: boolean;
  maxExemptWallets: number;
  /** only launches paired with native ETH; stock-token and stable pairs are common and priced differently */
  ethPairsOnly: boolean;
  /**
   * Entry size for one pair asset, keyed by the lowercase pair address, in that asset's own smallest
   * unit. `entryQuote` is parseEther, so it only means anything against an 18-decimal asset; a pair
   * with other decimals has to be sized by hand or it is refused.
   */
  entryQuoteByPair: Map<string, bigint>;
  keyword: RegExp | null;
  deployers: Set<string>;
  maxOpenPositions: number;
  maxFarmTwins: number;
  /** total quote entries may consume in one session, whatever the scores say; one currency, so ETH-only sessions */
  sessionBudget: bigint;
  exits: ExitRules;
}

export function rulesFromEnv(over: Partial<EngineRules> = {}): EngineRules {
  return {
    entryQuote: parseEther(String(envNum("ENTRY_ETH", 0.01))),
    slippageBps: clampSlippageBps(envNum("SLIPPAGE_BPS", 300)),
    maxOpeningTaxBps: envNum("MAX_OPENING_TAX_BPS", 300),
    maxWaitMs: envNum("MAX_WAIT_MS", 12_000),
    minScore: envNum("MIN_SCORE", 60),
    maxDevSharePct: envNum("MAX_DEV_SHARE_PCT", 8),
    maxCreatorTaxBps: envNum("MAX_CREATOR_TAX_BPS", 300),
    requireSocials: true,
    maxExemptWallets: envNum("MAX_EXEMPT_WALLETS", 2),
    ethPairsOnly: true,
    entryQuoteByPair: new Map(),
    keyword: null,
    deployers: new Set(),
    maxOpenPositions: envNum("MAX_OPEN_POSITIONS", 3),
    maxFarmTwins: envNum("MAX_FARM_TWINS", 1),
    sessionBudget: parseEther(String(envNum("SESSION_BUDGET_ETH", 0.05))),
    exits: {
      takeProfitPct: envNum("TAKE_PROFIT_PCT", 80),
      stopLossPct: envNum("STOP_LOSS_PCT", 35),
      trailingPct: envNum("TRAILING_PCT", 25),
      maxHoldMin: envNum("MAX_HOLD_MIN", 45),
    },
    ...over,
  };
}

export interface Decision { fire: boolean; why: Note[] }

/**
 * Pure filter over one launch. Every refusal names the rule that refused it, so the log explains
 * itself and you can decide which rule to relax on purpose.
 *
 * The score is advice; these are the hard gates. A launch can score 90 and still be refused here
 * for having four wallets exempt from the opening tax.
 */
export function decide(intel: LaunchIntel, score: Score, rules: EngineRules, ctx: { openCount: number; farmTwins: number; spent: bigint }): Decision {
  // A launch the RPC would not let us read is not a launch that failed the rules. Say which it is.
  if (!intel.meta && !intel.record && !intel.curve) return { fire: false, why: [note("no_data", { detail: intel.errors[0] ?? "no data" })] };

  const why: Note[] = [];
  if (ctx.openCount >= rules.maxOpenPositions) why.push(note("gate_open_positions", { have: ctx.openCount, max: rules.maxOpenPositions }));
  if (ctx.spent + entryQuoteFor(rules, intel.pair) > rules.sessionBudget) why.push(note("gate_budget", { spent: ctx.spent.toString(), budget: rules.sessionBudget.toString() }));
  if (ctx.farmTwins > rules.maxFarmTwins) why.push(note("gate_farm", { twins: ctx.farmTwins, max: rules.maxFarmTwins }));
  if (rules.ethPairsOnly && !intel.pair.native) why.push(note("gate_pair_not_eth", { symbol: intel.pair.symbol }));
  // --allow-pairs opens the feed but not the arithmetic: entryQuote and sessionBudget are parseEther,
  // so 0.01 "ETH" against a 6-decimal stable is ten billion units of it. Size that pair by hand or stay out.
  if (!rules.ethPairsOnly && intel.pair.decimals !== 18 && !rules.entryQuoteByPair.has(intel.pair.address.toLowerCase()))
    why.push(note("gate_pair_decimals", { symbol: intel.pair.symbol, decimals: intel.pair.decimals }));
  if (score.total < rules.minScore) why.push(note("gate_score", { score: score.total, min: rules.minScore }));

  // Missing calldata is a refusal, not a pass: the two rules below cannot run without it.
  if (!intel.tx) why.push(note("gate_tx_unreadable"));
  else {
    const dev = devSharePct(intel.tx);
    if (dev > rules.maxDevSharePct) why.push(note("gate_dev", { pct: dev.toFixed(2), max: rules.maxDevSharePct }));
    if (intel.tx.exemptions.length > rules.maxExemptWallets) why.push(note("gate_exempt", { n: intel.tx.exemptions.length, max: rules.maxExemptWallets }));
  }

  if (!intel.record) why.push(note("gate_no_record"));
  else if (Number(intel.record.creatorTaxBps) > rules.maxCreatorTaxBps) why.push(note("gate_tax", { pct: Number(intel.record.creatorTaxBps) / 100, max: rules.maxCreatorTaxBps / 100 }));

  if (rules.requireSocials && !socialsOf(intel.meta).any) why.push(note("gate_no_socials"));

  if (rules.keyword) {
    const hay = `${intel.meta?.name ?? ""} ${intel.meta?.symbol ?? ""} ${intel.meta?.description ?? ""}`;
    if (!rules.keyword.test(hay)) why.push(note("gate_keyword", { pattern: String(rules.keyword) }));
  }
  if (rules.deployers.size && !rules.deployers.has(intel.ev.deployer.toLowerCase())) why.push(note("gate_deployer"));

  if (!intel.curve) why.push(note("gate_curve_unreadable"));
  else if (intel.curve.graduated || intel.curve.readyToGraduate) why.push(note("gate_curve_closed"));

  return { fire: why.length === 0, why };
}

export function entryQuoteFor(rules: EngineRules, pair: Pick<PairInfo, "address" | "decimals">): bigint {
  return rules.entryQuoteByPair.get(pair.address.toLowerCase()) ?? rules.entryQuote;
}
