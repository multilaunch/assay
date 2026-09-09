import { parseEventLogs, type Address } from "viem";
import { escrowAbi, factoryAbi } from "../abi/pons.js";
import { client } from "../chain/clients.js";
import { PONS, ZERO } from "../chain/config.js";

/**
 * Creator-fee forensics straight from the escrow's own events.
 *
 * Answers the one question a launch card cannot: *who is actually getting paid on this token, and
 * have they taken it out yet?* When the recipient is not the deployer, that is the builder / KOL
 * deal in one line — the wallet that launched is not the wallet that earns.
 */

export interface FeeLedger {
  recipient: Address;
  isDeployer: boolean;
  pairToken: Address;
  /** total credited to the recipient in the window, native units */
  credited: bigint;
  /** total claimed out */
  claimed: bigint;
  /** still sitting in the escrow, read live */
  pending: bigint;
  credits: { at: bigint; from: Address; amount: bigint }[];
  claims: { at: bigint; amount: bigint }[];
  windowBlocks: bigint;
  /** log ranges the window was split into */
  chunks: number;
  /** how many of them the endpoint refused. Above zero, every total here is a floor, not a total. */
  failedChunks: number;
  /** false when the escrow balance read was refused, so `pending` is 0 because we could not look */
  pendingKnown: boolean;
}

const CREDITED = escrowAbi.find((x) => x.type === "event" && x.name === "Credited")!;
const CLAIMED = escrowAbi.find((x) => x.type === "event" && x.name === "Claimed")!;

export async function feeLedger(token: Address, windowBlocks = 400_000n, chunk = 20_000n): Promise<FeeLedger> {
  const rec = await client.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] });
  if (!rec.exists) throw new Error("the factory has no record of that token");
  const recipient = rec.creatorFeeRecipient;

  const head = await client.getBlockNumber();
  const from = head > windowBlocks ? head - windowBlocks : 0n;
  const credits: FeeLedger["credits"] = [];
  const claims: FeeLedger["claims"] = [];
  let chunks = 0;
  let failedChunks = 0;

  // A refused range used to be swallowed into an empty array, and "credited 0 across 0 credits" is the
  // headline number of this whole command. Counting the refusals lets the printer say the
  // difference between "nobody has been paid" and "the logs endpoint would not tell us".
  const refused = () => { failedChunks++; return []; };

  for (let a = from; a <= head; a += chunk + 1n) {
    const b = a + chunk > head ? head : a + chunk;
    chunks++;
    // one call per event: the indexed `recipient` filter only applies to a single-event query
    const [cr, cl] = await Promise.all([
      client.getLogs({ address: PONS.escrow, event: CREDITED, args: { recipient }, fromBlock: a, toBlock: b }).catch(refused),
      client.getLogs({ address: PONS.escrow, event: CLAIMED, args: { recipient }, fromBlock: a, toBlock: b }).catch(refused),
    ]);
    for (const l of parseEventLogs({ abi: escrowAbi, logs: [...cr, ...cl] })) {
      if (l.eventName === "Credited") credits.push({ at: l.blockNumber ?? 0n, from: l.args.depositor, amount: l.args.amount });
      else if (l.eventName === "Claimed") claims.push({ at: l.blockNumber ?? 0n, amount: l.args.amount });
    }
  }

  const native = rec.pairToken.toLowerCase() === ZERO;
  let pendingKnown = true;
  const unread = () => { pendingKnown = false; return 0n; };
  const pending = native
    ? await client.readContract({ address: PONS.escrow, abi: escrowAbi, functionName: "balanceOf", args: [recipient] }).catch(unread)
    : await client.readContract({ address: PONS.escrow, abi: escrowAbi, functionName: "balanceOfToken", args: [recipient, rec.pairToken] }).catch(unread);

  return {
    recipient,
    isDeployer: recipient.toLowerCase() === rec.deployer.toLowerCase(),
    pairToken: rec.pairToken,
    credited: credits.reduce((s, x) => s + x.amount, 0n),
    claimed: claims.reduce((s, x) => s + x.amount, 0n),
    pending, pendingKnown,
    credits, claims, windowBlocks, chunks, failedChunks,
  };
}

export interface DeployerLaunch { token: Address; curve: Address; block: bigint; phase: string }

/**
 * The rows, carrying how much of the window was actually readable. It is still an array so the callers
 * that only want the rows keep working; an empty one with `failedChunks > 0` means "we could not see",
 * which is the opposite of the "no launches by that address" it used to print.
 */
export type DeployerLaunches = DeployerLaunch[] & { chunks: number; failedChunks: number };

export async function deployerLaunches(deployer: Address, windowBlocks = 400_000n, chunk = 20_000n): Promise<DeployerLaunches> {
  const LAUNCHED = factoryAbi.find((x) => x.type === "event" && x.name === "TokenLaunched")!;
  const head = await client.getBlockNumber();
  const from = head > windowBlocks ? head - windowBlocks : 0n;
  const found: { token: Address; curve: Address; block: bigint }[] = [];
  let chunks = 0;
  let failedChunks = 0;
  for (let a = from; a <= head; a += chunk + 1n) {
    const b = a + chunk > head ? head : a + chunk;
    chunks++;
    const logs = await client.getLogs({ address: PONS.factory, event: LAUNCHED, args: { deployer }, fromBlock: a, toBlock: b }).catch(() => { failedChunks++; return []; });
    for (const l of logs) {
      const args = (l as { args: { token?: Address; curve?: Address } }).args;
      if (args.token && args.curve) found.push({ token: args.token, curve: args.curve, block: l.blockNumber ?? 0n });
    }
  }
  const counts = { chunks, failedChunks };
  if (found.length === 0) return Object.assign([] as DeployerLaunch[], counts);
  const phases = await client.multicall({
    contracts: found.map((f) => ({ address: PONS.factory, abi: factoryAbi, functionName: "getLaunchedToken" as const, args: [f.token] as const })),
    allowFailure: true,
  });
  const names = ["NotGraduated", "Swept", "PoolCreated", "Rescued"] as const;
  const rows = found.map((f, i) => {
    const r = phases[i];
    const phase = r?.status === "success" ? names[(r.result as { phase: number }).phase] ?? "?" : "?";
    return { ...f, phase };
  });
  return Object.assign(rows, counts);
}
