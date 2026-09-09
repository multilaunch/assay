import { client } from "./clients.js";

export interface BlockClock {
  /** seconds per block, measured */
  secs: number;
  /** unix ms this block was sealed, estimated from the anchor */
  at: (block: bigint) => number;
  /** the block sealed nearest to this unix ms */
  block: (ms: number) => bigint;
}

/**
 * Wall-clock time from block numbers, measured rather than assumed.
 *
 * Both samples sit well behind the head: the endpoint that answered getBlockNumber is not always
 * the one that serves the next call, and asking a node one block behind for the tip is an error
 * rather than a slow answer.
 */
export async function blockClock(head: bigint, span = 10_000n): Promise<BlockClock> {
  const near = head > 200n ? head - 200n : 0n;
  const far = near > span ? near - span : 0n;
  let secs = 0.1;
  let anchor = { block: near, ms: Date.now() };
  if (near !== far) {
    try {
      const [a, b] = await Promise.all([client.getBlock({ blockNumber: far }), client.getBlock({ blockNumber: near })]);
      const dt = Number(b.timestamp - a.timestamp);
      const dn = Number(near - far);
      if (dn > 0 && dt > 0) secs = dt / dn;
      anchor = { block: near, ms: Number(b.timestamp) * 1000 };
    } catch { /* the estimate is still better than pretending a launch happened just now */ }
  }
  return {
    secs,
    at: (block) => anchor.ms - Number(anchor.block - block) * secs * 1000,
    block: (ms) => anchor.block + BigInt(Math.round((ms - anchor.ms) / 1000 / secs)),
  };
}
