import type { Command } from "commander";
import { MATURE_MS, report, resolveOutcomes, THIN, lift, wilsonLower } from "../track/accuracy.js";
import { all, journalPath } from "../track/journal.js";
import { ago, padL, padR } from "../util/fmt.js";
import { c, log } from "../util/log.js";

const pc = (x: number) => `${(x * 100).toFixed(2)}%`;

export function registerAccuracyCommands(program: Command): void {
  program
    .command("accuracy")
    .description("what the score has actually been worth: graduation rate by verdict, from your own journal")
    .option("--resolve", "look up outcomes on chain for launches old enough to judge, before reporting")
    .option("--json", "machine-readable")
    .action(async (o: { resolve?: boolean; json?: boolean }) => {
      if (o.resolve) {
        const r = await resolveOutcomes();
        if (!o.json) log.info(c.grey(`resolved ${r.settled} of ${r.checked} mature launches, ${r.pending} still too young to judge\n`));
      }

      const rows = await all();
      if (rows.length === 0) {
        log.info(`nothing recorded yet. ${c.grey(journalPath())}`);
        log.info(c.grey("run `hunt` or `snipe` for a while, then come back with --resolve."));
        return;
      }

      const rep = await report(rows);
      if (o.json) { console.log(JSON.stringify(rep, null, 2)); return; }

      const span = rep.from && rep.to ? `${ago(Date.now() - rep.from)} of history` : "";
      console.log(`${c.bold("score accuracy")}  ${c.grey(`${rep.total} launches recorded, ${rep.total - rep.pending} judged, ${rep.pending} still young. ${span}`)}`);
      console.log(c.grey(`a launch is judged once it is ${MATURE_MS / 3_600_000}h old; before that it counts for nothing.\n`));

      console.log(c.grey(`${padR("verdict", 9)}${padL("judged", 8)}${padL("graduated", 11)}${padL("rate", 9)}${padL("95% floor", 11)}${padL("lift", 7)}`));
      for (const b of rep.buckets) {
        const l = lift(b, rep.base);
        const floor = wilsonLower(b.graduated, b.judged);
        const thin = b.judged > 0 && b.judged < THIN;
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
        const bar = "▪".repeat(Math.min(40, Math.round(band.rate * 400)));
        console.log(`  ${padR(`${band.from}-${band.to}`, 8)}${padL(String(band.judged), 7)} judged  ${padL(pc(band.rate), 8)}  ${bar}`);
      }

      const fire = rep.buckets.find((b) => b.verdict === "FIRE");
      console.log("");
      if (!fire || fire.judged < THIN) {
        console.log(c.yellow(`too few judged FIRE launches to say anything yet (${fire?.judged ?? 0} of ${THIN}).`));
      } else {
        const l = lift(fire, rep.base) ?? 0;
        const floor = wilsonLower(fire.graduated, fire.judged);
        console.log(
          l >= 1.5 && floor > rep.base
            ? c.green(`FIRE graduates ${l.toFixed(1)}x more often than the average launch you saw, and the 95% floor still clears the base rate.`)
            : c.yellow(`FIRE is ${l.toFixed(1)}x the base rate, but the 95% floor (${pc(floor)}) does not clear it (${pc(rep.base)}). Not proven yet.`),
        );
      }
      console.log(c.grey(`journal: ${journalPath()}`));
    });
}
