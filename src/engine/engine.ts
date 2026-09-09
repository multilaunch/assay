import type { Address } from "viem";
import { DEAD } from "../chain/config.js";
import { DeployerIndex } from "../pons/deployers.js";
import { watchLaunches, type LaunchEvent } from "../pons/detect.js";
import { devSharePct, enrichLaunch, type LaunchIntel } from "../pons/enrich.js";
import { record } from "../track/journal.js";
import { FarmDetector, type Cohort } from "../pons/farm.js";
import { scoreLaunch, type Score } from "../score/score.js";
import { buyOnCurve, sellOnCurve } from "../trade/curveTrade.js";
import { closeWithExit, exitReason, openPosition, openPositions, pnlPct, updatePosition } from "../trade/positions.js";
import { curveState, waitForOpeningTax } from "../trade/state.js";
import { readMark, resolveVenue } from "../trade/venue.js";
import { sellIntoPool } from "../trade/poolTrade.js";
import { getAccount } from "../trade/wallet.js";
import { decide, entryQuoteFor, type EngineRules } from "./rules.js";

export type EngineEvent =
  | { kind: "launch"; at: number; intel: LaunchIntel; score: Score; fire: boolean; why: string[]; farmTwins: number; farmKey: string | null; deployer: { prior: number; graduated: number } | null; readMs: number }
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
  /** every launch still in the window sharing one fingerprint, and what that fingerprint is */
  farmCohort: (key: string) => Cohort;
  /** sell a position now, whatever the exit rules say */
  closeNow: (positionId: string) => Promise<{ quoteOut: bigint; pnlPct: number; venue: string }>;
  rules: EngineRules;
}

/**
 * Session spend, counted from the moment a launch clears the gates and not from the moment its buy
 * lands. Between the two sit the tax wait and a receipt: up to fifteen seconds in which four
 * launches can be in flight, and four launches that all read the figure before any of them adds to
 * it all pass a budget that fits one.
 */
export class SessionSpend {
  private wei = 0n;
  total(): bigint { return this.wei; }
  /** Take `amount` now. The returned function gives it back if the buy never happens. */
  reserve(amount: bigint): () => void {
    this.wei += amount;
    let open = true;
    return () => { if (open) { open = false; this.wei -= amount; } };
  }
}

/**
 * Run `job` at most once per id at a time; whoever arrives second is answered null.
 *
 * The claim has to be taken after the last await before the sell and not at the top of the pass. A
 * mark takes seconds, and two passes that both read the set before either has written to it will
 * both sell the same position, on the same stale token balance.
 */
export async function claimOnce<T>(held: Set<string>, id: string, job: () => Promise<T>): Promise<T | null> {
  if (held.has(id)) return null;
  held.add(id);
  try { return await job(); } finally { held.delete(id); }
}

/** Wrap an interval body so a pass that outlives its own tick is skipped rather than overlapped. */
export function serialized(body: () => Promise<void>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try { await body(); } finally { running = false; }
  };
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
  const spend = new SessionSpend();
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
      const { twins, key: farmKey } = farms.observe(intel);
      const deployer = index.lookup(ev.deployer, ev.token);
      const score = scoreLaunch(intel, { deployer, farmTwins: twins });
      const d = decide(intel, score, rules, { openCount: openPositions().length + busy.size, farmTwins: twins, spent: spend.total() });
      if (d.fire && paused) d.why.push(live ? "not armed" : "dry run not started");

      const symbol = intel.meta?.symbol ? `$${intel.meta.symbol}` : ev.token.slice(0, 10);
      // Written before any decision, so the record is of what the score said and not of what we did
      // about it. Checking yourself only means something if you cannot pick which calls to keep.
      record({
        t: t0, token: ev.token, curve: ev.curve, deployer: ev.deployer,
        symbol: intel.meta?.symbol ?? null, score: score.total, verdict: score.verdict,
        devPct: intel.tx ? devSharePct(intel.tx) : null,
        taxBps: intel.record ? Number(intel.record.creatorTaxBps) : null,
        exempt: intel.tx?.exemptions.length ?? null,
        farmTwins: twins, farmKey,
        deployerPrior: deployer?.prior ?? null, deployerGraduated: deployer?.graduated ?? null,
        pair: intel.pair.symbol, pairNative: intel.pair.native,
      });
      emit({ kind: "launch", at: t0, intel, score, fire: d.why.length === 0, why: d.why, farmTwins: twins, farmKey, deployer, readMs: Date.now() - t0 });
      if (d.why.length > 0) return;

      busy.add(ev.token);
      // Reserved in the same synchronous stroke as busy.add. The budget gate inside decide() only
      // means anything if the money has left the figure before the next launch reads it.
      // One value for the gate, the reservation, the buy and the record. Reading it twice is how
      // the budget ends up counting something other than what was spent.
      const quoteIn = entryQuoteFor(rules, intel.pair);
      const release = spend.reserve(quoteIn);
      let bought = false;
      try {
        emit({ kind: "draw", at: Date.now(), token: ev.token, symbol });
        const w = await waitForOpeningTax(ev.curve, recipient, rules.maxOpeningTaxBps, rules.maxWaitMs);
        if (!w.ok) { emit({ kind: "hold", at: Date.now(), token: ev.token, symbol, taxBps: w.taxBps, waitedMs: w.waitedMs }); return; }

        // re-read the curve after the wait: three seconds is long enough for the state to move
        const cv = await curveState(ev.curve, recipient);
        if (cv.graduated || cv.readyToGraduate) { emit({ kind: "hold", at: Date.now(), token: ev.token, symbol, taxBps: w.taxBps, waitedMs: w.waitedMs }); return; }

        const res = await buyOnCurve(ev.curve, cv, quoteIn, rules.slippageBps, { dryRun: !live, pairToken: intel.pair.address, native: intel.pair.native });
        bought = true;
        const tokens = res.actual ?? res.quoted;
        const pos = openPosition({
          token: ev.token, curve: ev.curve, symbol: intel.meta?.symbol ?? "?", name: intel.meta?.name ?? "?",
          pairSymbol: intel.pair.symbol, pairDecimals: intel.pair.decimals,
          openedAt: Math.floor(Date.now() / 1000), entryTx: res.hash, dryRun: !live,
          entryQuote: quoteIn.toString(), tokens: tokens.toString(),
        });
        emit({ kind: "fire", at: Date.now(), token: ev.token, symbol, quoteIn, tokens, taxBps: w.taxBps, waitedMs: w.waitedMs, hash: res.hash, live, positionId: pos.id });
      } finally { busy.delete(ev.token); if (!bought) release(); }
    } catch (e) {
      emit({ kind: "error", at: Date.now(), where: ev.token, message: (e as Error).message.split("\n")[0]?.slice(0, 120) ?? "" });
    } finally { inFlight--; }
  };

  const sellOut = async (positionId: string, reason: string): Promise<{ quoteOut: bigint; pnlPct: number; venue: string }> => {
    // Read from the store rather than from whatever the caller captured before its own awaits.
    const pos = openPositions().find((p) => p.id === positionId);
    if (!pos) throw new Error("no open position with that id");
    const tokens = BigInt(pos.tokens);
    // A curve read that throws means we do not know where this trades. Calling that a graduation
    // turns one failed multicall into a stop loss reported as "the launch is between the curve and
    // the pool", which is a claim about the protocol and is false. Let it out and try again in five
    // seconds.
    const cv = await curveState(pos.curve, recipient);
    let out: bigint;
    let hash: string | undefined;
    let venue = "curve";
    if (!cv.graduated && !cv.readyToGraduate) {
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
    closeWithExit(positionId, { at: Math.floor(Date.now() / 1000), tokens: tokens.toString(), quoteOut: out.toString(), reason, tx: hash as `0x${string}` | undefined, dryRun: !live }, out.toString());
    emit({ kind: "exit", at: Date.now(), positionId, symbol: pos.symbol, quoteOut: out, pnlPct: realized, reason, venue, hash });
    return { quoteOut: out, pnlPct: realized, venue };
  };

  const manage = serialized(async (): Promise<void> => {
    for (const pos of openPositions()) {
      if (closing.has(pos.id)) continue;
      try {
        const m = await readMark(pos.token, pos.curve, BigInt(pos.tokens));
        if (m.status === "swept") { emit({ kind: "swept", at: Date.now(), positionId: pos.id, symbol: pos.symbol }); continue; }
        // An RPC that would not answer is our problem, not a protocol state, and the position keeps
        // its exit rules unevaluated until the next pass rather than being reported as swept.
        if (m.status === "unreadable") { emit({ kind: "error", at: Date.now(), where: `mark ${pos.symbol}`, message: m.why }); continue; }
        const peak = BigInt(pos.peakQuote) > m.quote ? BigInt(pos.peakQuote) : m.quote;
        updatePosition(pos.id, { lastQuote: m.quote.toString(), lastAt: Math.floor(Date.now() / 1000), peakQuote: peak.toString() });
        emit({ kind: "mark", at: Date.now(), positionId: pos.id, symbol: pos.symbol, quote: m.quote, pnlPct: pnlPct(pos, m.quote), venue: m.venue });
        const reason = exitReason({ ...pos, peakQuote: peak.toString() }, m.quote, rules.exits);
        if (reason) await claimOnce(closing, pos.id, () => sellOut(pos.id, reason));
      } catch (e) {
        emit({ kind: "error", at: Date.now(), where: `manage ${pos.symbol}`, message: (e as Error).message.split("\n")[0]?.slice(0, 120) ?? "" });
      }
    }
  });

  const stopWatch = watchLaunches((ev) => { void onLaunch(ev); });
  const timer = setInterval(() => { void manage(); }, 5_000);

  return {
    stop: () => { stopWatch(); clearInterval(timer); clearInterval(sweep); index.stop(); },
    pause: () => { paused = true; emit({ kind: "state", at: Date.now(), paused, spent: spend.total() }); },
    resume: () => { paused = false; emit({ kind: "state", at: Date.now(), paused, spent: spend.total() }); },
    isPaused: () => paused,
    farmCohort: (key: string) => farms.cohort(key),
    spent: () => spend.total(),
    closeNow: async (positionId: string) => {
      if (!openPositions().some((p) => p.id === positionId)) throw new Error("no open position with that id");
      const done = await claimOnce(closing, positionId, () => sellOut(positionId, "closed by hand"));
      if (!done) throw new Error("already closing");
      return done;
    },
    rules,
  };
}
