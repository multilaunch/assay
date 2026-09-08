import { appendFileSync, createReadStream, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import type { Address } from "viem";

/**
 * Append-only record of what the score said, so we can find out later whether it was right.
 *
 * A scoring tool that never checks itself is just an opinion. One line per launch, written the
 * moment it is judged; the outcome gets filled in hours later by `resolve`.
 */

export type Verdict = "FIRE" | "WATCH" | "SKIP";
export type Outcome = "graduated" | "died" | "pending";

export interface Entry {
  /** unix ms when we scored it */
  t: number;
  token: Address;
  curve: Address;
  deployer: Address;
  symbol: string | null;
  score: number;
  verdict: Verdict;
  /** the inputs, so a later reader can re-examine the rule without re-reading the chain */
  devPct: number | null;
  taxBps: number | null;
  exempt: number | null;
  farmTwins: number;
  deployerPrior: number | null;
  deployerGraduated: number | null;
  pair: string;
  pairNative: boolean;
  /** filled in by resolve() */
  outcome?: Outcome;
  /** unix ms when the outcome was written */
  resolvedAt?: number;
  /** how far along the curve it got, 0..1, at resolution time */
  peakFill?: number;
}

const dir = () => process.env.HOODTERM_DATA ?? resolve(process.cwd(), "data");
export const journalPath = (): string => resolve(dir(), "journal.jsonl");

let warned = false;

/** Never throws. A failed write must not take the engine down with it. */
export function record(e: Entry): void {
  try {
    const f = journalPath();
    mkdirSync(dirname(f), { recursive: true });
    appendFileSync(f, JSON.stringify(e) + "\n");
  } catch (err) {
    if (!warned) {
      warned = true;
      console.error(`journal: ${(err as Error).message}. Scoring continues, accuracy will be incomplete.`);
    }
  }
}

/** Streams the file so a journal with a million lines does not need a million lines of heap. */
export async function* read(): AsyncGenerator<Entry> {
  const f = journalPath();
  if (!existsSync(f)) return;
  const rl = createInterface({ input: createReadStream(f, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line) as Entry; } catch { /* a torn last line after a crash; skip it */ }
  }
}

export async function all(): Promise<Entry[]> {
  const out: Entry[] = [];
  for await (const e of read()) out.push(e);
  return out;
}

/**
 * Rewrites the file with outcomes merged in, keyed by token. Later entries win, which also
 * collapses the duplicate a re-run would otherwise leave behind.
 */
export function rewrite(entries: Entry[]): void {
  const f = journalPath();
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
  renameSync(tmp, f);
}

export const isResolved = (e: Entry): boolean => e.outcome === "graduated" || e.outcome === "died";
