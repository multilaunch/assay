import type { Command } from "commander";
import { closeDb, dbPath, stats } from "../index/db.js";
import { ingest } from "../index/ingest.js";
import { baseRate } from "../index/read.js";
import { c, log } from "../util/log.js";
import { padL } from "../util/fmt.js";
import { rmSync } from "node:fs";

/**
 * `assay index` — read the chain once, keep it, stop asking.
 *
 * Nothing depends on it. Every reader falls back to the chain when the index does not cover what
 * it was asked for, so an index that is empty, stale, or deleted costs speed and nothing else.
 * That is deliberate: this is a cache of public data, and the moment it becomes load-bearing it
 * becomes something that can be wrong in a way nobody notices.
 */

const num = (n: number): string => n.toLocaleString("en-US");

export function registerIndexCommand(program: Command): void {
  const cmd = program.command("index").description("build and follow a local copy of the launch log");

  cmd
    .command("run", { isDefault: true })
    .description("catch up to the head, then follow (Ctrl-C to stop)")
    .option("--from <block>", "where to start when the index is empty")
    .option("--to <block>", "stop at this block instead of following")
    .option("--once", "catch up and exit")
    .option("--chunk <blocks>", "widest block range to request", "10000")
    .option("--keep <blocks>", "discard anything further behind the head than this (0 keeps everything)", "0")
    .action(async (o: { from?: string; to?: string; once?: boolean; chunk: string; keep: string }) => {
      const ctl = new AbortController();
      let stopping = false;
      process.on("SIGINT", () => {
        if (stopping) process.exit(130);
        stopping = true;
        log.info("finishing the current range, then stopping");
        ctl.abort();
      });

      const t0 = Date.now();
      let lastLine = 0;
      const p = await ingest(
        {
          ...(o.from ? { from: BigInt(o.from) } : {}),
          ...(o.to ? { to: BigInt(o.to) } : {}),
          follow: !o.once && !o.to,
          chunk: BigInt(o.chunk),
          keep: Number(o.keep),
          onProgress: (pr) => {
            if (Date.now() - lastLine < 1000) return;
            lastLine = Date.now();
            const behind = pr.head - pr.block;
            const rate = (pr.block - 0) > 0 ? (Date.now() - t0) / 1000 : 0;
            log.info(
              `${c.white(num(pr.block))}  ${behind > 0 ? c.grey(`${num(behind)} behind`) : c.green("at head")}` +
              `  ${num(pr.launches)} launches  ${num(pr.graduations)} graduated  ${num(pr.trades)} trades` +
              `  ${rate.toFixed(0)}s`,
            );
          },
          onError: (where, e) => log.warn(`${where}: ${e instanceof Error ? e.message.slice(0, 90) : String(e)}`),
        },
        ctl.signal,
      );

      const s = stats();
      log.info(`${num(p.launches)} launches, ${num(p.graduations)} graduations, ${num(p.trades)} trades in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      log.info(`index holds ${num(s.launches)} launches over blocks ${num(s.from ?? 0)}–${num(s.cursor ?? 0)}, ${(s.bytes / 1e6).toFixed(1)} MB`);
      closeDb();
    });

  cmd
    .command("stats")
    .description("what the index holds")
    .action(() => {
      const s = stats();
      const row = (k: string, v: string) => console.log(`${c.grey(k.padEnd(14))} ${v}`);
      row("file", dbPath());
      row("blocks", s.from === null ? c.grey("nothing ingested") : `${num(s.from)} – ${num(s.cursor ?? 0)}  (${num((s.cursor ?? 0) - s.from)} blocks)`);
      row("launches", num(s.launches));
      row("graduated", num(s.graduations));
      row("trades", num(s.trades));
      row("size", `${(s.bytes / 1e6).toFixed(1)} MB`);
      const b = baseRate();
      if (b && b.launches > 0) {
        row("base rate", `${(b.rate * 100).toFixed(2)}%  ${padL(num(b.graduated), 6)} of ${num(b.launches)}`);
      }
      closeDb();
    });

  cmd
    .command("reset")
    .description("delete the index; it rebuilds from the chain")
    .action(() => {
      closeDb();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath() + suffix, { force: true });
      log.info(`removed ${dbPath()}`);
    });
}
