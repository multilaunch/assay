import type { Address } from "viem";
import { DEAD } from "../chain/config.js";
import { DeployerIndex } from "../pons/deployers.js";
import { watchLaunches, type LaunchEvent } from "../pons/detect.js";
import { enrichLaunch, type LaunchIntel } from "../pons/enrich.js";
import { FarmDetector } from "../pons/farm.js";
import { scoreLaunch, type Score } from "../score/score.js";
import { buyOnCurve, sellOnCurve } from "../trade/curveTrade.js";
import { exitReason, openPosition, openPositions, pnlPct, updatePosition, type Position } from "../trade/positions.js";
import { curveState, waitForOpeningTax } from "../trade/state.js";
import { markPosition, resolveVenue } from "../trade/venue.js";
import { sellIntoPool } from "../trade/poolTrade.js";
import { getAccount } from "../trade/wallet.js";
import { decide, type EngineRules } from "./rules.js";

export type EngineEvent =
  | { kind: "launch"; at: number; intel: LaunchIntel; score: Score; fire: boolean; why: string[]; farmTwins: number; deployer: { prior: number; graduated: number } | null; readMs: number }
  | { kind: "draw"; at: number; token: Address; symbol: string }
  | { kind: "fire"; at: number; token: Address; symbol: string; quoteIn: bigint; tokens: bigint; taxBps: number; waitedMs: number; hash?: string | undefined; live: boolean; positionId: string }
  | { kind: "hold"; at: number; token: Address; symbol: string; taxBps: number; waitedMs: number }
  | { kind: "mark"; at: number; positionId: string; symbol: string; quote: bigint; pnlPct: number; venue: string }
  | { kind: "exit"; at: number; positionId: string; symbol: string; quoteOut: bigint; pnlPct: number; reason: string; venue: string; hash?: string | undefined }
  | { kind: "swept"; at: number; positionId: string; symbol: string }
  | { kind: "index"; at: number; launches: number; graduations: number; deployers: number }
  | { kind: "state"; at: number; paused: boolean; spent: bigint }
  | { kind: "error"; at: number; where: string; message: string };

export interface EngineOptions {
  live: boolean;
  rules: EngineRules;
  /** read and score, but fire nothing until resume() */
  startPaused?: boolean;
  onEvent?: (e: EngineEvent) => void;
}

export interface Engine {
  stop: () => void;
  pause: () => void;
  resume: () => void;
  isPaused: () => boolean;
  spent: () => bigint;
  /** sell a position now, whatever the exit rules say */
  closeNow: (positionId: string) => Promise<{ quoteOut: bigint; pnlPct: number; venue: string }>;
  rules: EngineRules;
}

/**
 * detect → read → decide → wait at full draw → release → mark every 5 s → exit.
 *
 * The wait is the strategy: a pons launch opens behind a 99 % tax that decays over ~3 s, and the
 * chain has no ordering to buy, so the only question is when to let go. Dry run unless `live`.
 */
export function startEngine(opts: EngineOptions): Engine {
  const { rules, live } = opts;
  const account = getAccount();
  if (live && !account) throw new Error("live mode needs PRIVATE_KEY in .env");
  const recipient: Address = account?.address ?? DEAD;
  const emit = (e: EngineEvent) => opts.onEvent?.(e);

  const index = new DeployerIndex();
  const farms = new FarmDetector();
  const busy = new Set<string>();
  const closing = new Set<string>();
  let paused = opts.startPaused === true;
  let spent = 0n;
  let inFlight = 0;

  index.start(
    (s) => emit({ kind: "index", at: Date.now(), ...s }),
    (e, sec) => emit({ kind: "error", at: Date.now(), where: "deployer index", message: `${e.message.split("\n")[0]?.slice(0, 90) ?? ""}; retry in ${sec} s` }),
  );
  const sweep = setInterval(() => { void index.refreshGraduations().catch(() => undefined); }, 60_000);

  const onLaunch = async (ev: LaunchEvent): Promise<void> => {
    if (inFlight >= 4) return; // a burst of launches must not become a burst of RPC
    inFlight++;
    const t0 = Date.now();
    try {
      index.note(ev);
      const intel = await enrichLaunch(ev, recipient, { retries: 3, retryDelayMs: 400 });
      const { twins } = farms.observe(intel);
      const deployer = index.lookup(ev.deployer, ev.token);
      const score = scoreLaunch(intel, { deployer, farmTwins: twins });
      const d = decide(intel, score, rules, { openCount: openPositions().length + busy.size, farmTwins: twins, spent });
      if (d.fire && paused) d.why.push(live ? "not armed" : "dry run not started");

      const symbol = intel.meta?.symbol ? `$${intel.meta.symbol}` : ev.token.slice(0, 10);
      emit({ kind: "launch", at: t0, intel, score, fire: d.why.length === 0, why: d.why, farmTwins: twins, deployer, readMs: Date.now() - t0 });
      if (d.why.length > 0) return;

      busy.add(ev.token);
      try {
        emit({ kind: "draw", at: Date.now(), token: ev.token, symbol });
        const w = await waitForOpeningTax(ev.curve, recipient, rules.maxOpeningTaxBps, rules.maxWaitMs);
        if (!w.ok) { emit({ kind: "hold", at: Date.now(), token: ev.token, symbol, taxBps: w.taxBps, waitedMs: w.waitedMs }); return; }

        // re-read the curve after the wait: three seconds is long enough for the state to move
        const cv = await curveState(ev.curve, recipient);
        if (cv.graduated || cv.readyToGraduate) { emit({ kind: "hold", at: Date.now(), token: ev.token, symbol, taxBps: w.taxBps, waitedMs: w.waitedMs }); return; }

        const res = await buyOnCurve(ev.curve, cv, rules.entryQuote, rules.slippageBps, { dryRun: !live, pairToken: intel.pair.address, native: intel.pair.native });
        const tokens = res.actual ?? res.quoted;
        spent += rules.entryQuote;
        const pos = openPosition({
          token: ev.token, curve: ev.curve, symbol: intel.meta?.symbol ?? "?", name: intel.meta?.name ?? "?",
          pairSymbol: intel.pair.symbol, pairDecimals: intel.pair.decimals,
          openedAt: Math.floor(Date.now() / 1000), entryTx: res.hash, dryRun: !live,
          entryQuote: rules.entryQuote.toString(), tokens: tokens.toString(),
        });
        emit({ kind: "fire", at: Date.now(), token: ev.token, symbol, quoteIn: rules.entryQuote, tokens, taxBps: w.taxBps, waitedMs: w.waitedMs, hash: res.hash, live, positionId: pos.id });
      } finally { busy.delete(ev.token); }
    } catch (e) {
      emit({ kind: "error", at: Date.now(), where: ev.token, message: (e as Error).message.split("\n")[0]?.slice(0, 120) ?? "" });
    } finally { inFlight--; }
  };

  const sellOut = async (pos: Position, reason: string): Promise<{ quoteOut: bigint; pnlPct: number; venue: string }> => {
    const tokens = BigInt(pos.tokens);
    const cv = await curveState(pos.curve, recipient).catch(() => null);
    let out: bigint;
    let hash: string | undefined;
    let venue = "curve";
    if (cv && !cv.graduated && !cv.readyToGraduate) {
      const r = await sellOnCurve(pos.curve, cv, tokens, rules.slippageBps, { dryRun: !live, token: pos.token });
      out = r.actual ?? r.quoted; hash = r.hash;
    } else {
      // graduated: the venue is the Uniswap v4 pool behind the pons hook, keyed by what the factory
      // recorded for this launch. resolveVenue refuses during the swept gap rather than guessing.
      const v = await resolveVenue(pos.token);
      if (v.venue !== "pool") throw new Error("nothing trades right now (the launch is between the curve and the pool)");
      const r = await sellIntoPool(pos.token, v.record, tokens, rules.slippageBps, { dryRun: !live });
      out = r.quoted; hash = r.hash; venue = "pool";
    }
    const realized = pnlPct(pos, out);
    updatePosition(pos.id, { status: "closed", lastQuote: out.toString(), exits: [...pos.exits, { at: Math.floor(Date.now() / 1000), tokens: tokens.toString(), quoteOut: out.toString(), reason, tx: hash as `0x${string}` | undefined, dryRun: !live }] });
    emit({ kind: "exit", at: Date.now(), positionId: pos.id, symbol: pos.symbol, quoteOut: out, pnlPct: realized, reason, venue, hash });
    return { quoteOut: out, pnlPct: realized, venue };
  };

  const manage = async (): Promise<void> => {
    for (const pos of openPositions()) {
      if (closing.has(pos.id)) continue;
      try {
        const m = await markPosition(pos.token, pos.curve, BigInt(pos.tokens));
        if (!m) { emit({ kind: "swept", at: Date.now(), positionId: pos.id, symbol: pos.symbol }); continue; }
        const peak = BigInt(pos.peakQuote) > m.quote ? BigInt(pos.peakQuote) : m.quote;
        updatePosition(pos.id, { lastQuote: m.quote.toString(), lastAt: Math.floor(Date.now() / 1000), peakQuote: peak.toString() });
        emit({ kind: "mark", at: Date.now(), positionId: pos.id, symbol: pos.symbol, quote: m.quote, pnlPct: pnlPct(pos, m.quote), venue: m.venue });
        const reason = exitReason({ ...pos, peakQuote: peak.toString() }, m.quote, rules.exits);
        if (reason) { closing.add(pos.id); try { await sellOut(pos, reason); } finally { closing.delete(pos.id); } }
      } catch (e) {
        emit({ kind: "error", at: Date.now(), where: `manage ${pos.symbol}`, message: (e as Error).message.split("\n")[0]?.slice(0, 120) ?? "" });
      }
    }
  };

  const stopWatch = watchLaunches((ev) => { void onLaunch(ev); });
  const timer = setInterval(() => { void manage(); }, 5_000);

  return {
    stop: () => { stopWatch(); clearInterval(timer); clearInterval(sweep); index.stop(); },
    pause: () => { paused = true; emit({ kind: "state", at: Date.now(), paused, spent }); },
    resume: () => { paused = false; emit({ kind: "state", at: Date.now(), paused, spent }); },
    isPaused: () => paused,
    spent: () => spent,
    closeNow: async (positionId: string) => {
      const pos = openPositions().find((p) => p.id === positionId);
      if (!pos) throw new Error("no open position with that id");
      if (closing.has(pos.id)) throw new Error("already closing");
      closing.add(pos.id);
      try { return await sellOut(pos, "closed by hand"); } finally { closing.delete(pos.id); }
    },
    rules,
  };
}
