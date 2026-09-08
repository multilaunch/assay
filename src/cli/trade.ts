import type { Command } from "commander";
import { isAddress, parseEther, type Address } from "viem";
import { escrowAbi, factoryAbi } from "../abi/pons.js";
import { client } from "../chain/clients.js";
import { DEAD, EXPLORER, PONS, ZERO } from "../chain/config.js";
import { notify, telegramEnabled } from "../alerts/telegram.js";
import { confirmLive } from "../engine/arm.js";
import { startEngine, type EngineEvent } from "../engine/engine.js";
import { rulesFromEnv, type EngineRules } from "../engine/rules.js";
import { progress } from "../pons/curve.js";
import { deployerLaunches, feeLedger } from "../pons/fees.js";
import { curveActivity, enrichLaunch } from "../pons/enrich.js";
import { findLaunchEvent } from "../pons/detect.js";
import { allPositions, openPositions, pnlPct } from "../trade/positions.js";
import { curveState } from "../trade/state.js";
import { markPosition, resolveVenue } from "../trade/venue.js";
import { getAccount } from "../trade/wallet.js";
import { amount, ago, bar, eth, padL, padR, pct, short } from "../util/fmt.js";
import { c, hhmmss, link, log } from "../util/log.js";
import { renderCard } from "./render.js";

const sym = (s: string | undefined, fallback: string) => (s ? `$${s}` : short(fallback));

/** Turn one engine event into one terminal line. The engine never prints; this decides how it looks. */
function printEvent(e: EngineEvent, live: boolean): void {
  const t = c.grey(hhmmss(new Date(e.at)));
  switch (e.kind) {
    case "launch": {
      const s = sym(e.intel.meta?.symbol, e.intel.ev.token);
      if (e.fire) return; // the draw line says it better
      log.info(`${t}  ${c.grey("pass ")} ${padR(s, 12)} ${padL(String(e.score.total), 3)}  ${c.grey(e.why.join("; "))}`);
      return;
    }
    case "draw": log.info(`${t}  ${c.cyan("draw ")} ${padR(e.symbol, 12)}      ${c.grey("waiting for the opening tax to fall")}`); return;
    case "fire": log.info(`${t}  ${c.badge(" FIRE ")} ${padR(e.symbol, 12)}      ${live ? "bought" : "would buy"} ${eth(e.quoteIn)} ETH → ${(Number(e.tokens) / 1e18 / 1e6).toFixed(2)}M at tax ${(e.taxBps / 100).toFixed(2)}% after ${e.waitedMs} ms${e.hash ? c.grey(`  ${e.hash}`) : ""}`); return;
    case "hold": log.info(`${t}  ${c.grey("hold ")} ${padR(e.symbol, 12)}      tax still ${(e.taxBps / 100).toFixed(1)}% after ${e.waitedMs} ms`); return;
    case "mark": log.info(`${t}  ${c.grey("mark ")} ${padR(e.symbol, 12)}      ${e.pnlPct >= 0 ? c.green(`+${e.pnlPct.toFixed(1)}%`) : c.red(`${e.pnlPct.toFixed(1)}%`)} on ${e.venue}`); return;
    case "exit": log.info(`${t}  ${e.pnlPct >= 0 ? c.green("exit ") : c.red("exit ")} ${padR(e.symbol, 12)}      ${live ? "sold" : "would sell"} for ${eth(e.quoteOut)} (${e.pnlPct >= 0 ? "+" : ""}${e.pnlPct.toFixed(1)}%) on ${e.venue}: ${e.reason}`); return;
    case "swept": log.info(`${t}  ${c.yellow("swept")} ${padR(e.symbol, 12)}      between the curve and the pool, nothing trades`); return;
    case "index": log.info(c.grey(`${t}  deployer index ready: ${e.launches} launches, ${e.graduations} graduations, ${e.deployers} deployers`)); return;
    case "state": log.info(c.grey(`${t}  ${e.paused ? "paused: reading and scoring, firing nothing" : live ? "armed" : "dry run started"}`)); return;
    case "error": log.warn(`${e.where}: ${e.message}`); return;
  }
}

export function registerTradeCommands(program: Command): void {
  // ---- snipe --------------------------------------------------------------------------------------
  program
    .command("snipe")
    .description("watch launches and enter the ones that pass the rules; dry run unless --live")
    .option("--live", "sign and send real transactions")
    .option("--eth <amount>", "quote per entry", (v) => Number(v))
    .option("--min-score <n>", "minimum score", (v) => Number(v))
    .option("--max-open <n>", "how many positions may be open at once", (v) => Number(v))
    .option("--budget <eth>", "total the entries may consume this session", (v) => Number(v))
    .option("--keyword <re>", "only launches whose name, symbol or description match")
    .option("--deployer <addr...>", "only these deployers")
    .option("--allow-pairs", "also non-ETH pairs (stock tokens, stables)")
    .option("--for <seconds>", "stop after this many seconds", (v) => Number(v))
    .action(async (o: { live?: boolean; eth?: number; minScore?: number; maxOpen?: number; budget?: number; keyword?: string; deployer?: string[]; allowPairs?: boolean; for?: number }) => {
      const over: Partial<EngineRules> = {};
      if (o.eth !== undefined) over.entryQuote = parseEther(String(o.eth));
      if (o.minScore !== undefined) over.minScore = o.minScore;
      if (o.maxOpen !== undefined) over.maxOpenPositions = o.maxOpen;
      if (o.budget !== undefined) over.sessionBudget = parseEther(String(o.budget));
      if (o.keyword) over.keyword = new RegExp(o.keyword, "i");
      if (o.deployer?.length) over.deployers = new Set(o.deployer.map((d) => d.toLowerCase()));
      if (o.allowPairs) over.ethPairsOnly = false;
      const rules = rulesFromEnv(over);

      const live = o.live === true;
      if (live && !(await confirmLive(rules))) return;

      log.info(`${c.bold("hoodterm")} ${c.grey(`snipe · ${live ? "LIVE" : "dry run"} · ${eth(rules.entryQuote)} ETH per entry · budget ${eth(rules.sessionBudget)} · max open ${rules.maxOpenPositions} · min score ${rules.minScore} · tax ceiling ${rules.maxOpeningTaxBps / 100}%`)}`);
      log.info(c.grey(`TP +${rules.exits.takeProfitPct}%  SL −${rules.exits.stopLossPct}%  trail ${rules.exits.trailingPct}%  hold ${rules.exits.maxHoldMin} min${telegramEnabled() ? "  ·  telegram on" : ""}`));
      log.info(c.grey("─".repeat(88)));

      const engine = startEngine({ live, rules, onEvent: (e) => { printEvent(e, live); void notify(e); } });
      const bye = () => { engine.stop(); log.info(c.grey(`\nstopped. spent ${eth(engine.spent())} ETH on entries this session.`)); process.exit(0); };
      process.on("SIGINT", bye);
      if (o.for && o.for > 0) setTimeout(bye, o.for * 1000);
    });

  // ---- board --------------------------------------------------------------------------------------
  program
    .command("board")
    .description("the same engine behind a page on 127.0.0.1; opens as a feed and fires nothing until you press start")
    .option("--live", "sign and send real transactions once armed on the page")
    .option("--port <n>", "port", (v) => Number(v), Number(process.env.BOARD_PORT ?? 4663))
    .option("--eth <amount>", "quote per entry", (v) => Number(v))
    .option("--budget <eth>", "total the entries may consume this session", (v) => Number(v))
    .action(async (o: { live?: boolean; port: number; eth?: number; budget?: number }) => {
      const over: Partial<EngineRules> = {};
      if (o.eth !== undefined) over.entryQuote = parseEther(String(o.eth));
      if (o.budget !== undefined) over.sessionBudget = parseEther(String(o.budget));
      const rules = rulesFromEnv(over);
      const live = o.live === true;
      if (live && !(await confirmLive(rules))) return;

      const { startBoard } = await import("../board/server.js");
      const b = startBoard({ port: o.port, live, rules });
      log.info(`${c.bold("hoodterm")} ${c.grey("board")}  ${b.url}  ${live ? c.badge(" LIVE ") : c.grey("dry run")}  ${c.grey("feed only until you press start")}`);
      log.info(c.grey("loopback only; the page has no route that buys on demand, and --live is a launch flag"));
      process.on("SIGINT", () => { b.close(); log.info(c.grey("\nboard stopped")); process.exit(0); });
    });

  // ---- watch --------------------------------------------------------------------------------------
  program
    .command("watch <token>")
    .description("follow one launch: curve fill, flow, opening tax, then the pool price")
    .option("--every <seconds>", "how often to print", (v) => Number(v), 5)
    .option("--for <seconds>", "stop after this many seconds", (v) => Number(v), 600)
    .action(async (token: string, o: { every: number; for: number }) => {
      if (!isAddress(token, { strict: false })) { log.error("not an address"); process.exitCode = 2; return; }
      const t = token as Address;
      const rec = await client.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [t] });
      if (!rec.exists) { log.error("the factory has no record of that token"); process.exitCode = 2; return; }
      const pairNative = rec.pairToken.toLowerCase() === ZERO;
      log.info(c.grey(`watching ${short(t)} · curve ${short(rec.curve)} · ${link("pons", EXPLORER.pons(t))}`));

      const started = Date.now();
      const tick = async () => {
        const v = await resolveVenue(t).catch(() => null);
        if (!v) { log.warn("could not resolve the venue"); return; }
        if (v.venue === "swept") { log.info(`${c.grey(hhmmss())}  ${c.yellow("swept")}  between the curve and the pool, nothing trades`); return; }
        if (v.venue === "pool") {
          const m = await markPosition(t, rec.curve, 10n ** 18n);
          log.info(`${c.grey(hhmmss())}  ${c.cyan("pool ")}  1 token ≈ ${m ? amount(m.quote, pairNative ? 18 : 6, 8) : "?"} ${pairNative ? "ETH" : "quote"}`);
          return;
        }
        const cv = v.curve ?? (await curveState(rec.curve, DEAD));
        const p = progress(cv);
        const act = await curveActivity(rec.curve, 0n, 0).catch(() => null);
        log.info(`${c.grey(hhmmss())}  ${bar(p)} ${(p * 100).toFixed(1)}%  ${amount(cv.realQuoteReserve, pairNative ? 18 : 6, 3)}/${amount(cv.graduationThreshold, pairNative ? 18 : 6, 2)}  tax ${pct(cv.openingTaxBps)}${act ? c.grey(`  buys ${act.buys} sells ${act.sells} buyers ${act.uniqueBuyers}`) : ""}`);
      };
      await tick();
      const iv = setInterval(() => { void tick(); }, Math.max(1, o.every) * 1000);
      setTimeout(() => { clearInterval(iv); log.info(c.grey(`stopped after ${Math.round((Date.now() - started) / 1000)}s`)); }, o.for * 1000);
    });

  // ---- fees ---------------------------------------------------------------------------------------
  program
    .command("fees <token>")
    .description("who is paid on this token, how much accrued, and every claim")
    .action(async (token: string) => {
      if (!isAddress(token, { strict: false })) { log.error("not an address"); process.exitCode = 2; return; }
      const l = await feeLedger(token as Address);
      const dec = l.pairToken.toLowerCase() === ZERO ? 18 : 6;
      console.log(`recipient   ${l.recipient}  ${l.isDeployer ? c.grey("(the deployer)") : c.yellow("(NOT the deployer: a builder / KOL deal)")}`);
      console.log(`credited    ${amount(l.credited, dec, 6)}  across ${l.credits.length} credits in the last ${l.windowBlocks} blocks`);
      console.log(`claimed     ${amount(l.claimed, dec, 6)}  across ${l.claims.length} claims`);
      console.log(`pending     ${amount(l.pending, dec, 6)}  ${c.grey("read live from the escrow")}`);
      for (const cl of l.claims.slice(-8)) console.log(c.grey(`  claim  block ${cl.at}  ${amount(cl.amount, dec, 6)}`));
    });

  // ---- dev ----------------------------------------------------------------------------------------
  program
    .command("dev <address>")
    .description("every launch by one deployer, with the phase each one reached")
    .action(async (addr: string) => {
      if (!isAddress(addr, { strict: false })) { log.error("not an address"); process.exitCode = 2; return; }
      const rows = await deployerLaunches(addr as Address);
      if (rows.length === 0) { console.log(c.grey("no launches by that address in the window")); return; }
      const graduated = rows.filter((r) => r.phase === "PoolCreated").length;
      console.log(`${rows.length} launches, ${graduated} graduated ${c.grey(`(${((graduated / rows.length) * 100).toFixed(1)}%)`)}`);
      for (const r of rows.slice(-25)) console.log(`  block ${padL(String(r.block), 9)}  ${r.token}  ${r.phase === "PoolCreated" ? c.green(r.phase) : c.grey(r.phase)}`);
    });

  // ---- positions ----------------------------------------------------------------------------------
  program
    .command("positions")
    .description("open and closed positions, marked live")
    .option("--all", "include closed ones")
    .action(async (o: { all?: boolean }) => {
      const rows = o.all ? allPositions() : openPositions();
      if (rows.length === 0) { console.log(c.grey("no positions")); return; }
      for (const p of rows) {
        const m = p.status === "open" ? await markPosition(p.token, p.curve, BigInt(p.tokens)) : null;
        const mark = m ? pnlPct(p, m.quote) : p.exits.length ? pnlPct(p, BigInt(p.exits[p.exits.length - 1]!.quoteOut)) : 0;
        const tag = p.status === "open" ? c.cyan("open  ") : c.grey("closed");
        console.log(`${tag} ${padR(`$${p.symbol}`, 12)} ${p.dryRun ? c.grey("dry") : c.yellow("live")}  in ${amount(BigInt(p.entryQuote), p.pairDecimals)} ${p.pairSymbol}  ${mark >= 0 ? c.green(`+${mark.toFixed(1)}%`) : c.red(`${mark.toFixed(1)}%`)}  ${c.grey(`${ago(Date.now() - p.openedAt * 1000)} ago${m ? ` on ${m.venue}` : ""}`)}`);
        for (const x of p.exits) console.log(c.grey(`        exit ${amount(BigInt(x.quoteOut), p.pairDecimals)} ${p.pairSymbol}: ${x.reason}`));
      }
    });

  // ---- wallet -------------------------------------------------------------------------------------
  program
    .command("wallet")
    .description("the signer: address, balance, unclaimed creator fees")
    .action(async () => {
      const a = getAccount();
      if (!a) { console.log(c.grey("no PRIVATE_KEY in .env; analytics and dry run only")); return; }
      const [bal, pending] = await Promise.all([
        client.getBalance({ address: a.address }),
        client.readContract({ address: PONS.escrow, abi: escrowAbi, functionName: "balanceOf", args: [a.address] }).catch(() => 0n),
      ]);
      console.log(`address   ${a.address}`);
      console.log(`balance   ${eth(bal)} ETH`);
      console.log(`fees      ${eth(pending)} ETH unclaimed in the pons escrow`);
      console.log(c.grey(`          ${EXPLORER.address(a.address)}`));
    });

  // ---- inspect (a single launch, richer than scan) --------------------------------------------------
  program
    .command("inspect <token>")
    .description("the full card for one token, plus its first-minute flow")
    .action(async (token: string) => {
      if (!isAddress(token, { strict: false })) { log.error("not an address"); process.exitCode = 2; return; }
      const t = token as Address;
      const rec = await client.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [t] });
      if (!rec.exists) { log.error("the factory has no record of that token"); process.exitCode = 2; return; }
      // the real launch log, so the opening buy and the declared bundle can actually be read
      const ev = (await findLaunchEvent(t)) ?? { token: t, curve: rec.curve, deployer: rec.deployer, pairToken: rec.pairToken, launchConfigId: 0n, graduationThreshold: rec.graduationThreshold, blockNumber: 0n, txHash: "0x" as `0x${string}`, logIndex: 0, seenAtMs: Date.now() };
      const intel = await enrichLaunch(ev, DEAD);
      const { scoreLaunch } = await import("../score/score.js");
      console.log(renderCard(intel, scoreLaunch(intel, {})));
      const l = await feeLedger(t).catch(() => null);
      if (l) console.log(`   fees → ${l.isDeployer ? "deployer" : c.yellow("third party")} ${short(l.recipient)}  credited ${amount(l.credited, l.pairToken.toLowerCase() === ZERO ? 18 : 6, 5)}  pending ${amount(l.pending, l.pairToken.toLowerCase() === ZERO ? 18 : 6, 5)}`);
    });
}
