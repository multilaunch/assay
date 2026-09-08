import type { Address } from "viem";
import { factoryAbi } from "../abi/pons.js";
import { client } from "../chain/clients.js";
import { PONS } from "../chain/config.js";
import type { LaunchEvent } from "./detect.js";

export interface DeployerRecord { prior: number; graduated: number }

const LAUNCHED = factoryAbi.find((x) => x.type === "event" && x.name === "TokenLaunched")!;
const GRADUATED = factoryAbi.find((x) => x.type === "event" && x.name === "PoolGraduated")!;

/**
 * Who launched what, in memory. Built once in the background from the last `windowBlocks` of factory
 * logs (in chunks the public endpoint tolerates), then fed by the live stream for free. If the build is
 * refused, scoring runs without deployer history and the build retries every two minutes.
 */
export class DeployerIndex {
  readonly windowBlocks: bigint;
  private readonly byDeployer = new Map<string, Set<string>>();
  private readonly tokenDeployer = new Map<string, string>();
  private readonly graduatedTokens = new Set<string>();
  private readonly graduatedByDeployer = new Map<string, number>();
  private built = false;
  private building = false;
  private lastScanned = 0n;
  private retryTimer: NodeJS.Timeout | undefined;

  constructor(windowBlocks = 400_000n, private readonly chunk = 20_000n) { this.windowBlocks = windowBlocks; }

  get ready(): boolean { return this.built; }

  /** Live launch: cheap, no RPC. */
  note(ev: LaunchEvent): void {
    const d = ev.deployer.toLowerCase(), t = ev.token.toLowerCase();
    if (this.tokenDeployer.has(t)) return;
    this.tokenDeployer.set(t, d);
    let set = this.byDeployer.get(d);
    if (!set) { set = new Set(); this.byDeployer.set(d, set); }
    set.add(t);
  }

  private noteGraduation(token: string): void {
    const t = token.toLowerCase();
    if (this.graduatedTokens.has(t)) return;
    this.graduatedTokens.add(t);
    const d = this.tokenDeployer.get(t);
    if (d) this.graduatedByDeployer.set(d, (this.graduatedByDeployer.get(d) ?? 0) + 1);
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
    return { launches: this.tokenDeployer.size, graduations: this.graduatedTokens.size, deployers: this.byDeployer.size };
  }

  /** Kick off the background build; resolves immediately. */
  start(onReady?: (s: ReturnType<DeployerIndex["stats"]>) => void, onRetry?: (err: Error, inSec: number) => void): void {
    if (this.building || this.built) return;
    this.building = true;
    void (async () => {
      try {
        await this.build();
        this.built = true;
        this.building = false;
        onReady?.(this.stats());
      } catch (e) {
        this.building = false;
        onRetry?.(e as Error, 120);
        this.retryTimer = setTimeout(() => this.start(onReady, onRetry), 120_000);
      }
    })();
  }

  stop(): void { if (this.retryTimer) clearTimeout(this.retryTimer); }

  private async build(): Promise<void> {
    const head = await client.getBlockNumber();
    const from = head > this.windowBlocks ? head - this.windowBlocks : 0n;
    for (let a = from; a <= head; a += this.chunk + 1n) {
      const b = a + this.chunk > head ? head : a + this.chunk;
      const logs = await client.getLogs({ address: PONS.factory, events: [LAUNCHED, GRADUATED], fromBlock: a, toBlock: b });
      for (const l of logs) {
        const args = (l as { args: Record<string, unknown>; eventName?: string }).args;
        const name = (l as { eventName?: string }).eventName;
        if (name === "TokenLaunched" && args.token && args.deployer) {
          const t = String(args.token).toLowerCase(), d = String(args.deployer).toLowerCase();
          this.tokenDeployer.set(t, d);
          let set = this.byDeployer.get(d); if (!set) { set = new Set(); this.byDeployer.set(d, set); } set.add(t);
        } else if (name === "PoolGraduated" && args.token) {
          this.noteGraduation(String(args.token));
        }
      }
      this.lastScanned = b;
    }
  }

  /** Pull graduations that happened since the last scan; called on a timer by the engine. */
  async refreshGraduations(): Promise<void> {
    if (!this.built) return;
    const head = await client.getBlockNumber();
    if (head <= this.lastScanned) return;
    const logs = await client.getLogs({ address: PONS.factory, event: GRADUATED, fromBlock: this.lastScanned + 1n, toBlock: head });
    for (const l of logs) { const t = (l as { args: { token?: Address } }).args.token; if (t) this.noteGraduation(t); }
    this.lastScanned = head;
  }
}
