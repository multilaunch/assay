/**
 * What one caller may make the board do.
 *
 * The page is public to read and stays that way, so there is no account to attach a budget
 * to — the budget attaches to the caller's address. What is being rationed is not requests
 * but *work*: reaching the chain. A cache hit costs nothing and is never counted, which is
 * why this is consulted from inside a handler rather than in front of it.
 *
 * Measured before it existed: forty concurrent requests for distinct real tokens took a
 * reader's chart from 1.2 s to 61 s and held it there for two minutes, with every response
 * a 200. The board never fell over; it queued. See work/logs/001-baseline.md.
 *
 * Three bounds, because two did not cover it. A rate alone lets a caller open forty at once
 * and then wait; a per-caller concurrency cap alone lets them hold four open forever. And
 * both together do nothing about forty callers asking once each — measured: the reader's
 * chart went to 72 s with not a single request refused, because forty addresses cost an
 * attacker nothing. So there is a ceiling on the whole board as well.
 *
 * The ceiling is the part that matters, and it is a choice about what failure looks like:
 * refusing some requests quickly, or accepting all of them and making everyone wait a
 * minute. The first is legible — a 429 with a retry-after says what happened. The second
 * looks like the board is broken.
 */

export interface LimitOpts {
  /** chain-backed requests one caller may have running at once */
  inFlight: number;
  /** tokens in the bucket when full — the burst a reader is allowed */
  burst: number;
  /** tokens added per second */
  refillPerSec: number;
  /** forget a caller after this long idle, so the map does not grow forever */
  idleMs: number;
  /** chain-backed requests the whole board may have running at once, across every caller */
  boardInFlight: number;
}

export const DEFAULTS: LimitOpts = {
  // A reader with five rows open re-asks for candles and holders every 20 s. That is well
  // under one a second and never more than a handful at once, so these leave them alone.
  inFlight: 4,
  burst: 20,
  refillPerSec: 0.5,
  idleMs: 10 * 60_000,
  // The RPC gate runs three requests at a time with 400 ms between log calls, so twelve is
  // about four deep — a few seconds of queue, not a minute of it.
  boardInFlight: 12,
};

interface Caller { tokens: number; at: number; running: number }

export type Refusal = { ok: true } | { ok: false; reason: "busy" | "rate" | "board"; retryAfterSec: number };

export class WorkLimit {
  private readonly o: LimitOpts;
  private readonly who = new Map<string, Caller>();
  private running = 0;

  constructor(opts: Partial<LimitOpts> = {}) {
    this.o = { ...DEFAULTS, ...opts };
  }

  private entry(key: string, now: number): Caller {
    let c = this.who.get(key);
    if (!c) { c = { tokens: this.o.burst, at: now, running: 0 }; this.who.set(key, c); }
    else {
      c.tokens = Math.min(this.o.burst, c.tokens + ((now - c.at) / 1000) * this.o.refillPerSec);
      c.at = now;
    }
    return c;
  }

  /**
   * Ask to do one piece of chain work. On `ok` the caller **must** call `done()`, including
   * when the work throws — a leaked slot is a caller permanently one request poorer.
   */
  take(key: string, now = Date.now()): Refusal {
    this.sweep(now);
    // the board's own ceiling first: it protects every reader, including this one
    if (this.running >= this.o.boardInFlight) return { ok: false, reason: "board", retryAfterSec: 3 };
    const c = this.entry(key, now);
    if (c.running >= this.o.inFlight) return { ok: false, reason: "busy", retryAfterSec: 2 };
    if (c.tokens < 1) {
      return { ok: false, reason: "rate", retryAfterSec: Math.max(1, Math.ceil((1 - c.tokens) / this.o.refillPerSec)) };
    }
    c.tokens -= 1;
    c.running += 1;
    this.running += 1;
    return { ok: true };
  }

  done(key: string): void {
    const c = this.who.get(key);
    if (c && c.running > 0) { c.running -= 1; this.running -= 1; }
  }

  /** For /stats and for the tests: how much of the board's ceiling is in use. */
  get inFlight(): number { return this.running; }

  /** For tests and for /stats: what this caller currently has. */
  peek(key: string): { tokens: number; running: number } | null {
    const c = this.who.get(key);
    return c ? { tokens: c.tokens, running: c.running } : null;
  }

  private lastSweep = 0;
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, c] of this.who) {
      // never forget someone mid-request; their slot would leak
      if (c.running === 0 && now - c.at > this.o.idleMs) this.who.delete(k);
    }
  }

  get size(): number { return this.who.size; }
}
