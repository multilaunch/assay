import { progress } from "../pons/curve.js";
import { devSharePct, socialsOf, type CurveActivity, type LaunchIntel } from "../pons/enrich.js";
import type { DeployerRecord } from "../pons/deployers.js";

export type Verdict = "FIRE" | "WATCH" | "SKIP";

export interface Score {
  total: number;
  verdict: Verdict;
  /** every line is "+n reason" / "-n reason"; the log and the board print them verbatim */
  reasons: string[];
  /** things worth knowing that did not move the number */
  flags: string[];
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
  const reasons: string[] = [];
  const flags: string[] = [];
  const add = (pts: number, why: string) => { s += pts; reasons.push(`${pts >= 0 ? "+" : ""}${pts} ${why}`); };

  // ---- unknowns are not good news --------------------------------------------------------------
  // Every rule below is skipped when its input is missing. Left alone, a launch nobody could read
  // outscores one that was read and looked bad, because the penalties simply never fired. So the
  // absence of the two calldata signals is itself a penalty, sized like the ones it replaces.
  if (!intel.tx) add(-20, "launch transaction unreadable: opening buy and declared bundle unknown");
  if (!intel.record) add(-15, "no factory record: creator tax and fee recipient unknown");
  if (!intel.curve) add(-10, "curve unreadable");

  // ---- the launcher's own skin ----------------------------------------------------------------
  if (intel.tx) {
    const dev = devSharePct(intel.tx);
    if (dev === 0) add(-10, "no opening buy, nothing at stake");
    else if (dev < 1) add(0, `opening buy ${dev.toFixed(2)}% of supply, token-sized`);
    else if (dev <= 6) add(15, `opening buy ${dev.toFixed(2)}%, inside the 1–6% band`);
    else if (dev <= 10) add(0, `opening buy ${dev.toFixed(2)}%, heavy`);
    else add(-25, `opening buy ${dev.toFixed(2)}%, over 10%: one wallet can flatten the curve`);
    if (intel.tx.recipient.toLowerCase() !== intel.tx.from.toLowerCase()) flags.push(`opening buy minted to ${intel.tx.recipient}, not the launcher`);
  }

  // ---- what the creator charges and who is paid -------------------------------------------------
  if (intel.record) {
    const tax = Number(intel.record.creatorTaxBps);
    if (tax === 0) add(5, "no creator tax");
    else if (tax <= 200) add(10, `creator tax ${tax / 100}%: earns on volume, has a reason to keep posting`);
    else if (tax <= 500) add(-5, `creator tax ${tax / 100}%`);
    else add(-25, `creator tax ${tax / 100}%: traders pay ${1 + tax / 100}% per side, flow dies`);
    if (intel.tx && intel.record.creatorFeeRecipient.toLowerCase() !== intel.tx.from.toLowerCase()) {
      add(5, "fees routed to a third party (builder / KOL deal shape)");
      flags.push(`fee recipient ${intel.record.creatorFeeRecipient}`);
    }
  }

  // ---- somewhere for flow to come from --------------------------------------------------------
  const soc = socialsOf(intel.meta);
  if (!soc.any) add(-15, "no socials: no one to bring flow");
  else {
    if (soc.x) add(8, "has X");
    if (soc.web) add(8, "has website");
    if (soc.tg) add(3, "has telegram");
  }
  if ((intel.meta?.description?.length ?? 0) >= 40) add(4, "real description");

  // ---- the declared bundle --------------------------------------------------------------------
  if (intel.tx) {
    const n = intel.tx.exemptions.length;
    if (n === 0) add(5, "no wallets exempt from the opening tax");
    else if (n <= 3) add(-5, `${n} wallet${n > 1 ? "s" : ""} exempt from the opening tax`);
    else add(-20, `${n} wallets exempt from the opening tax: a declared bundle`);
  }

  // ---- one operator, many wallets -------------------------------------------------------------
  const twins = ctx.farmTwins ?? 0;
  if (twins >= 2) add(-25, `launch farm: ${twins + 1} launches with this exact fingerprint in 30 min`);
  else if (twins === 1) add(-8, "one earlier launch with this exact fingerprint in 30 min");

  // ---- the deployer's record ------------------------------------------------------------------
  if (ctx.deployer) {
    const { prior, graduated } = ctx.deployer;
    if (prior === 0) add(5, "fresh deployer");
    else if (prior > 0 && graduated / prior >= 0.3) add(15, `deployer graduated ${graduated} of ${prior} recent launches`);
    else if (prior >= 5 && graduated === 0) add(-25, `serial deployer: ${prior} launches, none graduated`);
    else add(-5, `deployer: ${prior} recent launches, ${graduated} graduated`);
  }

  // ---- what happened in the first minute (follow-ups) -----------------------------------------
  if (ctx.activity && intel.curve) {
    const a = ctx.activity;
    if (a.uniqueBuyers >= 10) add(10, `${a.uniqueBuyers} distinct buyers`);
    else if (a.uniqueBuyers >= 4) add(5, `${a.uniqueBuyers} distinct buyers`);
    if (a.buys > 0 && a.earlyBuys === a.buys) add(-10, "every buy so far landed inside the opening-tax window: bots only");
    if (a.sells > a.buys && a.buys > 3) add(-10, "more sells than buys");
    const p = progress(intel.curve);
    if (p >= 0.25 && (ctx.ageSec ?? 999) <= 120) add(10, `${(p * 100).toFixed(0)}% of the curve filled in ${ctx.ageSec}s`);
  }

  // ---- things that change how to read the numbers, not the score ------------------------------
  if (!intel.pair.native) flags.push(`paired with ${intel.pair.symbol} (${intel.pair.decimals} decimals), not ETH`);
  if (intel.record?.buybackEnabled) flags.push("buyback-and-lock enabled");
  if (intel.errors.length) flags.push(`${intel.errors.length} read${intel.errors.length > 1 ? "s" : ""} failed`);

  const total = Math.max(0, Math.min(100, s));
  const fire = ctx.thresholds?.fire ?? 75;
  const watch = ctx.thresholds?.watch ?? 45;
  return { total, verdict: total >= fire ? "FIRE" : total >= watch ? "WATCH" : "SKIP", reasons, flags };
}
