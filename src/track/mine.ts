import { wilsonLower, wilsonUpper } from "./accuracy.js";
import { isResolved, type Entry } from "./journal.js";

/** What counts as a win. Graduation is the cheap one; the price labels are the honest ones. */
export type Label = "graduated" | "peak2x" | "peak5x" | "endUp";

export const LABELS: Record<Label, { won: (e: Entry) => boolean; judged: (e: Entry) => boolean; describe: string }> = {
  graduated: { won: (e) => e.outcome === "graduated", judged: isResolved, describe: "the pool opened" },
  peak2x: { won: (e) => (e.peakX ?? 0) >= 2, judged: (e) => e.peakX !== undefined || e.trades !== undefined, describe: "doubled at some point after the opening tax" },
  peak5x: { won: (e) => (e.peakX ?? 0) >= 5, judged: (e) => e.peakX !== undefined || e.trades !== undefined, describe: "went 5x at some point after the opening tax" },
  endUp: { won: (e) => (e.endX ?? 0) > 1, judged: (e) => e.endX !== undefined || e.trades !== undefined, describe: "was still above its entry price at the end of the window" },
};

/**
 * Looking for rules in the journal instead of in my own head.
 *
 * Every number in score.ts is a judgement I made from a few hours of watching the chain. This
 * checks those judgements, and hunts for ones I missed, by sweeping thresholds over the signals
 * already recorded per launch and asking which of them actually separate a graduation from a death.
 *
 * The whole difficulty is not finding candidates — a few dozen thresholds is a millisecond — it is
 * not fooling yourself with the ones you find. Two defences, and neither is optional:
 *
 *   The journal is split by time, never at random. Earlier launches propose, later launches judge.
 *   A rule fitted to a farm that ran on Tuesday and gone by Thursday looks perfect until it meets
 *   Thursday. Splitting at random would leak Thursday into the fit and hide exactly that.
 *
 *   Every candidate is counted. Testing forty predicates at 95% confidence buys you two that clear
 *   on luck alone, so the number of candidates is reported next to the results and the holdout
 *   column is the only one worth believing.
 */

export interface Candidate {
  /** printed verbatim; should read like a rule, because that is what it may become */
  label: string;
  group: string;
  test: (e: Entry) => boolean;
}

const has = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined;

export function candidates(): Candidate[] {
  const out: Candidate[] = [];
  const add = (group: string, label: string, test: (e: Entry) => boolean) => out.push({ group, label, test });

  for (const t of [45, 55, 65, 75, 85, 90]) add("score", `score >= ${t}`, (e) => e.score >= t);

  add("opening buy", "opening buy = 0", (e) => has(e.devPct) && e.devPct === 0);
  add("opening buy", "opening buy 0-1%", (e) => has(e.devPct) && e.devPct > 0 && e.devPct < 1);
  add("opening buy", "opening buy 1-6%", (e) => has(e.devPct) && e.devPct >= 1 && e.devPct <= 6);
  add("opening buy", "opening buy 6-10%", (e) => has(e.devPct) && e.devPct > 6 && e.devPct <= 10);
  add("opening buy", "opening buy > 10%", (e) => has(e.devPct) && e.devPct > 10);
  add("opening buy", "opening buy unreadable", (e) => !has(e.devPct));

  add("creator tax", "creator tax = 0", (e) => has(e.taxBps) && e.taxBps === 0);
  add("creator tax", "creator tax 1-200 bps", (e) => has(e.taxBps) && e.taxBps > 0 && e.taxBps <= 200);
  add("creator tax", "creator tax 201-500 bps", (e) => has(e.taxBps) && e.taxBps > 200 && e.taxBps <= 500);
  add("creator tax", "creator tax > 500 bps", (e) => has(e.taxBps) && e.taxBps > 500);

  add("bundle", "no exempt wallets", (e) => e.exempt === 0);
  add("bundle", "1-3 exempt wallets", (e) => has(e.exempt) && e.exempt >= 1 && e.exempt <= 3);
  add("bundle", "4+ exempt wallets", (e) => has(e.exempt) && e.exempt >= 4);
  add("bundle", "exempt wallets unreadable", (e) => !has(e.exempt));

  add("farm", "no farm twins", (e) => e.farmTwins === 0);
  add("farm", "1 farm twin", (e) => e.farmTwins === 1);
  add("farm", "2+ farm twins", (e) => e.farmTwins >= 2);

  add("deployer", "fresh deployer", (e) => e.deployerPrior === 0);
  add("deployer", "deployer 1-4 prior launches", (e) => has(e.deployerPrior) && e.deployerPrior >= 1 && e.deployerPrior <= 4);
  add("deployer", "deployer 5+ prior launches", (e) => has(e.deployerPrior) && e.deployerPrior >= 5);
  add("deployer", "deployer has graduated before", (e) => has(e.deployerGraduated) && e.deployerGraduated >= 1);
  add("deployer", "serial deployer, none graduated", (e) => has(e.deployerPrior) && e.deployerPrior >= 5 && e.deployerGraduated === 0);

  add("pair", "paired with ETH", (e) => e.pairNative);
  add("pair", "paired with something else", (e) => !e.pairNative);

  return out;
}

export interface Side {
  n: number;
  graduated: number;
  rate: number;
  lift: number;
  /** Wilson bounds at 95% on this side's rate */
  lo: number;
  hi: number;
}

export interface Finding {
  label: string;
  group: string;
  train: Side;
  holdout: Side;
  /**
   * keeps  — clears on the training half and still separates on the holdout
   * fades  — looked real while fitting and did not survive
   * thin   — too few launches on one side to judge either way
   */
  verdict: "keeps" | "fades" | "thin";
  /** which way it points: graduations more often, or less */
  direction: "up" | "down";
}

export interface MineReport {
  findings: Finding[];
  tested: number;
  trainN: number;
  holdoutN: number;
  trainBase: number;
  holdoutBase: number;
  splitAt: number | null;
  label: Label;
  /** how many of `tested` you would expect to clear on the training half by luck */
  expectedFalse: number;
}

function side(rows: Entry[], base: number, won: (e: Entry) => boolean): Side {
  const n = rows.length;
  const graduated = rows.filter(won).length;
  const rate = n ? graduated / n : 0;
  return { n, graduated, rate, lift: base > 0 ? rate / base : 0, lo: wilsonLower(graduated, n), hi: wilsonUpper(graduated, n) };
}

export interface MineOptions {
  /** share of the journal, by time, held back for judging */
  holdout?: number;
  /** below this many launches on a side, say nothing */
  minN?: number;
  /** what counts as a win; graduation by default, for continuity with what came before */
  label?: Label;
}

export function mine(entries: Entry[], opts: MineOptions = {}): MineReport {
  const holdoutShare = Math.min(0.6, Math.max(0.1, opts.holdout ?? 0.3));
  const minN = opts.minN ?? 40;

  const { won, judged: isJudged } = LABELS[opts.label ?? "graduated"];
  const judged = entries.filter(isJudged).sort((a, b) => a.t - b.t);
  const cut = Math.floor(judged.length * (1 - holdoutShare));
  const trainRows = judged.slice(0, cut);
  const holdRows = judged.slice(cut);

  const trainBase = trainRows.length ? trainRows.filter(won).length / trainRows.length : 0;
  const holdoutBase = holdRows.length ? holdRows.filter(won).length / holdRows.length : 0;

  const cands = candidates();
  const findings: Finding[] = [];

  for (const cand of cands) {
    const train = side(trainRows.filter(cand.test), trainBase, won);
    const holdout = side(holdRows.filter(cand.test), holdoutBase, won);
    const direction: "up" | "down" = train.rate >= trainBase ? "up" : "down";

    // A predicate has to separate on the half that fitted it before the holdout is worth reading.
    // Upward: its floor beats the base. Downward: its ceiling falls short of it.
    const clearsTrain = direction === "up" ? train.lo > trainBase : train.hi < trainBase;
    const survives = direction === "up" ? holdout.lo > holdoutBase : holdout.hi < holdoutBase;

    let verdict: Finding["verdict"];
    if (train.n < minN || holdout.n < minN) verdict = "thin";
    else if (clearsTrain && survives) verdict = "keeps";
    else verdict = "fades";

    findings.push({ label: cand.label, group: cand.group, train, holdout, verdict, direction });
  }

  // strongest first, and the ones that survived above the ones that did not
  const rank = { keeps: 0, fades: 1, thin: 2 } as const;
  findings.sort((a, b) => rank[a.verdict] - rank[b.verdict] || Math.abs(b.holdout.lift - 1) - Math.abs(a.holdout.lift - 1));

  return {
    findings,
    tested: cands.length,
    trainN: trainRows.length,
    holdoutN: holdRows.length,
    trainBase,
    holdoutBase,
    splitAt: holdRows[0]?.t ?? null,
    label: opts.label ?? "graduated",
    expectedFalse: cands.length * 0.05,
  };
}
