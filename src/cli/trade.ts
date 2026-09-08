import type { Command } from "commander";
import { isAddress, parseEther, parseUnits, type Address } from "viem";
import { erc20Abi, escrowAbi, factoryAbi } from "../abi/pons.js";
import { client } from "../chain/clients.js";
import { DEAD, EXPLORER, PONS, ZERO } from "../chain/config.js";
import { notify, telegramEnabled } from "../alerts/telegram.js";
import { confirmLive } from "../engine/arm.js";
import { startEngine, type EngineEvent } from "../engine/engine.js";
import { rulesFromEnv, type EngineRules } from "../engine/rules.js";
import { clampSlippageBps, progress } from "../pons/curve.js";
import { deployerLaunches, feeLedger } from "../pons/fees.js";
import { curveActivity, enrichLaunch, pairInfo } from "../pons/enrich.js";
import { findLaunchEvent, searchLaunchEvent } from "../pons/detect.js";
import { allPositions, openPositions, pnlPct } from "../trade/positions.js";
import { curveState } from "../trade/state.js";
import { buyAnywhere, readMark, resolveVenue, sellAnywhere } from "../trade/venue.js";
import { getAccount, walletClient } from "../trade/wallet.js";
import { amount, ago, bar, eth, padL, padR, pct, short } from "../util/fmt.js";
import { envNum } from "../util/env.js";
import { c, hhmmss, link, log } from "../util/log.js";
import { renderCard } from "./render.js";

const sym = (s: string | undefined, fallback: string) => (s ? `$${s}` : short(fallback));

/** How far back `watch` reads curve trades when the launch log cannot be found. */
const ACTIVITY_FALLBACK_BLOCKS = 100_000n;

/** Commander only runs this on a value the user typed, so the env default is clamped separately. */
function slippageArg(v: string): number {
  const raw = Number(v);
  const bps = clampSlippageBps(raw);
  if (raw !== bps) log.warn(`slippage ${v} is not a whole number of basis points between 0 and 10000; using ${bps}`);
  return bps;
}

/**
 * `--pair-entry 0xstable=25000000`. The size is in the pair asset's own smallest unit, because its
 * decimals are not known until the token is read and an amount that quietly means something else is
 * the exact failure this option exists to prevent.
 */
function parsePairEntries(specs: string[]): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const spec of specs) {
    const [addr = "", units = ""] = spec.split("=");
    if (!isAddress(addr, { strict: false }) || !/^\d+$/.test(units.trim())) throw new Error(`--pair-entry wants <address>=<whole units>, got ${spec}`);
    out.set(addr.toLowerCase(), BigInt(units.trim()));
  }
  return out;
}

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
    .option("--pair-entry <addr=units...>", "entry size for one non-ETH pair, in that asset's own smallest unit")
    .option("--for <seconds>", "stop after this many seconds", (v) => Number(v))
    .action(async (o: { live?: boolean; eth?: number; minScore?: number; maxOpen?: number; budget?: number; keyword?: string; deployer?: string[]; allowPairs?: boolean; pairEntry?: string[]; for?: number }) => {
      const over: Partial<EngineRules> = {};
      if (o.eth !== undefined) over.entryQuote = parseEther(String(o.eth));
      if (o.minScore !== undefined) over.minScore = o.minScore;
      if (o.maxOpen !== undefined) over.maxOpenPositions = o.maxOpen;
      if (o.budget !== undefined) over.sessionBudget = parseEther(String(o.budget));
      if (o.keyword) over.keyword = new RegExp(o.keyword, "i");
      if (o.deployer?.length) over.deployers = new Set(o.deployer.map((d) => d.toLowerCase()));
      if (o.allowPairs) over.ethPairsOnly = false;
      if (o.pairEntry?.length) {
        try { over.entryQuoteByPair = parsePairEntries(o.pairEntry); }
        catch (e) { log.error((e as Error).message); process.exitCode = 2; return; }
      }
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
    .option("--host <addr>", "interface to bind; 0.0.0.0 inside a container, where the host publish is what restricts it", process.env.BOARD_HOST ?? "127.0.0.1")
    .option("--eth <amount>", "quote per entry", (v) => Number(v))
    .option("--budget <eth>", "total the entries may consume this session", (v) => Number(v))
    .action(async (o: { live?: boolean; port: number; host: string; eth?: number; budget?: number }) => {
      const over: Partial<EngineRules> = {};
      if (o.eth !== undefined) over.entryQuote = parseEther(String(o.eth));
      if (o.budget !== undefined) over.sessionBudget = parseEther(String(o.budget));
      const rules = rulesFromEnv(over);
      const live = o.live === true;
      if (live && !(await confirmLive(rules))) return;

      const { startBoard } = await import("../board/server.js");
      const b = startBoard({ port: o.port, live, rules, host: o.host });
      log.info(`${c.bold("hoodterm")} ${c.grey("board")}  ${b.url}  ${live ? c.badge(" LIVE ") : c.grey("dry run")}  ${c.grey("feed only until you press start")}`);
      log.info(c.grey(b.host === "0.0.0.0"
        ? "bound to 0.0.0.0 (a container); publish it on 127.0.0.1 so only this machine can reach it"
        : "loopback only; the page has no route that buys on demand, and --live is a launch flag"));
      process.on("SIGINT", () => { b.close(); log.info(c.grey("\nboard stopped")); process.exit(0); });
    });

  // ---- buy ----------------------------------------------------------------------------------------
  program
    .command("buy <token> <amount>")
    .description("buy a launch wherever it trades: the curve before graduation, the v4 pool after")
    .option("--live", "sign and send")
    .option("--slippage <bps>", "slippage in basis points", slippageArg, clampSlippageBps(envNum("SLIPPAGE_BPS", 300)))
    .action(async (token: string, amount: string, o: { live?: boolean; slippage: number }) => {
      if (!isAddress(token, { strict: false })) { log.error("not an address"); process.exitCode = 2; return; }
      const t = token as Address;
      const v = await resolveVenue(t);
      const pair = await pairInfo(v.record.pairToken);
      const quoteIn = parseUnits(amount, pair.decimals);
      const live = o.live === true;

      // A buy on the curve inside the opening window hands most of the spend to the creator.
      // Say so with the real number rather than letting it happen quietly.
      if (v.venue === "curve" && v.curve && v.curve.openingTaxBps > 0n) {
        log.warn(`the opening tax is ${pct(v.curve.openingTaxBps)} right now — that share of this buy goes to the creator. Wait a few seconds.`);
      }

      const r = await buyAnywhere(t, quoteIn, o.slippage, { dryRun: !live });
      console.log(`${live ? c.green("bought") : c.grey("would buy")} on the ${r.venue}: ${amount} ${pair.symbol} → ${(Number(r.amountOut) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens${r.hash ? c.grey(`  ${r.hash}`) : ""}`);
      if (!live) console.log(c.grey("dry run: nothing was sent. add --live to sign."));
    });

  // ---- sell ---------------------------------------------------------------------------------------
  program
    .command("sell <token> [percent]")
    .description("sell a share of your balance wherever the launch trades (default 100)")
    .option("--live", "sign and send")
    .option("--slippage <bps>", "slippage in basis points", slippageArg, clampSlippageBps(envNum("SLIPPAGE_BPS", 300)))
    .action(async (token: string, percent: string | undefined, o: { live?: boolean; slippage: number }) => {
      if (!isAddress(token, { strict: false })) { log.error("not an address"); process.exitCode = 2; return; }
      const t = token as Address;
      const acct = getAccount();
      if (!acct) { log.error("selling needs PRIVATE_KEY in .env, even for a dry run: there is no balance to sell without a wallet"); process.exitCode = 2; return; }

      const share = Math.min(100, Math.max(1, Number(percent ?? 100)));
      const balance = await client.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [acct.address] });
      if (balance === 0n) { log.error("that wallet holds none of this token"); process.exitCode = 2; return; }
      const tokensIn = share === 100 ? balance : (balance * BigInt(Math.round(share))) / 100n;

      const v = await resolveVenue(t);
      const pair = await pairInfo(v.record.pairToken);
      const live = o.live === true;
      const r = await sellAnywhere(t, tokensIn, o.slippage, { dryRun: !live });
      console.log(`${live ? c.green("sold") : c.grey("would sell")} ${share}% (${(Number(tokensIn) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens) on the ${r.venue} for ${amount(r.amountOut, pair.decimals, 6)} ${pair.symbol}${r.hash ? c.grey(`  ${r.hash}`) : ""}`);
      if (!live) console.log(c.grey("dry run: nothing was sent. add --live to sign."));
    });

  // ---- claim --------------------------------------------------------------------------------------
  program
    .command("claim [token]")
    .description("take your creator fees out of the pons escrow; give a token to claim its pair asset")
    .option("--live", "sign and send")
    .action(async (token: string | undefined, o: { live?: boolean }) => {
      const acct = getAccount();
      if (!acct) { log.error("claiming needs PRIVATE_KEY in .env"); process.exitCode = 2; return; }

      // Native and ERC-20 balances live in separate escrow ledgers, so which one to claim depends
      // on what the launch was paired with.
      let pairToken: Address = ZERO as Address;
      if (token) {
        if (!isAddress(token, { strict: false })) { log.error("not an address"); process.exitCode = 2; return; }
        const rec = await client.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token as Address] });
        if (!rec.exists) { log.error("the factory has no record of that token"); process.exitCode = 2; return; }
        pairToken = rec.pairToken;
      }
      const pair = await pairInfo(pairToken);
      const pending = pair.native
        ? await client.readContract({ address: PONS.escrow, abi: escrowAbi, functionName: "balanceOf", args: [acct.address] })
        : await client.readContract({ address: PONS.escrow, abi: escrowAbi, functionName: "balanceOfToken", args: [acct.address, pair.address] });

      console.log(`recipient  ${acct.address}`);
      console.log(`pending    ${amount(pending, pair.decimals, 6)} ${pair.native ? "ETH" : pair.symbol}`);
      if (pending === 0n) { console.log(c.grey("nothing to claim")); return; }
      if (o.live !== true) { console.log(c.grey("dry run: nothing was sent. add --live to claim.")); return; }

      const wallet = walletClient();
      const hash = pair.native
        ? await wallet.writeContract({ address: PONS.escrow, abi: escrowAbi, functionName: "claim", account: acct, chain: null })
        : await wallet.writeContract({ address: PONS.escrow, abi: escrowAbi, functionName: "claimToken", args: [pair.address], account: acct, chain: null });
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
      console.log(receipt.status === "success" ? c.green(`claimed  ${hash}`) : c.red(`reverted  ${hash}`));
      if (receipt.status !== "success") process.exitCode = 1;
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
      const pair = await pairInfo(rec.pairToken);
      log.info(c.grey(`watching ${short(t)} · curve ${short(rec.curve)} · ${link("pons", EXPLORER.pons(t))}`));

      // curveActivity re-reads every log since `from` on each tick. From block 0 that is a
      // whole-chain eth_getLogs every --every seconds against the only endpoint that serves logs.
      const launch = await findLaunchEvent(t).catch(() => null);
      const head = await client.getBlockNumber();
      const from = launch?.blockNumber ?? (head > ACTIVITY_FALLBACK_BLOCKS ? head - ACTIVITY_FALLBACK_BLOCKS : 0n);

      const started = Date.now();
      const tick = async () => {
        const v = await resolveVenue(t).catch(() => null);
        if (!v) { log.warn("could not resolve the venue"); return; }
        if (v.venue === "swept") { log.info(`${c.grey(hhmmss())}  ${c.yellow("swept")}  between the curve and the pool, nothing trades`); return; }
        if (v.venue === "pool") {
          const m = await readMark(t, rec.curve, 10n ** 18n);
          const price = m.status === "ok" ? `${amount(m.quote, pair.decimals, 8)} ${pair.symbol}` : m.status === "swept" ? c.yellow("nothing trades yet") : c.yellow(m.why);
          log.info(`${c.grey(hhmmss())}  ${c.cyan("pool ")}  1 token ≈ ${price}`);
          return;
        }
        const cv = v.curve ?? (await curveState(rec.curve, DEAD));
        const p = progress(cv);
        const act = await curveActivity(rec.curve, from, 0).catch(() => null);
        log.info(`${c.grey(hhmmss())}  ${bar(p)} ${(p * 100).toFixed(1)}%  ${amount(cv.realQuoteReserve, pair.decimals, 3)}/${amount(cv.graduationThreshold, pair.decimals, 2)}  tax ${pct(cv.openingTaxBps)}${act ? c.grey(`  buys ${act.buys} sells ${act.sells} buyers ${act.uniqueBuyers}`) : ""}`);
      };
      await tick();
      // a tick slower than --every must not have the next one stacked behind it
      let ticking = false;
      const iv = setInterval(() => {
        if (ticking) return;
        ticking = true;
        void tick().catch((e: Error) => log.warn(e.message.split("\n")[0] ?? "")).finally(() => { ticking = false; });
      }, Math.max(1, o.every) * 1000);
      setTimeout(() => { clearInterval(iv); log.info(c.grey(`stopped after ${Math.round((Date.now() - started) / 1000)}s`)); }, o.for * 1000);
    });

  // ---- fees ---------------------------------------------------------------------------------------
  program
    .command("fees <token>")
    .description("who is paid on this token, how much accrued, and every claim")
    .action(async (token: string) => {
      if (!isAddress(token, { strict: false })) { log.error("not an address"); process.exitCode = 2; return; }
      const l = await feeLedger(token as Address);
      const dec = (await pairInfo(l.pairToken)).decimals;
      console.log(`recipient   ${l.recipient}  ${l.isDeployer ? c.grey("(the deployer)") : c.yellow("(NOT the deployer: a builder / KOL deal)")}`);
      const partial = l.failedChunks > 0 ? c.yellow(`  (${l.failedChunks} of ${l.chunks} log ranges refused, so this is a floor)`) : "";
      console.log(`credited    ${l.failedChunks > 0 ? ">= " : ""}${amount(l.credited, dec, 6)}  across ${l.credits.length} credits in the last ${l.windowBlocks} blocks${partial}`);
      console.log(`claimed     ${amount(l.claimed, dec, 6)}  across ${l.claims.length} claims`);
      console.log(l.pendingKnown
        ? `pending     ${amount(l.pending, dec, 6)}  ${c.grey("read live from the escrow")}`
        : `pending     ${c.yellow("unknown")}  ${c.grey("the escrow balance read was refused")}`);
      for (const cl of l.claims.slice(-8)) console.log(c.grey(`  claim  block ${cl.at}  ${amount(cl.amount, dec, 6)}`));
    });

  // ---- dev ----------------------------------------------------------------------------------------
  program
    .command("dev <address>")
    .description("every launch by one deployer, with the phase each one reached")
    .action(async (addr: string) => {
      if (!isAddress(addr, { strict: false })) { log.error("not an address"); process.exitCode = 2; return; }
      const rows = await deployerLaunches(addr as Address);
      if (rows.length === 0) {
        console.log(rows.failedChunks > 0
          ? c.yellow(`could not read ${rows.failedChunks} of ${rows.chunks} log ranges for that address; the ranges that answered had no launches`)
          : c.grey("no launches by that address in the window"));
        return;
      }
      const graduated = rows.filter((r) => r.phase === "PoolCreated").length;
      const gap = rows.failedChunks > 0 ? c.yellow(`  (partial: ${rows.failedChunks} of ${rows.chunks} log ranges refused)`) : "";
      console.log(`${rows.length} launches, ${graduated} graduated ${c.grey(`(${((graduated / rows.length) * 100).toFixed(1)}%)`)}${gap}`);
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
        const r = p.status === "open" ? await readMark(p.token, p.curve, BigInt(p.tokens)) : null;
        const m = r?.status === "ok" ? r : null;
        const mark = m ? pnlPct(p, m.quote) : p.exits.length ? pnlPct(p, BigInt(p.exits[p.exits.length - 1]!.quoteOut)) : 0;
        const tag = p.status === "open" ? c.cyan("open  ") : c.grey("closed");
        console.log(`${tag} ${padR(`$${p.symbol}`, 12)} ${p.dryRun ? c.grey("dry") : c.yellow("live")}  in ${amount(BigInt(p.entryQuote), p.pairDecimals)} ${p.pairSymbol}  ${mark >= 0 ? c.green(`+${mark.toFixed(1)}%`) : c.red(`${mark.toFixed(1)}%`)}  ${c.grey(`${ago(Date.now() - p.openedAt * 1000)} ago${m ? ` on ${m.venue}` : r?.status === "unreadable" ? ` · ${r.why}` : ""}`)}`);
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
      const found = await searchLaunchEvent(t);
      if (!found.ev && found.failedChunks > 0) log.warn(`the launch log could not be looked up (${found.failedChunks} of ${found.chunks} log ranges refused); the opening buy and declared bundle will read as unknown`);
      const ev = found.ev ?? { token: t, curve: rec.curve, deployer: rec.deployer, pairToken: rec.pairToken, launchConfigId: 0n, graduationThreshold: rec.graduationThreshold, blockNumber: 0n, txHash: "0x" as `0x${string}`, logIndex: 0, seenAtMs: Date.now() };
      const intel = await enrichLaunch(ev, DEAD);
      const { scoreLaunch } = await import("../score/score.js");
      console.log(renderCard(intel, scoreLaunch(intel, {})));
      const l = await feeLedger(t).catch(() => null);
      if (l) {
        const dec = (await pairInfo(l.pairToken)).decimals;
        console.log(`   fees → ${l.isDeployer ? "deployer" : c.yellow("third party")} ${short(l.recipient)}  credited ${amount(l.credited, dec, 5)}  pending ${amount(l.pending, dec, 5)}`);
      }
    });
}
