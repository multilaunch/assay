import type { Command } from "commander";
import { LABELS, mine, type Label } from "../track/mine.js";
import { all, journalLabel } from "../track/journal.js";
import { padL, padR } from "../util/fmt.js";
import { c, log } from "../util/log.js";

const pc = (x: number) => `${(x * 100).toFixed(2)}%`;
const x = (v: number) => (v === 0 ? "—" : `${v.toFixed(1)}x`);

export function registerRulesCommand(program: Command): void {
  program
    .command("rules")
    .description("what the journal says a rule should be, instead of what I guessed")
    .option("--holdout <n>", "share of the journal held back for judging", (v: string) => Number(v), 0.3)
    .option("--min-n <n>", "below this many launches on a side, say nothing", (v: string) => Math.max(5, Math.round(Number(v))), 40)
    .option("--label <name>", "what counts as a win: graduated, peak2x, peak5x, endUp", "graduated")
    .option("--all", "show the ones that faded too")
    .option("--json", "machine-readable")
    .action(async (o: { holdout: number; minN: number; label: string; all?: boolean; json?: boolean }) => {
      if (!(o.label in LABELS)) { log.error(`unknown label ${o.label}; try ${Object.keys(LABELS).join(", ")}`); process.exitCode = 2; return; }
      const label = o.label as Label;
      const rows = await all();
      const rep = mine(rows, { holdout: o.holdout, minN: o.minN, label });
      if (o.json) { console.log(JSON.stringify(rep, null, 2)); return; }

      if (rep.trainN === 0 || rep.holdoutN === 0) {
        log.info(`not enough judged launches to split. ${c.grey(journalLabel())}`);
        log.info(c.grey(label === "graduated" ? "run `accuracy --backfill --limit 2000`, then `accuracy --resolve`." : "that label needs `accuracy --price` to have run."));
        return;
      }

      const when = rep.splitAt ? new Date(rep.splitAt).toISOString().replace("T", " ").slice(0, 16) : "?";
      console.log(`${c.bold("mined rules")}  ${c.grey(`${rep.trainN} launches to look in, ${rep.holdoutN} held back to judge, split at ${when}`)}`);
      console.log(c.grey(`a win here means: ${LABELS[label].describe}.`));
      console.log(c.grey(`base rate ${pc(rep.trainBase)} while fitting, ${pc(rep.holdoutBase)} on the holdout. ${rep.tested} predicates tested, so about ${rep.expectedFalse.toFixed(0)} of them clear the first half on luck alone — the holdout column is the one to read.\n`));

      const head = `${padR("rule", 34)}${padL("fit n", 7)}${padL("rate", 8)}${padL("held n", 8)}${padL("rate", 8)}${padL("lift", 7)}${padL("95% band", 17)}`;
      console.log(c.grey(head));

      const show = rep.findings.filter((f) => (o.all ? true : f.verdict === "keeps"));
      for (const f of show) {
        const band = `${pc(f.holdout.lo)}-${pc(f.holdout.hi)}`;
        const tint = f.verdict === "keeps" ? (f.direction === "up" ? c.green : c.red) : c.grey;
        const mark = f.verdict === "keeps" ? (f.direction === "up" ? "+" : "−") : f.verdict === "thin" ? "·" : " ";
        console.log(
          `${tint(padR(`${mark} ${f.label}`, 34))}${padL(String(f.train.n), 7)}${padL(pc(f.train.rate), 8)}` +
          `${padL(String(f.holdout.n), 8)}${padL(pc(f.holdout.rate), 8)}${padL(x(f.holdout.lift), 7)}${padL(band, 17)}`,
        );
      }

      const keeps = rep.findings.filter((f) => f.verdict === "keeps");
      console.log("");
      if (keeps.length === 0) {
        console.log(c.yellow("nothing survived the holdout."));
        console.log(c.grey("that is a real answer, not a failure: on this much data none of these signals separates a graduation from a death well enough to bet on. more launches, then look again."));
      } else {
        console.log(c.grey(`${keeps.length} of ${rep.tested} still separated on launches they were not fitted to. those are worth turning into points in score.ts; the rest are not.`));
      }
      if (!o.all) console.log(c.grey("--all shows every predicate, including the ones that faded."));
      console.log(c.grey(`journal: ${journalLabel()}`));
    });
}
