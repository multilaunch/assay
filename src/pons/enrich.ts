import { decodeFunctionData, parseEventLogs, type Address, type Hex } from "viem";
import { curveAbi, erc20Abi, factoryAbi, PHASE, routerAbi, SELECTOR, tokenAbi, type Phase } from "../abi/pons.js";
import { client } from "../chain/clients.js";
import { DEAD, PONS, ZERO } from "../chain/config.js";
import type { CurveState } from "./curve.js";
import type { LaunchEvent } from "./detect.js";

export interface Socials { twitter: string; telegram: string; discord: string; website: string; farcaster: string }
export interface TokenMeta { name: string; symbol: string; logo: string; description: string; socials: Socials }

export interface LaunchRecord {
  deployer: Address;
  creatorFeeRecipient: Address;
  pairToken: Address;
  graduationThreshold: bigint;
  poolFee: number;
  tickSpacing: number;
  creatorTaxBps: bigint;
  buybackEnabled: boolean;
  phase: Phase;
  exists: boolean;
}

export interface PairInfo {
  address: Address;
  symbol: string;
  decimals: number;
  /** true for native ETH */
  native: boolean;
}

export interface LaunchTx {
  from: Address;
  /** quote the launcher spent on its own opening buy; 0 when launched without one */
  devBuy: bigint;
  /** tokens the launcher received in the launch transaction */
  devTokens: bigint;
  /** wallets declared exempt from the opening tax in the launch calldata: the declared bundle */
  exemptions: Address[];
  /** who the opening buy was minted to */
  recipient: Address;
  timestamp: number;
  /** which entrypoint created it */
  via: "router" | "factory" | "factory+exempt" | "unknown";
}

export interface LaunchIntel {
  ev: LaunchEvent;
  meta: TokenMeta | null;
  record: LaunchRecord | null;
  curve: CurveState | null;
  pair: PairInfo;
  tx: LaunchTx | null;
  errors: string[];
}

const NATIVE: PairInfo = { address: ZERO, symbol: "ETH", decimals: 18, native: true };
const pairCache = new Map<string, PairInfo>();

export async function pairInfo(addr: Address): Promise<PairInfo> {
  if (addr.toLowerCase() === ZERO) return NATIVE;
  const hit = pairCache.get(addr.toLowerCase());
  if (hit) return hit;
  const [sym, dec] = await client.multicall({
    contracts: [
      { address: addr, abi: erc20Abi, functionName: "symbol" },
      { address: addr, abi: erc20Abi, functionName: "decimals" },
    ],
    allowFailure: true,
  });
  const info: PairInfo = { address: addr, symbol: sym.status === "success" ? sym.result : "?", decimals: dec.status === "success" ? Number(dec.result) : 18, native: false };
  pairCache.set(addr.toLowerCase(), info);
  return info;
}

export interface EnrichOptions {
  /** extra passes when something critical came back empty */
  retries?: number;
  retryDelayMs?: number;
}

/**
 * Read one launch, retrying the parts that were not there yet.
 *
 * The websocket hands us a launch the moment its log appears, which is routinely *before* the RPC
 * endpoint we then query has the block: `getTransactionReceipt` answers "not found" and contract
 * calls return an empty `0x`. Measured on 2026-09-08 over 45 s of live launches: 57 % of launch
 * transactions and 29 % of curves failed on the first pass, and 11 of 13 healed on a single retry
 * 800 ms later. Left alone that is not noise, it is a hole in the data the rules run on.
 *
 * Retrying costs nothing in the hot path: the engine has to sit out the ~3 s opening tax anyway.
 */
export async function enrichLaunch(ev: LaunchEvent, recipient: Address = DEAD, opts: EnrichOptions = {}): Promise<LaunchIntel> {
  const retries = opts.retries ?? 0;
  const delay = opts.retryDelayMs ?? 350;
  let best = await enrichOnce(ev, recipient);
  for (let i = 0; i < retries && !isComplete(best); i++) {
    await new Promise((r) => setTimeout(r, delay));
    best = mergeIntel(best, await enrichOnce(ev, recipient));
  }
  return best;
}

/** Everything the rules need is present. */
export const isComplete = (i: LaunchIntel): boolean => !!i.tx && !!i.curve && !!i.meta;

/**
 * Fold a later read into an earlier one. Anything immutable keeps the first value that arrived;
 * the curve is the exception, because it moves, so the newest successful read wins.
 */
export function mergeIntel(first: LaunchIntel, next: LaunchIntel): LaunchIntel {
  return {
    ev: first.ev,
    pair: first.pair.symbol === "?" ? next.pair : first.pair,
    meta: first.meta ?? next.meta,
    record: first.record ?? next.record,
    curve: next.curve ?? first.curve,
    tx: first.tx ?? next.tx,
    errors: next.errors,
  };
}

/**
 * Everything about one launch in one `aggregate3`: token metadata, the factory record, the curve state
 * (including the opening tax as *this* recipient would pay it). Failures are per-call; the card renders
 * whatever came back and lists what did not.
 */
async function enrichOnce(ev: LaunchEvent, recipient: Address = DEAD): Promise<LaunchIntel> {
  const errors: string[] = [];
  const t = { address: ev.token, abi: tokenAbi } as const;
  const c = { address: ev.curve, abi: curveAbi } as const;
  const readAtMs = Date.now();

  const [pair, res] = await Promise.all([
    pairInfo(ev.pairToken).catch((e: Error) => { errors.push(`pair: ${e.message.split("\n")[0]}`); return NATIVE; }),
    client.multicall({
      contracts: [
        { ...t, functionName: "name" },
        { ...t, functionName: "symbol" },
        { ...t, functionName: "getTokenInfo" },
        { address: PONS.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [ev.token] },
        { ...c, functionName: "getReserves" },
        { ...c, functionName: "realQuoteReserve" },
        { ...c, functionName: "phantomQuote" },
        { ...c, functionName: "sellableTokens" },
        { ...c, functionName: "reservedTokens" },
        { ...c, functionName: "graduationThreshold" },
        { ...c, functionName: "feeBps" },
        { ...c, functionName: "creatorTaxBps" },
        { ...c, functionName: "currentSnipeTaxBps", args: [recipient] },
        { ...c, functionName: "graduated" },
        { ...c, functionName: "readyToGraduate" },
        { ...c, functionName: "launchedAt" },
      ],
      allowFailure: true,
    }),
  ]);

  const ok = <T,>(i: number): T | undefined => {
    const r = res[i];
    if (!r) return undefined;
    if (r.status === "success") return r.result as T;
    errors.push(`call ${i}: ${String(r.error?.message ?? r.error).split("\n")[0]?.slice(0, 80) ?? ""}`);
    return undefined;
  };

  const name = ok<string>(0);
  const symbol = ok<string>(1);
  const info = ok<readonly [Address, string, string, Socials]>(2);
  const meta: TokenMeta | null = name !== undefined && symbol !== undefined
    ? {
        name, symbol,
        logo: info?.[1] ?? "", description: info?.[2] ?? "",
        socials: info?.[3] ?? { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
      }
    : null;

  const rec = ok<{ deployer: Address; creatorFeeRecipient: Address; pairToken: Address; graduationThreshold: bigint; poolFee: number; tickSpacing: number; creatorTaxBps: number; buybackEnabled: boolean; phase: number; exists: boolean }>(3);
  const record: LaunchRecord | null = rec
    ? {
        deployer: rec.deployer, creatorFeeRecipient: rec.creatorFeeRecipient, pairToken: rec.pairToken,
        graduationThreshold: rec.graduationThreshold, poolFee: Number(rec.poolFee), tickSpacing: Number(rec.tickSpacing),
        creatorTaxBps: BigInt(rec.creatorTaxBps), buybackEnabled: rec.buybackEnabled, phase: PHASE[rec.phase] ?? "NotGraduated", exists: rec.exists,
      }
    : null;

  const reserves = ok<readonly [bigint, bigint]>(4);
  const curve: CurveState | null = reserves
    ? {
        quoteReserve: reserves[0], tokenReserve: reserves[1],
        realQuoteReserve: ok<bigint>(5) ?? 0n, phantomQuote: ok<bigint>(6) ?? 0n,
        sellableTokens: ok<bigint>(7) ?? 0n, reservedTokens: ok<bigint>(8) ?? 0n,
        graduationThreshold: ok<bigint>(9) ?? ev.graduationThreshold,
        feeBps: ok<bigint>(10) ?? 100n, creatorTaxBps: ok<bigint>(11) ?? 0n,
        openingTaxBps: ok<bigint>(12) ?? 0n,
        graduated: ok<boolean>(13) ?? false, readyToGraduate: ok<boolean>(14) ?? false,
        launchedAt: Number(ok<bigint>(15) ?? 0n), readAtMs,
      }
    : null;

  let tx: LaunchTx | null = null;
  try { tx = await readLaunchTx(ev); } catch (e) { errors.push(`launch tx: ${(e as Error).message.split("\n")[0]?.slice(0, 80) ?? ""}`); }

  return { ev, meta, record, curve, pair, tx, errors };
}

/** What the launcher did in the launch transaction: opening buy, recipient, declared exemptions. */
export async function readLaunchTx(ev: LaunchEvent): Promise<LaunchTx> {
  const [tx, receipt, block] = await Promise.all([
    client.getTransaction({ hash: ev.txHash }),
    client.getTransactionReceipt({ hash: ev.txHash }),
    client.getBlock({ blockNumber: ev.blockNumber }),
  ]);
  let devBuy = 0n;
  let exemptions: Address[] = [];
  let recipient: Address = tx.from;
  let via: LaunchTx["via"] = "unknown";
  const input = tx.input as Hex;
  try {
    if (input.startsWith(SELECTOR.launchAndBuy)) {
      const d = decodeFunctionData({ abi: routerAbi, data: input });
      if (d.functionName === "launchAndBuy") {
        const [, , , quoteIn, , rcpt, ex] = d.args;
        devBuy = quoteIn; recipient = rcpt; exemptions = [...ex]; via = "router";
      }
    } else if (input.startsWith(SELECTOR.launchTokenExempt)) {
      const d = decodeFunctionData({ abi: factoryAbi, data: input });
      if (d.functionName === "launchToken" && d.args.length === 4) { exemptions = [...(d.args[3] as readonly Address[])]; via = "factory+exempt"; }
    } else if (input.startsWith(SELECTOR.launchTokenPlain)) {
      via = "factory";
    }
  } catch { /* unknown encoding: fall through to receipt-derived numbers */ }

  // The curve's own CurveBuy logs inside the launch tx are the ground truth for the opening buy,
  // whichever entrypoint created the token.
  let devTokens = 0n;
  let spent = 0n;
  const buys = parseEventLogs({ abi: curveAbi, logs: receipt.logs, eventName: "CurveBuy" });
  for (const b of buys) if (b.address.toLowerCase() === ev.curve.toLowerCase()) { devTokens += b.args.tokensOut; spent += b.args.quoteIn; }
  if (devBuy === 0n) devBuy = spent;
  return { from: tx.from, devBuy, devTokens, exemptions, recipient, timestamp: Number(block.timestamp), via };
}

export interface CurveActivity {
  buys: number;
  sells: number;
  uniqueBuyers: number;
  quoteIn: bigint;
  quoteOut: bigint;
  /** buys that landed inside the opening-tax window (from launchedAt, snipeTaxSeconds) */
  earlyBuys: number;
}

/** Trades on one curve since `fromBlock`. `windowEnd` is launchedAt + snipeTaxSeconds (unix s). */
export async function curveActivity(curve: Address, fromBlock: bigint, windowEnd: number): Promise<CurveActivity> {
  const head = await client.getBlockNumber();
  const logs = await client.getLogs({ address: curve, events: [curveAbi.find((x) => x.type === "event" && x.name === "CurveBuy")!, curveAbi.find((x) => x.type === "event" && x.name === "CurveSell")!], fromBlock, toBlock: head });
  const out: CurveActivity = { buys: 0, sells: 0, uniqueBuyers: 0, quoteIn: 0n, quoteOut: 0n, earlyBuys: 0 };
  const buyers = new Set<string>();
  const parsed = parseEventLogs({ abi: curveAbi, logs });
  // block timestamps for early-window detection, fetched once per distinct block
  const blocks = new Map<bigint, number>();
  for (const l of parsed) if (l.eventName === "CurveBuy" && l.blockNumber !== null) blocks.set(l.blockNumber, 0);
  if (windowEnd > 0 && blocks.size > 0 && blocks.size <= 40) {
    await Promise.all([...blocks.keys()].map(async (bn) => { const b = await client.getBlock({ blockNumber: bn }).catch(() => null); if (b) blocks.set(bn, Number(b.timestamp)); }));
  }
  for (const l of parsed) {
    if (l.eventName === "CurveBuy") {
      out.buys++; buyers.add(l.args.recipient.toLowerCase()); out.quoteIn += l.args.quoteIn;
      const ts = l.blockNumber !== null ? blocks.get(l.blockNumber) ?? 0 : 0;
      if (ts && ts <= windowEnd) out.earlyBuys++;
    } else if (l.eventName === "CurveSell") { out.sells++; out.quoteOut += l.args.quoteOut; }
  }
  out.uniqueBuyers = buyers.size;
  return out;
}

export const devSharePct = (tx: LaunchTx | null): number => (tx ? Number((tx.devTokens * 1_000_000n) / (1_000_000_000n * 10n ** 18n)) / 10_000 : 0);

export function socialsOf(meta: TokenMeta | null): { x: boolean; web: boolean; tg: boolean; any: boolean } {
  const s = meta?.socials;
  const x = !!s?.twitter?.trim(), web = !!s?.website?.trim(), tg = !!s?.telegram?.trim();
  return { x, web, tg, any: x || web || tg || !!s?.discord?.trim() || !!s?.farcaster?.trim() };
}

/** Resolve a pons logo reference to something a browser can load. */
export function logoUrl(logo: string): string {
  if (!logo) return "";
  if (logo.startsWith("ipfs://")) return `https://www.ponsfamily.com/api/ipfs/content/${logo.slice(7)}?variant=card`;
  return logo;
}
