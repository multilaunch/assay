import type { Address } from "viem";
import { factoryAbi } from "../abi/pons.js";
import { client } from "../chain/clients.js";
import { PONS } from "../chain/config.js";
import type { LaunchEvent } from "./detect.js";

export interface DeployerRecord { prior: number; graduated: number }

/** How a build refusal or a graduation-scan refusal reaches the caller. `final` means nothing else will retry. */
export type IndexError = (err: Error, inSec: number, final?: boolean) => void;

const LAUNCHED = factoryAbi.find((x) => x.type === "event" && x.name === "TokenLaunched")!;
const GRADUATED = factoryAbi.find((x) => x.type === "event" && x.name === "PoolGraduated")!;

/** The build retries on a doubling delay; five attempts spread over ~half an hour, then it says so and stops. */
const BUILD_ATTEMPTS = 5;
const BUILD_BACKOFF_SEC = 60;
const BUILD_BACKOFF_CAP_SEC = 900;

/** The engine sweeps graduations on this interval, so it is also how long until a reported failure is retried. */
const SWEEP_SEC = 60;

/** A catch-up scan asks for at most this many chunks in one pass; beyond that the oldest blocks are given up on. */
const MAX_CATCHUP_CHUNKS = 10n;

/** How often the window is trimmed. Nothing here does RPC, so it can be cheap and frequent. */
const EVICT_MS = 60_000;

/**
 * The block ranges a catch-up scan should ask for, oldest first, and how many blocks it is giving up on.
 *
 * The graduation sweep used to ask for `lastScanned+1 .. head` in one call and only move the cursor on
 * success. One refusal at 60 s meant the next call asked for 1 200 blocks, then 1 800, then 2 400; after an
 * hour it asked for 36 000, which the official endpoint refuses for good. Graduation data then froze with
 * no event and no warning. Chunking keeps every request a size the endpoint accepts, and the cap means a
 * long outage costs the oldest graduations instead of every graduation from then on.
 */
export function catchupRanges(lastScanned: bigint, head: bigint, chunk: bigint, cap: bigint): { ranges: [bigint, bigint][]; skipped: bigint } {
  if (head <= lastScanned) return { ranges: [], skipped: 0n };
  let from = lastScanned + 1n;
  let skipped = 0n;
  if (head - from + 1n > cap) { skipped = head - from + 1n - cap; from = head - cap + 1n; }
  const ranges: [bigint, bigint][] = [];
  for (let a = from; a <= head; a += chunk + 1n) ranges.push([a, a + chunk > head ? head : a + chunk]);
  return { ranges, skipped };
}

/**
 * Who launched what, in memory. Built once in the background from the last `windowBlocks` of factory
 * logs (in chunks the public endpoint tolerates), then fed by the live stream for free. If the build is
 * refused, scoring runs without deployer history and the build retries on a doubling delay.
 *
 * Every entry carries the block it was seen at, because `lookup` promises "prior launches in the window"
 * and the live stream never stops. At the measured tempo of ~35 launches a minute, a board left up for a
 * week takes in ~350 000 launches: past 100 MB, and by then the number `lookup` returns counts launches
 * from days outside the window it claims to cover.
 */
export class DeployerIndex {
  readonly windowBlocks: bigint;
  private readonly byDeployer = new Map<string, Set<string>>();
  private readonly tokens = new Map<string, { deployer: string; block: bigint }>();
  private readonly graduatedAt = new Map<string, bigint>();
  private readonly graduatedByDeployer = new Map<string, number>();
  private built = false;
  private building = false;
  private lastScanned = 0n;
  /** the highest block any source has shown us; the window is trimmed against this, not against a fresh RPC read */
  private head = 0n;
  private attempt = 0;
  private onError: IndexError | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private evictTimer: NodeJS.Timeout | undefined;

  constructor(windowBlocks = 400_000n, private readonly chunk = 20_000n) { this.windowBlocks = windowBlocks; }

  get ready(): boolean { return this.built; }

  /** Live launch: cheap, no RPC. */
  note(ev: LaunchEvent): void {
    const d = ev.deployer.toLowerCase(), t = ev.token.toLowerCase();
    if (ev.blockNumber > this.head) this.head = ev.blockNumber;
    if (this.tokens.has(t)) return;
    this.tokens.set(t, { deployer: d, block: ev.blockNumber });
    let set = this.byDeployer.get(d);
    if (!set) { set = new Set(); this.byDeployer.set(d, set); }
    set.add(t);
  }

  private noteGraduation(token: string, block: bigint): void {
    const t = token.toLowerCase();
    if (this.graduatedAt.has(t)) return;
    this.graduatedAt.set(t, block);
    const e = this.tokens.get(t);
    if (e) this.graduatedByDeployer.set(e.deployer, (this.graduatedByDeployer.get(e.deployer) ?? 0) + 1);
  }

  /**
   * Forget everything that has fallen out of the window, so `lookup` keeps meaning what it says and the
   * process does not grow for as long as the board is up. Returns how many launches were dropped.
   */
  trim(): number {
    if (this.head <= this.windowBlocks) return 0;
    const floor = this.head - this.windowBlocks;
    let dropped = 0;
    for (const [t, e] of this.tokens) {
      if (e.block > floor) continue;
      this.tokens.delete(t);
      const set = this.byDeployer.get(e.deployer);
      if (set) { set.delete(t); if (set.size === 0) this.byDeployer.delete(e.deployer); }
      if (this.graduatedAt.delete(t)) {
        const left = (this.graduatedByDeployer.get(e.deployer) ?? 1) - 1;
        if (left > 0) this.graduatedByDeployer.set(e.deployer, left);
        else this.graduatedByDeployer.delete(e.deployer);
      }
      dropped++;
    }
    // a token that graduated in the window but launched before it has no launch entry to be evicted with
    for (const [t, at] of this.graduatedAt) if (at <= floor) this.graduatedAt.delete(t);
    return dropped;
  }

  /** Everything we know about a deployer, excluding the launch being scored. */
  lookup(deployer: Address, excludingToken?: Address): DeployerRecord | null {
    if (!this.built) return null;
    const d = deployer.toLowerCase();
    const set = this.byDeployer.get(d);
    const prior = (set?.size ?? 0) - (excludingToken && set?.has(excludingToken.toLowerCase()) ? 1 : 0);
    return { prior: Math.max(0, prior), graduated: this.graduatedByDeployer.get(d) ?? 0 };
  }

  stats(): { launches: number; graduations: number; deployers: number } {
    return { launches: this.tokens.size, graduations: this.graduatedAt.size, deployers: this.byDeployer.size };
  }

  /** Kick off the background build; resolves immediately. */
  start(onReady?: (s: ReturnType<DeployerIndex["stats"]>) => void, onError?: IndexError): void {
    if (this.building || this.built) return;
    this.building = true;
    this.onError = onError;
    void (async () => {
      try {
        await this.build();
        this.built = true;
        this.building = false;
        this.attempt = 0;
        this.evictTimer ??= setInterval(() => this.trim(), EVICT_MS).unref();
        onReady?.(this.stats());
      } catch (e) {
        this.building = false;
        this.attempt++;
        const first = (e as Error).message.split("\n")[0]?.slice(0, 90) ?? "";
        // Retrying every two minutes forever re-scanned 400 000 blocks from the top each time against the
        // endpoint that had just refused us, and `built` stayed false, so scoring ran blind with nothing
        // said after the first line. Back off, stop, and say that we stopped.
        if (this.attempt >= BUILD_ATTEMPTS) {
          onError?.(new Error(`deployer history unavailable after ${this.attempt} attempts (${first}); scoring runs without it until restart`), 0, true);
          return;
        }
        const inSec = Math.min(BUILD_BACKOFF_CAP_SEC, BUILD_BACKOFF_SEC * 2 ** (this.attempt - 1));
        onError?.(e as Error, inSec);
        this.retryTimer = setTimeout(() => this.start(onReady, onError), inSec * 1000);
      }
    })();
  }

  stop(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.evictTimer) clearInterval(this.evictTimer);
    this.evictTimer = undefined;
  }

  private async build(): Promise<void> {
    const head = await client.getBlockNumber();
    if (head > this.head) this.head = head;
    const floor = head > this.windowBlocks ? head - this.windowBlocks : 0n;
    // a retry resumes where the refused attempt stopped instead of walking the whole window again
    const from = this.lastScanned > floor ? this.lastScanned + 1n : floor;
    for (let a = from; a <= head; a += this.chunk + 1n) {
      const b = a + this.chunk > head ? head : a + this.chunk;
      const logs = await client.getLogs({ address: PONS.factory, events: [LAUNCHED, GRADUATED], fromBlock: a, toBlock: b });
      for (const l of logs) {
        const args = (l as { args: Record<string, unknown>; eventName?: string }).args;
        const name = (l as { eventName?: string }).eventName;
        const at = l.blockNumber ?? b;
        if (name === "TokenLaunched" && args.token && args.deployer) {
          const t = String(args.token).toLowerCase(), d = String(args.deployer).toLowerCase();
          this.tokens.set(t, { deployer: d, block: at });
          let set = this.byDeployer.get(d); if (!set) { set = new Set(); this.byDeployer.set(d, set); } set.add(t);
        } else if (name === "PoolGraduated" && args.token) {
          this.noteGraduation(String(args.token), at);
        }
      }
      this.lastScanned = b;
    }
  }

  /** Pull graduations that happened since the last scan; called on a timer by the engine. */
  async refreshGraduations(): Promise<void> {
    if (!this.built) return;
    const head = await client.getBlockNumber();
    if (head > this.head) this.head = head;
    const { ranges, skipped } = catchupRanges(this.lastScanned, head, this.chunk, this.chunk * MAX_CATCHUP_CHUNKS);
    if (skipped > 0n) this.onError?.(new Error(`graduation scan fell ${skipped} blocks behind; those graduations are gone`), SWEEP_SEC);
    for (const [a, b] of ranges) {
      try {
        const logs = await client.getLogs({ address: PONS.factory, event: GRADUATED, fromBlock: a, toBlock: b });
        for (const l of logs) { const t = (l as { args: { token?: Address } }).args.token; if (t) this.noteGraduation(t, l.blockNumber ?? b); }
        this.lastScanned = b;
      } catch (e) {
        // the caller swallows the rejection, so a refusal that is not reported here is not reported at all
        this.onError?.(e as Error, SWEEP_SEC);
        return;
      }
    }
  }
}
