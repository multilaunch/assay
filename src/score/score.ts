import { progress } from "../pons/curve.js";
import { devSharePct, socialsOf, type CurveActivity, type LaunchIntel } from "../pons/enrich.js";
import type { DeployerRecord } from "../pons/deployers.js";
import { note, type Note, type Reason } from "./notes.js";

export type Verdict = "FIRE" | "WATCH" | "SKIP";

export interface Score {
  total: number;
  verdict: Verdict;
  /** a code and its numbers; the reader turns it into a sentence in whatever language it wants */
  reasons: Reason[];
  /** things worth knowing that did not move the number, same shape */
  flags: Note[];
}

export interface ScoreContext {
  deployer?: DeployerRecord | null;
  activity?: CurveActivity | null;
  /** seconds since launch when `activity` was read */
  ageSec?: number;
  /** earlier launches in the window with this exact fingerprint from other wallets */
  farmTwins?: number;
  thresholds?: { fire: number; watch: number };
}

/**
 * Rule-based, explainable, 0–100 from a start of 50. Every rule maps to something the chain records
 * about a launch. The numbers are defaults chosen from what graduated and what did not on Robinhood
 * Chain in early September 2026 and from three hours of watching the Solana funnel with the same
 * signals; they are a starting point, and the board lets you move the ones that matter.
 */
export function scoreLaunch(intel: LaunchIntel, ctx: ScoreContext = {}): Score {
  let s = 50;
  const reasons: Reason[] = [];
  const flags: Note[] = [];
  const add = (points: number, code: string, vars?: Record<string, string | number>) => {
    s += points;
    reasons.push(vars ? { code, points, vars } : { code, points });
  };

  // ---- unknowns are not good news --------------------------------------------------------------
  // Every rule below is skipped when its input is missing. Left alone, a launch nobody could read
  // outscores one that was read and looked bad, because the penalties simply never fired. So the
  // absence of the two calldata signals is itself a penalty, sized like the ones it replaces.
  if (!intel.tx) add(-20, "tx_unreadable");
  if (!intel.record) add(-15, "no_record");
  if (!intel.curve) add(-10, "curve_unreadable");

  // ---- the launcher's own skin ----------------------------------------------------------------
  if (intel.tx) {
    const dev = devSharePct(intel.tx);
    if (dev === 0) add(-10, "dev_none");
    else if (dev < 1) add(0, "dev_tiny", { pct: dev.toFixed(2) });
    else if (dev <= 6) add(15, "dev_band", { pct: dev.toFixed(2) });
    else if (dev <= 10) add(0, "dev_heavy", { pct: dev.toFixed(2) });
    else add(-25, "dev_huge", { pct: dev.toFixed(2) });
    if (intel.tx.recipient.toLowerCase() !== intel.tx.from.toLowerCase()) flags.push(note("flag_mint_elsewhere", { address: intel.tx.recipient }));
  }

  // ---- what the creator charges and who is paid -------------------------------------------------
  if (intel.record) {
    const tax = Number(intel.record.creatorTaxBps);
    if (tax === 0) add(5, "tax_none");
    else if (tax <= 200) add(10, "tax_low", { pct: tax / 100 });
    else if (tax <= 500) add(-5, "tax_mid", { pct: tax / 100 });
    else add(-25, "tax_high", { pct: tax / 100, perSide: 1 + tax / 100 });
    if (intel.tx && intel.record.creatorFeeRecipient.toLowerCase() !== intel.tx.from.toLowerCase()) {
      add(5, "fees_third_party");
      flags.push(note("flag_fee_recipient", { address: intel.record.creatorFeeRecipient }));
    }
  }

  // ---- somewhere for flow to come from --------------------------------------------------------
  const soc = socialsOf(intel.meta);
  if (!soc.any) add(-15, "no_socials");
  else {
    if (soc.x) add(8, "has_x");
    if (soc.web) add(8, "has_web");
    if (soc.tg) add(3, "has_tg");
  }
  if ((intel.meta?.description?.length ?? 0) >= 40) add(4, "real_description");

  // ---- the declared bundle --------------------------------------------------------------------
  if (intel.tx) {
    const n = intel.tx.exemptions.length;
    // An entrypoint whose calldata we could not decode hands back an empty exemption list, which is not
    // the same fact as a launch that declared nobody. Read as the latter it paid +5, so a launch through
    // an unrecognised entrypoint with ten exempt bundle wallets scored the cleanest possible shape here.
    // It costs points instead, sized between the two bundles we can actually see.
    if (intel.tx.via === "unknown") add(-10, "entrypoint_unknown");
    else if (n === 0) add(5, "exempt_none");
    else if (n <= 3) add(-5, "exempt_few", { n });
    else add(-20, "exempt_many", { n });
  }

  // ---- one operator, many wallets -------------------------------------------------------------
  const twins = ctx.farmTwins ?? 0;
  if (twins >= 2) add(-25, "farm_many", { n: twins + 1 });
  else if (twins === 1) add(-8, "farm_one");

  // ---- the deployer's record ------------------------------------------------------------------
  if (ctx.deployer) {
    const { prior, graduated } = ctx.deployer;
    if (prior === 0) add(5, "dep_fresh");
    else if (prior > 0 && graduated / prior >= 0.3) add(15, "dep_good", { graduated, prior });
    else if (prior >= 5 && graduated === 0) add(-25, "dep_serial", { prior });
    else add(-5, "dep_mixed", { prior, graduated });
  }

  // ---- what happened in the first minute (follow-ups) -----------------------------------------
  if (ctx.activity && intel.curve) {
    const a = ctx.activity;
    if (a.uniqueBuyers >= 10) add(10, "buyers_many", { n: a.uniqueBuyers });
    else if (a.uniqueBuyers >= 4) add(5, "buyers_some", { n: a.uniqueBuyers });
    if (a.buys > 0 && a.earlyBuys === a.buys) add(-10, "bots_only");
    if (a.sells > a.buys && a.buys > 3) add(-10, "more_sells");
    const p = progress(intel.curve);
    if (p >= 0.25 && (ctx.ageSec ?? 999) <= 120) add(10, "fast_fill", { pct: (p * 100).toFixed(0), sec: ctx.ageSec ?? 0 });
  }

  // ---- things that change how to read the numbers, not the score ------------------------------
  if (!intel.pair.native) flags.push(note("flag_pair_not_eth", { symbol: intel.pair.symbol, decimals: intel.pair.decimals }));
  if (intel.record?.buybackEnabled) flags.push(note("flag_buyback"));
  if (intel.errors.length) flags.push(note("flag_reads_failed", { n: intel.errors.length }));

  const total = Math.max(0, Math.min(100, s));
  const fire = ctx.thresholds?.fire ?? 75;
  const watch = ctx.thresholds?.watch ?? 45;
  return { total, verdict: total >= fire ? "FIRE" : total >= watch ? "WATCH" : "SKIP", reasons, flags };
}
