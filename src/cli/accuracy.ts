import type { Command } from "commander";
import { MATURE_MS, report, resolveOutcomes, resolvePrices, sampleNeeded, THIN, thinFor, lift, wilsonLower } from "../track/accuracy.js";
import { backfill } from "../track/backfill.js";
import { all, journalPath } from "../track/journal.js";
import { ago, padL, padR } from "../util/fmt.js";
import { c, log } from "../util/log.js";

const pc = (x: number) => `${(x * 100).toFixed(2)}%`;

export function registerAccuracyCommands(program: Command): void {
  program
    .command("accuracy")
    .description("what the score has actually been worth: graduation rate by verdict, from your own journal")
    .option("--resolve", "look up outcomes on chain for launches old enough to judge, before reporting")
    .option("--backfill", "score launches that already happened, so there is something to report on day one")
    .option("--limit <n>", "how many launches to reconstruct with --backfill", (v: string) => Math.max(1, Math.min(2000, Math.round(Number(v)))), 400)
    .option("--live-only", "count only launches this terminal saw as they happened")
    .option("--price", "read every mature launch's trade history and record what holding it was worth")
    .option("--json", "machine-readable")
    .action(async (o: { resolve?: boolean; backfill?: boolean; limit: number; liveOnly?: boolean; price?: boolean; json?: boolean }) => {
      if (o.backfill) {
        if (!o.json) log.info(c.grey(`reconstructing up to ${o.limit} launches old enough to judge. this reads the chain and takes a few minutes.`));
        let shown = -1;
        const r = await backfill({
          limit: o.limit,
          onProgress: (done, total) => {
            if (o.json || total === 0) return;
            const pc10 = Math.floor((done / total) * 10);
            if (pc10 === shown) return;
            shown = pc10;
            process.stderr.write(`\r  ${done}/${total}`);
          },
        });
        if (!o.json) {
          process.stderr.write("\r                    \r");
          log.info(c.grey(`added ${r.added} launches, ${r.known} were already recorded${r.failedChunks > 0 ? c.yellow(`, ${r.failedChunks} of ${r.chunks} log ranges refused so the sample is thinner than asked for`) : ""}`));
        }
        // Nothing to report on until the outcomes are looked up, and every backfilled row is old
        // enough to have one, so there is no reason to make the user ask twice.
        o.resolve = true;
      }

      if (o.resolve) {
        const r = await resolveOutcomes();
        if (!o.json) log.info(c.grey(`resolved ${r.settled} of ${r.checked} mature launches, ${r.pending} still too young to judge\n`));
      }

      if (o.price) {
        let shown = -1;
        const r = await resolvePrices(Date.now(), (done, total) => {
          if (o.json || total === 0) return;
          const tenth = Math.floor((done / total) * 20);
          if (tenth === shown) return;
          shown = tenth;
          process.stderr.write(`\r  ${done}/${total}`);
        });
        if (!o.json) {
          process.stderr.write("\r                    \r");
          log.info(c.grey(`priced ${r.scanned} launches; ${r.withTrades} of them were traded at all${r.failedChunks ? c.yellow(`, ${r.failedChunks} log ranges refused`) : ""}\n`));
        }
      }

      const every = await all();
      const rows = o.liveOnly ? every.filter((e) => e.source !== "backfill") : every;
      if (rows.length === 0) {
        log.info(o.liveOnly && every.length > 0 ? "nothing was seen live yet; drop --live-only to include the reconstructed launches." : `nothing recorded yet. ${c.grey(journalPath())}`);
        if (!o.liveOnly) log.info(c.grey("run `hunt` or `snipe` for a while, or `accuracy --backfill` to score launches that already happened."));
        return;
      }

      const rep = await report(rows);
      if (o.json) { console.log(JSON.stringify(rep, null, 2)); return; }

      const span = rep.from && rep.to ? `${ago(Date.now() - rep.from)} of history` : "";
      const reconstructed = rows.filter((e) => e.source === "backfill").length;
      console.log(`${c.bold("score accuracy")}  ${c.grey(`${rep.total} launches recorded, ${rep.total - rep.pending} judged, ${rep.pending} still young. ${span}`)}`);
      console.log(c.grey(`a launch is judged once it is ${MATURE_MS / 3_600_000}h old; before that it counts for nothing.`));
      if (reconstructed > 0) {
        console.log(c.grey(`${reconstructed} of these were reconstructed from chain history, scored on what was knowable at the time. ${rows.length - reconstructed} were seen live. --live-only drops the reconstructed ones.`));
      }
      console.log("");

      // What counts as a usable sample depends on how rare graduation is, and on this chain it is
      // very rare, so the bar is derived from the base rate rather than fixed.
      const overall = rep.buckets.find((b) => b.verdict === "all")!;
      const bar = thinFor(rep.base, overall.judged);
      console.log(c.grey(`${padR("verdict", 9)}${padL("judged", 8)}${padL("graduated", 11)}${padL("rate", 9)}${padL("95% floor", 11)}${padL("lift", 7)}`));
      for (const b of rep.buckets) {
        const l = lift(b, rep.base);
        const floor = wilsonLower(b.graduated, b.judged);
        const thin = b.judged > 0 && b.judged < bar;
        const name = b.verdict === "all" ? c.grey("all") : b.verdict;
        const rate = b.judged === 0 ? c.grey("—") : pc(b.rate);
        const liftTxt = l === null ? c.grey("—") : l >= 1.5 ? c.green(`${l.toFixed(1)}x`) : l <= 0.7 ? c.red(`${l.toFixed(1)}x`) : `${l.toFixed(1)}x`;
        console.log(
          `${padR(String(name), 9)}${padL(String(b.judged), 8)}${padL(String(b.graduated), 11)}${padL(rate, 9)}` +
          `${padL(b.judged ? pc(floor) : "—", 11)}${padL(b.verdict === "all" ? c.grey("—") : liftTxt, 7)}` +
          (thin ? c.yellow("  thin sample") : ""),
        );
      }

      console.log(`\n${c.grey("by score band")}`);
      for (const band of rep.bands) {
        if (band.judged === 0) continue;
        const blocks = "▪".repeat(Math.min(40, Math.round(band.rate * 400)));
        console.log(`  ${padR(`${band.from}-${band.to}`, 8)}${padL(String(band.judged), 7)} judged  ${padL(pc(band.rate), 8)}  ${blocks}`);
      }

      console.log("");
      const fire = rep.buckets.find((b) => b.verdict === "FIRE");
      if (rep.base === 0 && overall.judged > 0) {
        console.log(c.yellow(`nothing in this sample graduated at all (0 of ${overall.judged}). there is no base rate to measure the score against yet.`));
        console.log(c.grey(`graduation is rare on this chain — around 1 launch in 80 — so a few hundred judged launches is the floor for saying anything. widen it: \`accuracy --backfill --limit 800\`.`));
      } else if (rep.base > 0 && fire && fire.judged > 0) {
        const l = lift(fire, rep.base) ?? 0;
        const floor = wilsonLower(fire.graduated, fire.judged);

        // `bar` is the sample a 2x lift would need. A bucket running well above 2x needs fewer, so
        // the bound has to be read before the bar: a floor that already clears the base rate is a
        // result at 95%, and telling someone their result is not there yet would be false.
        if (floor > rep.base) {
          console.log(c.green(
            `FIRE graduated ${fire.graduated} of ${fire.judged} (${pc(fire.rate)}), ${l.toFixed(1)}x the ${pc(rep.base)} you saw across everything. ` +
            `The 95% floor is ${pc(floor)}, which clears the base rate: on this sample the verdict is worth something.`,
          ));
          const need = sampleNeeded(rep.base, 2);
          if (Number.isFinite(need) && fire.judged < need) {
            console.log(c.grey(`It rests on ${fire.graduated} graduations. A lift of exactly 2x would still be indistinguishable from luck below ~${need} judged FIRE launches, so keep collecting before quoting the multiple.`));
          }
        } else if (fire.judged < bar) {
          const share = overall.judged > 0 ? fire.judged / overall.judged : 0;
          const watch = share > 0 && Number.isFinite(bar) ? Math.ceil(bar / share) : 0;
          console.log(c.yellow(`not enough judged FIRE launches to say anything yet: ${fire.judged}, and ${fire.graduated} graduated.`));
          console.log(c.grey(
            `graduation is rare here — ${pc(rep.base)} of everything you judged — so FIRE needs about ${bar} of its own before twice that rate could be told apart from luck` +
            (watch > 0 ? `, which at your ${pc(share)} FIRE rate means watching roughly ${watch.toLocaleString("en-US")} launches.` : "."),
          ));
        } else {
          console.log(c.yellow(`FIRE is ${l.toFixed(1)}x the base rate over ${fire.judged} judged launches, but the 95% floor (${pc(floor)}) does not clear it (${pc(rep.base)}). Not proven.`));
        }
      }
      console.log(c.grey(`journal: ${journalPath()}`));
      if (rep.total - rep.pending < THIN) console.log(c.grey("`accuracy --backfill` scores launches that already happened, if you would rather not wait."));
    });
}
