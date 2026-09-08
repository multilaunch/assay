import { factoryAbi } from "../abi/pons.js";
import { client } from "../chain/clients.js";
import { PONS } from "../chain/config.js";
import { all, isResolved, rewrite, type Entry, type Outcome, type Verdict } from "./journal.js";

/**
 * Turning the journal into a verdict on the verdicts.
 *
 * A launch is only judged once it has had a fair chance. Under that age it stays `pending` and is
 * left out of every rate, otherwise a quiet hour would look like the score suddenly got worse.
 */

/** How long a launch gets before we call it. Most graduations on this chain happen inside an hour. */
export const MATURE_MS = 6 * 60 * 60 * 1000;

const PHASES = ["NotGraduated", "Swept", "PoolCreated", "Rescued"] as const;

/**
 * Reads the current phase of every unresolved, mature entry and writes the outcome back.
 * Returns how many it settled. Safe to run repeatedly; resolved rows are skipped.
 */
export async function resolveOutcomes(now = Date.now(), batch = 60): Promise<{ checked: number; settled: number; pending: number }> {
  const entries = await all();
  const todo = entries.filter((e) => !isResolved(e) && now - e.t >= MATURE_MS);
  const stillYoung = entries.filter((e) => !isResolved(e) && now - e.t < MATURE_MS).length;
  if (todo.length === 0) return { checked: 0, settled: 0, pending: stillYoung };

  let settled = 0;
  for (let i = 0; i < todo.length; i += batch) {
    const slice = todo.slice(i, i + batch);
    const res = await client.multicall({
      contracts: slice.map((e) => ({ address: PONS.factory, abi: factoryAbi, functionName: "getLaunchedToken" as const, args: [e.token] as const })),
      allowFailure: true,
    });
    slice.forEach((e, k) => {
      const r = res[k];
      if (!r || r.status !== "success") return;
      const rec = r.result as { phase: number; exists: boolean };
      if (!rec.exists) return;
      const phase = PHASES[rec.phase] ?? "NotGraduated";
      e.outcome = phase === "PoolCreated" ? "graduated" : "died";
      e.resolvedAt = now;
      settled++;
    });
  }

  // last write per token wins, which also drops the duplicate a restart can leave behind
  const byToken = new Map<string, Entry>();
  for (const e of entries) byToken.set(e.token.toLowerCase(), e);
  rewrite([...byToken.values()].sort((a, b) => a.t - b.t));
  return { checked: todo.length, settled, pending: stillYoung };
}

export interface Bucket {
  verdict: Verdict | "all";
  judged: number;
  graduated: number;
  /** graduated / judged */
  rate: number;
  pending: number;
}

export interface Report {
  buckets: Bucket[];
  /** the rate across everything we judged, which is what any single bucket has to beat */
  base: number;
  total: number;
  pending: number;
  from: number | null;
  to: number | null;
  /** score band -> graduation rate, for reading where the useful threshold actually sits */
  bands: { from: number; to: number; judged: number; graduated: number; rate: number }[];
}

export async function report(entries?: Entry[]): Promise<Report> {
  const rows = entries ?? (await all());
  const judged = rows.filter(isResolved);
  const pending = rows.length - judged.length;

  const bucket = (v: Verdict | "all"): Bucket => {
    const set = v === "all" ? judged : judged.filter((e) => e.verdict === v);
    const grad = set.filter((e) => e.outcome === "graduated").length;
    return {
      verdict: v,
      judged: set.length,
      graduated: grad,
      rate: set.length ? grad / set.length : 0,
      pending: (v === "all" ? rows : rows.filter((e) => e.verdict === v)).length - set.length,
    };
  };

  const edges = [0, 45, 60, 75, 90, 101];
  const bands = edges.slice(0, -1).map((lo, i) => {
    const hi = edges[i + 1]!;
    const set = judged.filter((e) => e.score >= lo && e.score < hi);
    const grad = set.filter((e) => e.outcome === "graduated").length;
    return { from: lo, to: hi - 1, judged: set.length, graduated: grad, rate: set.length ? grad / set.length : 0 };
  });

  const times = rows.map((e) => e.t).sort((a, b) => a - b);
  return {
    buckets: [bucket("FIRE"), bucket("WATCH"), bucket("SKIP"), bucket("all")],
    base: bucket("all").rate,
    total: rows.length,
    pending,
    from: times[0] ?? null,
    to: times[times.length - 1] ?? null,
    bands,
  };
}

/**
 * How much better a bucket is than picking at random from everything judged. 1.0 means the verdict
 * told you nothing. This is the number that decides whether the score is worth anything.
 */
export const lift = (b: Bucket, base: number): number | null => (base > 0 && b.judged > 0 ? b.rate / base : null);

/**
 * Wilson lower bound at 95%. With 3 graduations out of 12 the point estimate is 25%, which is not
 * a fact about anything; this is the rate the sample actually supports. Quoting the point estimate
 * off a small sample is how a scoring tool ends up lying by accident.
 */
export function wilsonLower(successes: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / d);
}

/** Below this many judged launches a bucket's rate is noise and should be labelled as such. */
export const THIN = 30;
