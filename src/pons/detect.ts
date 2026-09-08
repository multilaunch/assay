import type { Address, Hex, Log } from "viem";
import { factoryAbi } from "../abi/pons.js";
import { client, ws } from "../chain/clients.js";
import { PONS } from "../chain/config.js";
import { envNum } from "../util/env.js";

export interface LaunchEvent {
  token: Address;
  curve: Address;
  deployer: Address;
  pairToken: Address;
  launchConfigId: bigint;
  graduationThreshold: bigint;
  blockNumber: bigint;
  txHash: Hex;
  logIndex: number;
  /** wall clock when this process first saw it */
  seenAtMs: number;
}

const EVENT = factoryAbi.find((x) => x.type === "event" && x.name === "TokenLaunched")!;
type LaunchedLog = Log<bigint, number, false, typeof EVENT, true>;

export function toLaunch(l: LaunchedLog): LaunchEvent | null {
  const a = l.args;
  if (!l.transactionHash || l.blockNumber === null || l.logIndex === null) return null;
  if (!a.token || !a.curve || !a.deployer || !a.pairToken) return null;
  return {
    token: a.token, curve: a.curve, deployer: a.deployer, pairToken: a.pairToken,
    launchConfigId: a.launchConfigId ?? 0n, graduationThreshold: a.graduationThreshold ?? 0n,
    blockNumber: l.blockNumber, txHash: l.transactionHash, logIndex: l.logIndex, seenAtMs: Date.now(),
  };
}

export interface FeedHealth {
  mode: "websocket" | "polling" | "both";
  lastLaunchAt: number;
  lastWsAt: number;
  recoveries: number;
}

/** Silence this long from a chain that launches a token every few seconds is the pipe, not the chain. */
const QUIET_MS = 45_000;

/**
 * Streams TokenLaunched. Websocket first; a watchdog re-subscribes after QUIET_MS and runs
 * block-range polling alongside until the socket delivers again. Polling alone when ws is off.
 * De-duplicated by tx hash + log index so both sources can overlap safely. Returns a stop function.
 */
export function watchLaunches(onLaunch: (ev: LaunchEvent) => void, opts: { pollMs?: number; onHealth?: (h: FeedHealth) => void } = {}): () => void {
  const seen = new Set<string>();
  const health: FeedHealth = { mode: ws ? "websocket" : "polling", lastLaunchAt: 0, lastWsAt: Date.now(), recoveries: 0 };
  let stopped = false;

  const deliver = (l: LaunchedLog, from: "websocket" | "polling") => {
    const k = `${l.transactionHash}:${l.logIndex}`;
    if (seen.has(k)) return;
    seen.add(k);
    if (seen.size > 20_000) { let n = 0; for (const key of seen) { seen.delete(key); if (++n >= 10_000) break; } }
    const ev = toLaunch(l);
    if (!ev) return;
    health.lastLaunchAt = Date.now();
    if (from === "websocket") health.lastWsAt = Date.now();
    onLaunch(ev);
  };

  // ---- polling ---------------------------------------------------------------------------------
  const pollMs = opts.pollMs ?? envNum("POLL_MS", 300);
  let polling = false;
  let cursor = 0n;
  let busy = false;
  let backoff = 0;
  let timer: NodeJS.Timeout | undefined;
  const tick = async (): Promise<void> => {
    if (stopped || !polling || busy) return;
    busy = true;
    try {
      const head = await client.getBlockNumber();
      if (cursor === 0n) cursor = head - 1n;
      if (head > cursor) {
        const from = cursor + 1n;
        const to = head - from > 2_000n ? from + 2_000n : head;
        const logs = await client.getLogs({ address: PONS.factory, event: EVENT, fromBlock: from, toBlock: to });
        for (const l of logs) deliver(l as LaunchedLog, "polling");
        cursor = to;
      }
      if (backoff > 0) backoff--;
    } catch {
      backoff = Math.min(6, backoff + 2);
    } finally {
      busy = false;
      if (!stopped && polling) timer = setTimeout(() => void tick(), pollMs * (1 + backoff));
    }
  };
  const startPolling = () => { if (polling) return; polling = true; void tick(); };
  const stopPolling = () => { polling = false; if (timer) clearTimeout(timer); };

  // ---- websocket -------------------------------------------------------------------------------
  let unwatch: (() => void) | null = null;
  const subscribe = () => {
    if (!ws || stopped) return;
    try { unwatch?.(); } catch { /* already gone */ }
    unwatch = ws.watchContractEvent({
      address: PONS.factory, abi: factoryAbi, eventName: "TokenLaunched",
      onLogs: (logs) => { for (const l of logs) deliver(l as unknown as LaunchedLog, "websocket"); },
      onError: () => { /* the watchdog handles it */ },
    });
    health.lastWsAt = Date.now();
  };

  let dog: NodeJS.Timeout | undefined;
  if (ws) {
    subscribe();
    dog = setInterval(() => {
      if (stopped) return;
      const quiet = Date.now() - Math.max(health.lastWsAt, health.lastLaunchAt);
      if (quiet > QUIET_MS) {
        health.recoveries++;
        health.mode = "both";
        subscribe();
        startPolling();
        opts.onHealth?.({ ...health });
      } else if (polling && Date.now() - health.lastWsAt < 10_000) {
        // the socket is alive again; polling can rest
        stopPolling();
        health.mode = "websocket";
        opts.onHealth?.({ ...health });
      }
    }, 10_000);
  } else {
    startPolling();
  }

  return () => {
    stopped = true;
    if (dog) clearInterval(dog);
    stopPolling();
    try { unwatch?.(); } catch { /* ignore */ }
  };
}

/**
 * The real TokenLaunched log for one token, so a command that starts from an address still gets the
 * launch transaction. Without it `scan` and `inspect` would synthesise an empty tx hash, the launch
 * read would fail every time, and the score would take the "unreadable" penalty it does not deserve.
 * `token` is indexed, so the filter is cheap; we still walk back in chunks the public endpoint accepts.
 */
export async function findLaunchEvent(token: Address, windowBlocks = 2_000_000n, chunk = 100_000n): Promise<LaunchEvent | null> {
  const head = await client.getBlockNumber();
  const floor = head > windowBlocks ? head - windowBlocks : 0n;
  for (let to = head; to > floor; to -= chunk + 1n) {
    const from = to - chunk > floor ? to - chunk : floor;
    const logs = await client.getLogs({ address: PONS.factory, event: EVENT, args: { token }, fromBlock: from, toBlock: to }).catch(() => []);
    const hit = logs[0];
    if (hit) return toLaunch(hit as LaunchedLog);
  }
  return null;
}

/** The most recent launches, newest last. Used by `scan` when no address is given and by the deployer index. */
export async function recentLaunches(blocks = 3_000n): Promise<LaunchEvent[]> {
  const head = await client.getBlockNumber();
  const logs = await client.getLogs({ address: PONS.factory, event: EVENT, fromBlock: head - blocks, toBlock: head });
  return logs.map((l) => toLaunch(l as LaunchedLog)).filter((x): x is LaunchEvent => x !== null);
}
