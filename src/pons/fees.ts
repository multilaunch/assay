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

  for (let a = from; a <= head; a += chunk + 1n) {
    const b = a + chunk > head ? head : a + chunk;
    // one call per event: the indexed `recipient` filter only applies to a single-event query
    const [cr, cl] = await Promise.all([
      client.getLogs({ address: PONS.escrow, event: CREDITED, args: { recipient }, fromBlock: a, toBlock: b }).catch(() => []),
      client.getLogs({ address: PONS.escrow, event: CLAIMED, args: { recipient }, fromBlock: a, toBlock: b }).catch(() => []),
    ]);
    for (const l of parseEventLogs({ abi: escrowAbi, logs: [...cr, ...cl] })) {
      if (l.eventName === "Credited") credits.push({ at: l.blockNumber ?? 0n, from: l.args.depositor, amount: l.args.amount });
      else if (l.eventName === "Claimed") claims.push({ at: l.blockNumber ?? 0n, amount: l.args.amount });
    }
  }

  const native = rec.pairToken.toLowerCase() === ZERO;
  const pending = native
    ? await client.readContract({ address: PONS.escrow, abi: escrowAbi, functionName: "balanceOf", args: [recipient] }).catch(() => 0n)
    : await client.readContract({ address: PONS.escrow, abi: escrowAbi, functionName: "balanceOfToken", args: [recipient, rec.pairToken] }).catch(() => 0n);

  return {
    recipient,
    isDeployer: recipient.toLowerCase() === rec.deployer.toLowerCase(),
    pairToken: rec.pairToken,
    credited: credits.reduce((s, x) => s + x.amount, 0n),
    claimed: claims.reduce((s, x) => s + x.amount, 0n),
    pending,
    credits, claims, windowBlocks,
  };
}

/** Every launch by one deployer in the window, with the phase each one reached. */
export async function deployerLaunches(deployer: Address, windowBlocks = 400_000n, chunk = 20_000n): Promise<{ token: Address; curve: Address; block: bigint; phase: string }[]> {
  const LAUNCHED = factoryAbi.find((x) => x.type === "event" && x.name === "TokenLaunched")!;
  const head = await client.getBlockNumber();
  const from = head > windowBlocks ? head - windowBlocks : 0n;
  const found: { token: Address; curve: Address; block: bigint }[] = [];
  for (let a = from; a <= head; a += chunk + 1n) {
    const b = a + chunk > head ? head : a + chunk;
    const logs = await client.getLogs({ address: PONS.factory, event: LAUNCHED, args: { deployer }, fromBlock: a, toBlock: b }).catch(() => []);
    for (const l of logs) {
      const args = (l as { args: { token?: Address; curve?: Address } }).args;
      if (args.token && args.curve) found.push({ token: args.token, curve: args.curve, block: l.blockNumber ?? 0n });
    }
  }
  if (found.length === 0) return [];
  const phases = await client.multicall({
    contracts: found.map((f) => ({ address: PONS.factory, abi: factoryAbi, functionName: "getLaunchedToken" as const, args: [f.token] as const })),
    allowFailure: true,
  });
  const names = ["NotGraduated", "Swept", "PoolCreated", "Rescued"] as const;
  return found.map((f, i) => {
    const r = phases[i];
    const phase = r?.status === "success" ? names[(r.result as { phase: number }).phase] ?? "?" : "?";
    return { ...f, phase };
  });
}
