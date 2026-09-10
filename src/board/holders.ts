import { parseAbiItem, type Address } from "viem";
import { factoryAbi } from "../abi/pons.js";
import { client } from "../chain/clients.js";
import { PONS, ZERO } from "../chain/config.js";
import { searchLaunchEvent } from "../pons/detect.js";
import { launchOf } from "../index/read.js";

/**
 * Who holds the token now, folded out of its own Transfer log.
 *
 * This is not the opening buy. `devPct` is a photograph of the launch transaction and nothing
 * after it, and a creator who bought 2% at the start and 22% over the next hour looks identical to
 * one who walked away — measured on a live launch at 62% curve fill, the creator held 24.45% while
 * the opening buy said something else entirely. That gap is the reason this exists.
 *
 * There is no indexer on this chain, so the balances are summed from the events. A launch is young
 * and thinly traded, which is what makes that affordable: the same live token had 79 transfers.
 */

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/** One getLogs at a time. */
const CHUNK = 20_000n;
/** Beyond this the log is too long to fold on demand, and the answer says so rather than lying. */
const MAX_LOGS = 20_000;
const TTL_MS = 45_000;

export interface Holder {
  address: Address;
  balance: string;
  /** share of the supply that exists, in per cent */
  pct: number;
  tag: "curve" | "creator" | null;
}

export interface Holders {
  token: Address;
  supply: string;
  transfers: number;
  /** wallets with a positive balance, including the curve */
  count: number;
  holders: Holder[];
  /** what the curve still has, i.e. what has not been bought yet */
  curvePct: number;
  creatorPct: number;
  /** everything not sitting in the curve: the float, and how concentrated it is */
  floatPct: number;
  floatWallets: number;
  /** the largest single holder as a share of the float, which is the number that bites */
  topOfFloatPct: number;
  /** log ranges the endpoint refused; above zero these numbers are a floor */
  failedChunks: number;
  /** true when the transfer log was longer than we will fold */
  truncated: boolean;
}

type Transfer = { from: string; to: string; value: bigint };

/**
 * Balances from transfers. Pure, because this is the part that is easy to get subtly wrong and
 * impossible to notice: a mint counted as a send would leave the curve owing a billion tokens.
 */
export function foldTransfers(events: readonly Transfer[]): Map<string, bigint> {
  const bal = new Map<string, bigint>();
  const move = (who: string, by: bigint) => {
    const k = who.toLowerCase();
    if (k === ZERO) return; // minting and burning are not a wallet
    bal.set(k, (bal.get(k) ?? 0n) + by);
  };
  for (const e of events) {
    move(e.from, -e.value);
    move(e.to, e.value);
  }
  for (const [k, v] of bal) if (v <= 0n) bal.delete(k);
  return bal;
}

const cache = new Map<string, { at: number; data: Holders }>();

export async function holdersFor(token: Address, top = 12): Promise<Holders | null> {
  const key = token.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const rec = await client.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] }).catch(() => null);
  if (!rec || !rec.exists) return null;

  // Start at the launch: everything before it is somebody else's token. The block comes from the
  // index when it holds this launch, and is searched for down the chain only when it does not.
  const known = launchOf(token);
  const head = await client.getBlockNumber();
  let from: bigint;
  if (known) from = BigInt(known.block);
  else {
    const found = await searchLaunchEvent(token).catch(() => null);
    from = found?.ev?.blockNumber ?? (head > 400_000n ? head - 400_000n : 0n);
  }

  const events: Transfer[] = [];
  let failedChunks = 0;
  let truncated = false;
  for (let lo = from; lo <= head; lo += CHUNK) {
    const hi = lo + CHUNK - 1n > head ? head : lo + CHUNK - 1n;
    try {
      const logs = await client.getLogs({ address: token, event: TRANSFER, fromBlock: lo, toBlock: hi });
      for (const l of logs) events.push(l.args as Transfer);
    } catch { failedChunks++; }
    if (events.length > MAX_LOGS) { truncated = true; break; }
  }

  const bal = foldTransfers(events);
  const supply = [...bal.values()].reduce((s, v) => s + v, 0n);
  const pct = (v: bigint) => (supply > 0n ? Number((v * 1_000_000n) / supply) / 10_000 : 0);

  const curve = rec.curve.toLowerCase();
  const creator = rec.deployer.toLowerCase();
  const sorted = [...bal].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));

  const float = sorted.filter(([a]) => a !== curve);
  const floatTotal = float.reduce((s, [, v]) => s + v, 0n);

  const data: Holders = {
    token,
    supply: supply.toString(),
    transfers: events.length,
    count: sorted.length,
    holders: sorted.slice(0, top).map(([address, balance]) => ({
      address: address as Address,
      balance: balance.toString(),
      pct: pct(balance),
      tag: address === curve ? "curve" : address === creator ? "creator" : null,
    })),
    curvePct: pct(bal.get(curve) ?? 0n),
    creatorPct: pct(bal.get(creator) ?? 0n),
    floatPct: pct(floatTotal),
    floatWallets: float.length,
    topOfFloatPct: floatTotal > 0n && float[0] ? Number((float[0][1] * 1_000_000n) / floatTotal) / 10_000 : 0,
    failedChunks,
    truncated,
  };

  cache.set(key, { at: Date.now(), data });
  if (cache.size > 200) { const oldest = [...cache].sort((a, b) => a[1].at - b[1].at)[0]; if (oldest) cache.delete(oldest[0]); }
  return data;
}
