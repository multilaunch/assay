import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Address, Hex } from "viem";

/**
 * Positions live in one JSON file under data/. No database, no daemon. Writes are atomic
 * (temp file + rename) so a crash mid-write cannot leave a half-written ledger.
 * The file holds token addresses and amounts. It never holds keys.
 */

export interface Exit {
  at: number;
  tokens: string;
  quoteOut: string;
  reason: string;
  tx?: Hex | undefined;
  dryRun: boolean;
}

export interface Position {
  id: string;
  token: Address;
  curve: Address;
  symbol: string;
  name: string;
  /** the pair the curve trades against; marks and PnL are in these units */
  pairSymbol: string;
  pairDecimals: number;
  openedAt: number;
  entryTx?: Hex | undefined;
  dryRun: boolean;
  /** quote spent on entry, wei of the pair asset */
  entryQuote: string;
  tokens: string;
  /** last mark and the peak it reached, for the trailing stop */
  lastQuote: string;
  peakQuote: string;
  lastAt: number;
  status: "open" | "closed";
  exits: Exit[];
}

export interface ExitRules {
  takeProfitPct: number;
  stopLossPct: number;
  trailingPct: number;
  maxHoldMin: number;
}

const FILE = () => resolve(process.env.HOODTERM_DATA ?? resolve(process.cwd(), "data"), "positions.json");

function load(): Position[] {
  const f = FILE();
  if (!existsSync(f)) return [];
  const raw = readFileSync(f, "utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (e) { throw corrupt(f, (e as Error).message); }
  if (!Array.isArray(parsed)) throw corrupt(f, "the file is not an array of positions");
  return parsed as Position[];
}

/**
 * An unreadable ledger is not an empty one. Every writer here does load → mutate → save, so
 * answering a bad parse with [] would write the truncation back and lose every open position:
 * tokens the engine is holding, never marked and never sold again. Move the file somewhere a human
 * can look at it and let the caller fail instead.
 */
function corrupt(f: string, why: string): Error {
  const aside = `${f}.corrupt-${Date.now()}`;
  renameSync(f, aside);
  return new Error(`${f} could not be read (${why}); it has been moved to ${aside} and not overwritten`);
}

function save(all: Position[]): void {
  const f = FILE();
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2));
  renameSync(tmp, f);
}

export const allPositions = (): Position[] => load();
export const openPositions = (): Position[] => load().filter((p) => p.status === "open");

export function openPosition(p: Omit<Position, "id" | "status" | "exits" | "lastQuote" | "peakQuote" | "lastAt">): Position {
  const all = load();
  const pos: Position = { ...p, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, status: "open", exits: [], lastQuote: p.entryQuote, peakQuote: p.entryQuote, lastAt: Math.floor(Date.now() / 1000) };
  all.push(pos);
  save(all);
  return pos;
}

export function updatePosition(id: string, patch: Partial<Position>): Position | null {
  const all = load();
  const i = all.findIndex((p) => p.id === id);
  if (i < 0) return null;
  const next = { ...all[i]!, ...patch };
  all[i] = next;
  save(all);
  return next;
}

/**
 * Close a position with one exit appended to whatever is on disk at this moment.
 *
 * A sell takes a receipt's worth of seconds and the mark loop keeps writing to the record for the
 * whole of it, so the caller's copy of `exits` is stale by the time the sell lands; appending to
 * that copy silently drops any exit recorded meanwhile.
 */
export function closeWithExit(id: string, exit: Exit, lastQuote: string): Position | null {
  const all = load();
  const i = all.findIndex((p) => p.id === id);
  if (i < 0) return null;
  const cur = all[i]!;
  const next: Position = { ...cur, status: "closed", lastQuote, exits: [...cur.exits, exit] };
  all[i] = next;
  save(all);
  return next;
}

/** Pure: which exit rule, if any, fires at this mark. Kept free of IO so it is trivially testable. */
export function exitReason(pos: Pick<Position, "entryQuote" | "peakQuote" | "openedAt">, markQuote: bigint, rules: ExitRules, now = Math.floor(Date.now() / 1000)): string | null {
  const entry = BigInt(pos.entryQuote);
  if (entry === 0n) return null;
  const pnlPct = Number(((markQuote - entry) * 10_000n) / entry) / 100;
  if (pnlPct >= rules.takeProfitPct) return `take profit +${pnlPct.toFixed(1)}%`;
  if (pnlPct <= -rules.stopLossPct) return `stop loss ${pnlPct.toFixed(1)}%`;
  const peak = BigInt(pos.peakQuote);
  if (peak > entry) {
    const fromPeak = Number(((peak - markQuote) * 10_000n) / peak) / 100;
    if (fromPeak >= rules.trailingPct) return `trailing stop ${fromPeak.toFixed(1)}% below the peak`;
  }
  const heldMin = (now - pos.openedAt) / 60;
  if (heldMin >= rules.maxHoldMin) return `max hold ${Math.round(heldMin)} min`;
  return null;
}

export const pnlPct = (pos: Pick<Position, "entryQuote">, mark: bigint): number => {
  const entry = BigInt(pos.entryQuote);
  return entry === 0n ? 0 : Number(((mark - entry) * 10_000n) / entry) / 100;
};
