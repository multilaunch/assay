import type { Command } from "commander";
import type { Address } from "viem";
import { factoryAbi, tokenAbi } from "../abi/pons.js";
import { client } from "../chain/clients.js";
import { PONS } from "../chain/config.js";
import { recentLaunches, type LaunchEvent } from "../pons/detect.js";
import { cluster, embed, embedConfig } from "../ml/embed.js";
import { ago, padL, padR } from "../util/fmt.js";
import { c, log } from "../util/log.js";

/**
 * Who is printing the same token over and over, right now.
 *
 * Two ways of asking. The cheap one is exact: same name or same symbol from more than one wallet.
 * The other embeds name and description and clusters what is merely similar, which is the case the
 * exact match cannot see — one operator shipping "Pons Prime", "PonsMax" and "Pons v2 Official"
 * from three addresses. The report keeps them apart so the second one has to earn its place.
 *
 * Measured over 646 launches on 2026-09-09, the semantic pass found ten clusters the exact match
 * missed, about half of them out of reach of any string comparison: KEYTURNIP/KT/KTURN,
 * BUTTER/BTTR, NVDASH/NVDAI/NVDOGE. Real, and small. It is deliberately not wired into the score:
 * a rule earns points here by moving the lift in `accuracy`, and this one has not been measured
 * that way yet.
 */

interface Row {
  ev: LaunchEvent;
  name: string;
  symbol: string;
  description: string;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

async function readMeta(events: LaunchEvent[]): Promise<Row[]> {
  const rows: Row[] = [];
  for (let i = 0; i < events.length; i += 40) {
    const slice = events.slice(i, i + 40);
    const res = await client.multicall({
      contracts: slice.flatMap((e) => [
        { address: e.token, abi: tokenAbi, functionName: "name" as const },
        { address: e.token, abi: tokenAbi, functionName: "symbol" as const },
        { address: e.token, abi: tokenAbi, functionName: "getTokenInfo" as const },
      ]),
      allowFailure: true,
    });
    slice.forEach((ev, k) => {
      const name = res[k * 3]?.status === "success" ? String(res[k * 3]!.result) : "";
      const symbol = res[k * 3 + 1]?.status === "success" ? String(res[k * 3 + 1]!.result) : "";
      const info = res[k * 3 + 2]?.status === "success" ? (res[k * 3 + 2]!.result as readonly [Address, string, string, unknown]) : null;
      if (name || symbol) rows.push({ ev, name, symbol, description: info?.[2] ?? "" });
    });
  }
  return rows;
}

/** Groups sharing a normalised name or symbol, keyed by whichever matched. */
function exactGroups(rows: Row[]): Map<string, number[]> {
  const by = new Map<string, number[]>();
  rows.forEach((r, i) => {
    for (const key of new Set([`n:${norm(r.name)}`, `s:${norm(r.symbol)}`])) {
      if (key.length <= 2) continue;
      const g = by.get(key);
      if (g) g.push(i);
      else by.set(key, [i]);
    }
  });
  // One wallet launching the same name twice is a retry; two wallets is an operation. And a group
  // that matched on both the name and the symbol arrives here twice, so keep one per member set.
  const seen = new Set<string>();
  const out = new Map<string, number[]>();
  for (const [key, idx] of by) {
    if (new Set(idx.map((i) => rows[i]!.ev.deployer.toLowerCase())).size < 2) continue;
    const id = [...idx].sort((x, y) => x - y).join(",");
    if (seen.has(id)) continue;
    seen.add(id);
    out.set(key, idx);
  }
  return out;
}

const wallets = (rows: Row[], idx: number[]): string[] => [...new Set(idx.map((i) => rows[i]!.ev.deployer.toLowerCase()))];

function printCluster(rows: Row[], idx: number[], label: string): void {
  const w = wallets(rows, idx);
  const names = [...new Set(idx.map((i) => rows[i]!.symbol || rows[i]!.name).filter(Boolean))];
  const newest = Math.max(...idx.map((i) => Number(rows[i]!.ev.blockNumber)));
  const oldest = Math.min(...idx.map((i) => Number(rows[i]!.ev.blockNumber)));
  console.log(
    `${c.yellow(padL(`×${idx.length}`, 5))}  ${padR(names.slice(0, 3).join(", ").slice(0, 44), 46)}` +
    `${padL(`${w.length} wallets`, 11)}  ${c.grey(`${newest - oldest} blocks apart`)}  ${c.grey(label)}`,
  );
  for (const a of w.slice(0, 6)) console.log(c.grey(`         ${a}`));
  if (w.length > 6) console.log(c.grey(`         and ${w.length - 6} more`));
}

export function registerFarmsCommand(program: Command): void {
  program
    .command("farms")
    .description("launch farms operating right now: one operator, many wallets, the same token")
    .option("--blocks <n>", "how far back to look", (v: string) => BigInt(Math.max(100, Math.round(Number(v)))), 6_000n)
    .option("--semantic", "also cluster on what the launches mean, not just on exact names (needs OPENLUX_API_KEY)")
    .option("--threshold <n>", "how alike two launches have to be, 0..1", (v: string) => Math.min(0.99, Math.max(0.5, Number(v))), 0.80)
    .action(async (o: { blocks: bigint; semantic?: boolean; threshold: number }) => {
      const events = await recentLaunches(o.blocks);
      if (events.length === 0) { log.info(c.grey("no launches in that window")); return; }
      const rows = await readMeta(events);
      if (rows.length === 0) { log.info(c.grey("none of those launches would give up their metadata")); return; }

      const exact = exactGroups(rows);
      const claimed = new Set<number>();
      console.log(`${c.bold("farms")}  ${c.grey(`${rows.length} launches read of ${events.length} in the last ${o.blocks} blocks`)}\n`);

      const sorted = [...exact.values()].sort((a, b) => b.length - a.length);
      for (const idx of sorted) {
        printCluster(rows, idx, "same name");
        for (const i of idx) claimed.add(i);
      }
      if (sorted.length === 0) console.log(c.grey("  no wallet pair shipped the same name"));

      if (!o.semantic) {
        console.log(c.grey(`\n--semantic also groups launches that only mean the same thing.`));
        return;
      }
      if (!embedConfig()) {
        log.warn("--semantic needs OPENLUX_API_KEY in .env; showing exact matches only");
        return;
      }

      // name and description together: the name alone is too short to separate two memecoins, and
      // the description alone is empty on plenty of launches
      const texts = rows.map((r) => `${r.name} (${r.symbol}). ${r.description}`.slice(0, 600).trim());
      const { vectors, fromCache, fetched, failed } = await embed(texts);
      console.log(c.grey(`\nembedded ${fetched} launches, ${fromCache} already cached${failed ? `, ${failed} could not be read` : ""}`));

      const groups = cluster(vectors, o.threshold)
        .filter((idx) => wallets(rows, idx).length > 1)
        .sort((a, b) => b.length - a.length);

      // The only number that decides whether this is worth its API call: what it found that the
      // exact match did not. A cluster whose members were all caught already is not a new finding.
      const fresh = groups.filter((idx) => idx.some((i) => !claimed.has(i)));
      console.log(`\n${c.bold("by meaning")}  ${c.grey(`similarity ≥ ${o.threshold}`)}\n`);
      if (fresh.length === 0) {
        console.log(c.grey("  nothing the exact match had not already caught"));
      } else {
        for (const idx of fresh) printCluster(rows, idx, `${idx.filter((i) => !claimed.has(i)).length} new`);
      }
      console.log(c.grey(`\n${groups.length} clusters by meaning, ${fresh.length} of them carrying launches the exact match missed.`));
      console.log(c.grey("this does not move any score. it is here to be looked at until it has been shown to be worth points."));
    });
}
