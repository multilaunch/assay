import { Command } from "commander";
import { encodeFunctionData, formatEther, isAddress, type Address } from "viem";
import { curveAbi, factoryAbi } from "../abi/pons.js";
import { client, fast, gate, ws, wsLabel } from "../chain/clients.js";
import { CHAIN_ID, DEAD, MULTICALL3, PONS } from "../chain/config.js";
import { effectiveOpeningBps, quoteBuy } from "../pons/curve.js";
import { DeployerIndex } from "../pons/deployers.js";
import { recentLaunches, searchLaunchEvent, watchLaunches, type LaunchEvent } from "../pons/detect.js";
import { curveActivity, devSharePct, enrichLaunch } from "../pons/enrich.js";
import { record } from "../track/journal.js";
import { FarmDetector } from "../pons/farm.js";
import { scoreLaunch } from "../score/score.js";
import { eth, pct, short } from "../util/fmt.js";
import { c, hhmmss, log, setQuiet } from "../util/log.js";
import { renderCard, renderLine, toJson } from "./render.js";
import { registerTradeCommands } from "./trade.js";
import { registerAccuracyCommands } from "./accuracy.js";
import { registerFarmsCommand } from "./farms.js";

const program = new Command();
program.name("hoodterm").description("Launch terminal for Robinhood Chain (pons v2). Local, open, non-custodial, dry run by default.").version("0.1.0");

async function ethUsd(): Promise<number | null> {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", { signal: AbortSignal.timeout(4000) });
    const j = (await r.json()) as { ethereum?: { usd?: number } };
    return j.ethereum?.usd ?? null;
  } catch { return null; }
}


program
  .command("doctor")
  .description("is the chain there, are the pons numbers what we think, can we read a live curve")
  .option("--probe", "also read the newest curve and cross-check the local quote against an eth_call of buy()")
  .action(async (o: { probe?: boolean }) => {
    let failed = 0;
    const row = (k: string, v: string, ok = true) => { if (!ok) failed++; console.log(`${ok ? c.green(" ok ") : c.red("FAIL")} ${c.white(k.padEnd(12))} ${v}`); };

    const t0 = Date.now();
    const [id, head] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
    row("rpc", `${gate.route()}  ${Date.now() - t0} ms  chain ${id}  block ${head}`, id === CHAIN_ID);
    row("websocket", ws ? wsLabel() : "off (polling)");

    const F = { address: PONS.factory, abi: factoryAbi } as const;
    const r = await client.multicall({
      contracts: [
        { ...F, functionName: "launchEnabled" }, { ...F, functionName: "launchFee" }, { ...F, functionName: "maxCreatorTaxBps" },
        { ...F, functionName: "snipeTaxStartBps" }, { ...F, functionName: "snipeTaxSeconds" }, { ...F, functionName: "launchConfigCount" },
        { ...F, functionName: "memeHook" }, { ...F, functionName: "feeEscrow" }, { ...F, functionName: "launchForwarder" }, { ...F, functionName: "locker" },
      ],
      allowFailure: true,
    });
    const v = <T,>(i: number): T | undefined => (r[i]?.status === "success" ? (r[i]!.result as T) : undefined);
    const enabled = v<boolean>(0), fee = v<bigint>(1), maxTax = v<bigint>(2), stBps = v<bigint>(3), stSec = v<bigint>(4), cfg = v<bigint>(5);
    row("factory", `${PONS.factory}  launches ${enabled ? "enabled" : "DISABLED"}  configs ${cfg ?? "?"}`, enabled === true);
    row("economics", `launch fee ${fee !== undefined ? eth(fee) : "?"} ETH   opening tax ${stBps !== undefined ? pct(stBps) : "?"} over ${stSec ?? "?"} s   max creator tax ${maxTax !== undefined ? pct(maxTax) : "?"}`, stBps !== undefined && stSec !== undefined);
    const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
    row("addresses", `hook ${same(v(6), PONS.hook) ? "ok" : "MISMATCH"}  escrow ${same(v(7), PONS.escrow) ? "ok" : "MISMATCH"}  router ${same(v(8), PONS.router) ? "ok" : "MISMATCH"}  locker ${same(v(9), PONS.locker) ? "ok" : "MISMATCH"}`, same(v(6), PONS.hook) && same(v(7), PONS.escrow) && same(v(8), PONS.router) && same(v(9), PONS.locker));

    const code = await client.getBytecode({ address: MULTICALL3 });
    row("multicall3", `${code ? (code.length - 2) / 2 : 0} bytes at ${short(MULTICALL3)}`, !!code && code.length > 100);

    const launches = await recentLaunches(3_000n).catch(() => null);
    row("tempo", launches ? `${launches.length} launches in the last 3 000 blocks (~5 min)` : "getLogs refused by every endpoint", launches !== null);

    const px = await ethUsd();
    row("eth/usd", px ? `$${px}` : "unavailable (display only)");
    row("wallet", process.env.PRIVATE_KEY ? "key present (used only by live trades)" : c.grey("no key: analytics and dry run only"));

    if (o.probe && launches && launches.length) {
      // Walk back from the newest until an ETH-paired, still-open curve turns up: the quote check
      // below only means something against native ETH, and most launches are paired with something else.
      let intel = await enrichLaunch(launches[launches.length - 1]!, DEAD);
      for (let i = launches.length - 1; i >= 0 && i > launches.length - 25; i--) {
        const cand = await enrichLaunch(launches[i]!, DEAD);
        if (cand.pair.native && cand.curve && !cand.curve.graduated && !cand.curve.readyToGraduate) { intel = cand; break; }
      }
      const ev = intel.ev;
      const cv = intel.curve;
      row("probe", `${intel.meta?.symbol ?? short(ev.token)}  pair ${intel.pair.symbol}/${intel.pair.decimals}  launchedAt ${cv?.launchedAt ?? "?"}  openingTax(dead) ${cv ? pct(cv.openingTaxBps) : "?"}  fee ${cv ? pct(cv.feeBps) : "?"}  creator ${cv ? pct(cv.creatorTaxBps) : "?"}`, !!cv && cv.launchedAt > 0);
      if (cv && !cv.graduated && !cv.readyToGraduate && intel.pair.native) {
        // the differentiator: the local quote must match what the contract itself would return
        const spend = 1_000_000_000_000_000n; // 0.001 ETH
        const local = quoteBuy(cv, spend);
        try {
          const sim = await fast.call({ to: ev.curve, data: encodeFunctionData({ abi: curveAbi, functionName: "buy", args: [spend, 0n, DEAD] }), value: spend, account: DEAD });
          const onchain = sim.data ? BigInt(sim.data) : 0n;
          const diff = local.tokensOut > onchain ? local.tokensOut - onchain : onchain - local.tokensOut;
          const relBps = onchain > 0n ? Number((diff * 10_000n) / onchain) : 9999;
          row("quote check", `local ${formatEther(local.tokensOut)} vs chain ${formatEther(onchain)} tokens for 0.001 ETH  (opening leg ${pct(effectiveOpeningBps(cv))}, diff ${relBps} bps)`, relBps <= 5);
        } catch (e) {
          row("quote check", `simulation refused: ${(e as Error).message.split("\n")[0]?.slice(0, 100) ?? ""}`, false);
        }
      } else if (cv) {
        row("quote check", c.grey(`skipped: ${!intel.pair.native ? `pair is ${intel.pair.symbol}` : "curve closed"}`));
      }
    }

    console.log(c.grey(`\n${gate.status().map((s) => `${s.label}: ${s.calls} calls, ${s.rejected} rejected${s.benched ? ", benched" : ""}`).join("  ·  ")}`));
    if (failed) { console.log(c.red(`\n${failed} check${failed > 1 ? "s" : ""} failed`)); process.exitCode = 1; }
  });


program
  .command("hunt")
  .description("live feed of launches with a score and the reasons")
  .option("--for <seconds>", "stop after this many seconds", (v) => Number(v))
  .option("--min-score <n>", "only print launches at or above this score", (v) => Number(v), 0)
  .option("--fire-only", "only FIRE verdicts")
  .option("--no-follow", "cards only, no +15 s / +60 s follow-up lines")
  .option("--json", "one JSON object per line, no colours")
  .action(async (o: { for?: number; minScore: number; fireOnly?: boolean; follow: boolean; json?: boolean }) => {
    if (o.json) setQuiet(true);
    const px = await ethUsd();
    const index = new DeployerIndex();
    const farms = new FarmDetector();
    index.start(
      (s) => log.info(c.grey(`${hhmmss()}  deployer index ready: ${s.launches} launches, ${s.graduations} graduations, ${s.deployers} deployers in the last ${index.windowBlocks} blocks`)),
      (e, sec, final) => {
        const msg = e.message.split("\n")[0]?.slice(0, 80) ?? "";
        log.warn(`deployer index: ${msg}${final ? "; not retrying, scoring runs without history until restart" : `; scoring without history, retry in ${sec} s`}`);
      },
    );
    const stSec = Number(await client.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "snipeTaxSeconds" }).catch(() => 3n));

    log.info(`${c.bold("hoodterm")} ${c.grey(`hunt · pons v2 · chain ${CHAIN_ID} · ${ws ? "websocket" : "polling"}${px ? ` · ETH $${px}` : ""}`)}`);
    log.info(c.grey("─".repeat(88)));

    let inFlight = 0;
    const onLaunch = async (ev: LaunchEvent) => {
      if (inFlight >= 4) return; // never let a burst turn into a burst of RPC
      inFlight++;
      const t0 = Date.now();
      try {
        index.note(ev);
        const intel = await enrichLaunch(ev, DEAD, { retries: 3, retryDelayMs: 400 });
        const { twins } = farms.observe(intel);
        const deployer = index.lookup(ev.deployer, ev.token);
        const score = scoreLaunch(intel, { deployer, farmTwins: twins });
        record({
          t: t0, token: ev.token, curve: ev.curve, deployer: ev.deployer,
          symbol: intel.meta?.symbol ?? null, score: score.total, verdict: score.verdict,
          devPct: intel.tx ? devSharePct(intel.tx) : null,
          taxBps: intel.record ? Number(intel.record.creatorTaxBps) : null,
          exempt: intel.tx?.exemptions.length ?? null,
          farmTwins: twins,
          deployerPrior: deployer?.prior ?? null, deployerGraduated: deployer?.graduated ?? null,
          pair: intel.pair.symbol, pairNative: intel.pair.native,
        });
        const show = score.total >= o.minScore && (!o.fireOnly || score.verdict === "FIRE");
        if (show) {
          if (o.json) log.json(toJson(intel, score, { deployer, farmTwins: twins, readMs: Date.now() - t0 }));
          else console.log(renderCard(intel, score, { ethUsd: px, deployer, farmTwins: twins, readMs: Date.now() - t0 }) + "\n");
        }
        if (o.follow && show && !o.json && intel.curve) {
          const windowEnd = intel.curve.launchedAt + stSec;
          for (const delay of [15_000, 60_000]) {
            setTimeout(async () => {
              try {
                const fresh = await enrichLaunch(ev, DEAD);
                const act = await curveActivity(ev.curve, ev.blockNumber, windowEnd);
                const s2 = scoreLaunch(fresh, { deployer: index.lookup(ev.deployer, ev.token), farmTwins: twins, activity: act, ageSec: Math.round(delay / 1000) });
                console.log(renderLine(fresh, s2, `+${delay / 1000}s  buyers ${act.uniqueBuyers}  buys ${act.buys} sells ${act.sells}  early ${act.earlyBuys}`));
              } catch { /* a follow-up that failed is not worth a line */ }
            }, delay);
          }
        }
      } catch (e) {
        log.warn(`${short(ev.token)}: ${(e as Error).message.split("\n")[0]?.slice(0, 100) ?? ""}`);
      } finally { inFlight--; }
    };

    const stop = watchLaunches((ev) => void onLaunch(ev), { onHealth: (h) => log.info(c.grey(`${hhmmss()}  feed: ${h.mode}, recoveries ${h.recoveries}`)) });
    const bye = () => { stop(); index.stop(); log.info(c.grey(`\n${hhmmss()}  stopped`)); process.exit(0); };
    process.on("SIGINT", bye);
    if (o.for && o.for > 0) setTimeout(bye, o.for * 1000);
  });


program
  .command("scan [token]")
  .description("everything on chain about one token; the newest launch when no address is given")
  .option("--json", "JSON instead of a card")
  .action(async (token: string | undefined, o: { json?: boolean }) => {
    let ev: LaunchEvent | undefined;
    if (token) {
      if (!isAddress(token, { strict: false })) { log.error("not an address"); process.exitCode = 2; return; }
      const rec = await client.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token as Address] });
      if (!rec.exists) { log.error("the factory has no record of that token"); process.exitCode = 2; return; }
      // prefer the real launch log: without its tx hash the opening buy and the bundle cannot be read
      const found = await searchLaunchEvent(token as Address);
      if (!found.ev && found.failedChunks > 0) log.warn(`the launch log could not be looked up (${found.failedChunks} of ${found.chunks} log ranges refused); the opening buy and declared bundle will read as unknown`);
      ev = found.ev ?? { token: rec.token, curve: rec.curve, deployer: rec.deployer, pairToken: rec.pairToken, launchConfigId: 0n, graduationThreshold: rec.graduationThreshold, blockNumber: 0n, txHash: "0x" as `0x${string}`, logIndex: 0, seenAtMs: Date.now() };
    } else {
      const list = await recentLaunches(3_000n);
      ev = list[list.length - 1];
      if (!ev) { log.error("no launches in the last 3 000 blocks"); process.exitCode = 2; return; }
    }
    const px = await ethUsd();
    const intel = await enrichLaunch(ev, DEAD);
    const score = scoreLaunch(intel, {});
    if (o.json) console.log(JSON.stringify(toJson(intel, score), null, 2));
    else console.log(renderCard(intel, score, { ethUsd: px }));
  });

// Everything that can move money lives in its own file, and every one of those commands is dry run
// unless it is given --live.
registerTradeCommands(program);
registerAccuracyCommands(program);
registerFarmsCommand(program);

program.parseAsync(process.argv).catch((e: Error) => { log.error(e.message.split("\n")[0]); process.exitCode = 1; });
