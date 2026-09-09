import { EXPLORER } from "../chain/config.js";
import { fdvInQuote, progress } from "../pons/curve.js";
import { devSharePct, socialsOf, type LaunchIntel } from "../pons/enrich.js";
import type { DeployerRecord } from "../pons/deployers.js";
import { render, renderReason } from "../score/notes.js";
import type { Score } from "../score/score.js";
import { amount, bar, compact, pct, short, usd } from "../util/fmt.js";
import { c, hhmmss, link } from "../util/log.js";

const verdictColor = (v: Score["verdict"]) => (v === "FIRE" ? c.badge(` ${v} `) : v === "WATCH" ? c.yellow(v) : c.grey(v));

export interface CardOpts { ethUsd?: number | null; deployer?: DeployerRecord | null; readMs?: number; farmTwins?: number }

/** One launch as a multi-line card. Every number on it was read from the chain seconds ago. */
export function renderCard(intel: LaunchIntel, score: Score, o: CardOpts = {}): string {
  const { ev, meta, record, curve, pair, tx } = intel;
  const sym = meta?.symbol ? `$${meta.symbol}` : short(ev.token);
  const name = meta?.name ?? "(unreadable)";
  const lines: string[] = [];

  lines.push(`${c.grey(hhmmss())}  ${c.bold(link(name, EXPLORER.pons(ev.token)))}  ${c.cyan(sym)}  ${c.grey(ev.token)}  ${verdictColor(score.verdict)} ${c.bold(String(score.total).padStart(3))}`);

  const dev = tx ? `${devSharePct(tx).toFixed(2)}% (${amount(tx.devBuy, pair.decimals)} ${pair.symbol})` : "?";
  const tax = record ? pct(record.creatorTaxBps) : "?";
  const feeTo = record && tx ? (record.creatorFeeRecipient.toLowerCase() === tx.from.toLowerCase() ? "deployer" : `third party ${short(record.creatorFeeRecipient)}`) : "?";
  const exempt = tx ? String(tx.exemptions.length) : "?";
  lines.push(`   opening buy ${c.white(dev)}   creator tax ${c.white(tax)}   fees → ${c.white(feeTo)}   exempt wallets ${c.white(exempt)}${tx ? c.grey(`   via ${tx.via}`) : ""}`);

  const soc = socialsOf(meta);
  const socStr = [soc.x && "x", soc.web && "web", soc.tg && "tg"].filter(Boolean).join(" ") || c.grey("none");
  const desc = (meta?.description ?? "").replace(/\s+/g, " ").trim();
  lines.push(`   socials ${socStr}${desc ? `   ${c.grey(desc.slice(0, 90))}${desc.length > 90 ? c.grey("…") : ""}` : ""}`);

  if (o.deployer) {
    const d = o.deployer;
    lines.push(`   deployer ${short(ev.deployer)}  ${d.prior === 0 ? c.green("fresh") : `${d.prior} prior, ${d.graduated} graduated`}${(o.farmTwins ?? 0) > 0 ? c.yellow(`   farm twins ${o.farmTwins}`) : ""}`);
  } else {
    lines.push(`   deployer ${short(ev.deployer)}  ${c.grey("(index building)")}${(o.farmTwins ?? 0) > 0 ? c.yellow(`   farm twins ${o.farmTwins}`) : ""}`);
  }

  if (curve) {
    const p = progress(curve);
    const fdvQ = fdvInQuote(curve, pair.decimals);
    const fdvUsd = pair.native && o.ethUsd ? usd(fdvQ * o.ethUsd) : !pair.native && pair.decimals === 6 ? usd(fdvQ) : "";
    const real = amount(curve.realQuoteReserve, pair.decimals, pair.decimals === 18 ? 3 : 0);
    const thr = amount(curve.graduationThreshold, pair.decimals, pair.decimals === 18 ? 2 : 0);
    lines.push(`   curve ${bar(p)} ${(p * 100).toFixed(1)}%  ${real}/${thr} ${pair.symbol}   fdv ${compact(fdvQ, 2)} ${pair.symbol}${fdvUsd ? ` ${c.grey(fdvUsd)}` : ""}   opening tax now ${pct(curve.openingTaxBps)}`);
  }

  lines.push(`   ${c.grey(score.reasons.map(renderReason).join(" · "))}`);
  if (score.flags.length) lines.push(`   ${c.yellow("!")} ${c.grey(score.flags.map(render).join(" · "))}`);
  lines.push(`   ${c.grey("open:")} ${link("pons", EXPLORER.pons(ev.token))} · ${link("explorer", EXPLORER.token(ev.token))} · ${link("tx", EXPLORER.tx(ev.txHash))}${o.readMs !== undefined ? c.grey(`   read in ${o.readMs} ms`) : ""}`);
  return lines.join("\n");
}

export function renderLine(intel: LaunchIntel, score: Score, note = ""): string {
  const sym = intel.meta?.symbol ? `$${intel.meta.symbol}` : short(intel.ev.token);
  const p = intel.curve ? `${(progress(intel.curve) * 100).toFixed(0)}%` : "?";
  return `${c.grey(hhmmss())}  ${verdictColor(score.verdict)} ${String(score.total).padStart(3)}  ${c.cyan(sym.padEnd(12))} curve ${p.padStart(4)}  ${c.grey(note)}`;
}

export function toJson(intel: LaunchIntel, score: Score, o: CardOpts = {}): Record<string, unknown> {
  const { ev, meta, record, curve, pair, tx } = intel;
  return {
    t: Date.now(), block: ev.blockNumber.toString(), tx: ev.txHash, token: ev.token, curveAddress: ev.curve, deployer: ev.deployer,
    name: meta?.name ?? null, symbol: meta?.symbol ?? null, description: meta?.description ?? null, socials: meta?.socials ?? null,
    pair: { address: pair.address, symbol: pair.symbol, decimals: pair.decimals, native: pair.native },
    creatorTaxBps: record ? Number(record.creatorTaxBps) : null, feeRecipient: record?.creatorFeeRecipient ?? null, phase: record?.phase ?? null,
    devBuy: tx?.devBuy.toString() ?? null, devSharePct: tx ? devSharePct(tx) : null, exemptions: tx?.exemptions ?? null, via: tx?.via ?? null,
    curve: curve ? { progress: progress(curve), realQuote: curve.realQuoteReserve.toString(), threshold: curve.graduationThreshold.toString(), openingTaxBps: Number(curve.openingTaxBps), feeBps: Number(curve.feeBps), launchedAt: curve.launchedAt } : null,
    deployerRecord: o.deployer ?? null, farmTwins: o.farmTwins ?? 0,
    score: score.total, verdict: score.verdict, reasons: score.reasons.map(renderReason), flags: score.flags.map(render), errors: intel.errors,
  };
}
