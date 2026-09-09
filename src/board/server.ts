import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startEngine, type Engine, type EngineEvent } from "../engine/engine.js";
import type { EngineRules } from "../engine/rules.js";
import { devSharePct, socialsOf } from "../pons/enrich.js";
import { progress } from "../pons/curve.js";
import { allPositions, openPositions, pnlPct } from "../trade/positions.js";
import { EXPLORER, PONS } from "../chain/config.js";
import { client } from "../chain/clients.js";
import { factoryAbi } from "../abi/pons.js";

/**
 * The engine behind a page on loopback.
 *
 * It binds 127.0.0.1 only, and it has no route that buys on demand: the four verbs are pause, resume,
 * close a position, and edit one of five bounded numeric rules. `--live` is decided when the process
 * starts, so nothing on the page can turn a dry run into a live session.
 *
 * Binding loopback is not on its own a fence. Any page you have open can post a form to
 * http://127.0.0.1:4663/resume, and any page can point a hostname it owns at 127.0.0.1 and then read
 * /state as same-origin. So every request has to name a host we recognise, and every write has to
 * come from this board. See `guard`.
 */

/**
 * The page. `BOARD_HTML` points at a different file, so an alternative skin can be tried against
 * real launches without overwriting the one that ships.
 */
const HTML = () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.BOARD_HTML, join(here, "index.html"), join(here, "..", "..", "src", "board", "index.html")].filter((p): p is string => !!p);
  for (const p of candidates) {
    try { return readFileSync(p, "utf8"); } catch { /* try the next one */ }
  }
  throw new Error("board html not found");
};

/**
 * A board that can be read but not driven. Fencing the four verbs off at the proxy works right up
 * until someone edits the proxy config; enforcing it here survives that.
 */
const readOnly = (): boolean => /^(1|true|yes)$/i.test(process.env.BOARD_READONLY ?? "");

/** Host names this board answers to. Behind a proxy, add the public one via BOARD_HOSTS. */
const knownHosts = (): Set<string> => {
  const extra = (process.env.BOARD_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0", ...extra]);
};

function hostnameOf(header: string | undefined): string | null {
  if (!header) return null;
  try { return new URL(header.includes("://") ? header : `http://${header}`).hostname.replace(/^\[|\]$/g, "").toLowerCase(); }
  catch { return null; }
}

/**
 * Reject anything that is not this board talking to itself.
 *
 * The Host check stops DNS rebinding: an attacker's page reaches us at their hostname, and
 * that name is not one we answer to. On writes the Origin, when a browser sends one, has to be the
 * same host, and the body has to be JSON — a cross-site form can post but it cannot set that
 * content type, so a form never gets past this even before the Origin check runs.
 *
 * Returns the reason it failed, or null when the request may proceed.
 */
function guard(req: IncomingMessage, hosts: Set<string>): string | null {
  const host = hostnameOf(req.headers.host);
  if (!host || !hosts.has(host)) return "unrecognised Host";
  if (req.method !== "POST") return null;
  const origin = req.headers.origin;
  if (origin && origin !== "null" && hostnameOf(origin) !== host) return "cross-origin write";
  if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return "writes must be application/json";
  return null;
}

/** Only these rules can be changed from the page, and only inside these bounds. */
const EDITABLE = {
  minScore: { min: 0, max: 100 },
  maxOpenPositions: { min: 1, max: 10 },
  maxCreatorTaxBps: { min: 0, max: 1000 },
  maxDevSharePct: { min: 0, max: 100 },
  maxExemptWallets: { min: 0, max: 20 },
} as const;
type EditableKey = keyof typeof EDITABLE;

/**
 * A social link is whatever the launcher typed into the token's metadata, so nothing is a URL until
 * it parses as one. `javascript:` there would run in the board's own origin the moment someone clicks
 * the little x next to a launch, and the board can arm a live engine — so anything that is not plain
 * http(s) never reaches the page.
 */
function link(raw: string | undefined): string {
  if (!raw) return "";
  try { const u = new URL(raw); return u.protocol === "https:" || u.protocol === "http:" ? u.href : ""; }
  catch { return ""; }
}

/** Engine events carry bigints and a whole LaunchIntel; the page wants small flat JSON. */
function wire(e: EngineEvent): Record<string, unknown> {
  if (e.kind !== "launch") {
    return JSON.parse(JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) as Record<string, unknown>;
  }
  const { intel, score } = e;
  const soc = socialsOf(intel.meta);
  return {
    kind: "launch", at: e.at, fire: e.fire, why: e.why, readMs: e.readMs, farmTwins: e.farmTwins,
    token: intel.ev.token, curve: intel.ev.curve, deployer: intel.ev.deployer,
    symbol: intel.meta?.symbol ?? null, name: intel.meta?.name ?? "(unreadable)",
    description: (intel.meta?.description ?? "").replace(/\s+/g, " ").trim().slice(0, 280),
    socials: { x: soc.x ? link(intel.meta?.socials.twitter) : "", web: soc.web ? link(intel.meta?.socials.website) : "", tg: soc.tg ? link(intel.meta?.socials.telegram) : "" },
    score: score.total, verdict: score.verdict, reasons: score.reasons, flags: score.flags,
    devPct: intel.tx ? devSharePct(intel.tx) : null,
    exempt: intel.tx?.exemptions ?? null,
    taxBps: intel.record ? Number(intel.record.creatorTaxBps) : null,
    feeRecipient: intel.record?.creatorFeeRecipient ?? null,
    feeToDeployer: !!(intel.record && intel.tx && intel.record.creatorFeeRecipient.toLowerCase() === intel.tx.from.toLowerCase()),
    pair: intel.pair.symbol, pairNative: intel.pair.native,
    progress: intel.curve ? progress(intel.curve) : null,
    openingTaxBps: intel.curve ? Number(intel.curve.openingTaxBps) : null,
    // unix seconds the curve opened. With the factory's snipeTaxSeconds the page can draw the
    // opening tax decaying in real time instead of freezing it at whatever it was when we read.
    launchedAt: intel.curve?.launchedAt ?? null,
    deployerPrior: e.deployer?.prior ?? null, deployerGraduated: e.deployer?.graduated ?? null,
    links: { pons: EXPLORER.pons(intel.ev.token), explorer: EXPLORER.token(intel.ev.token) },
    errors: intel.errors,
  };
}

function positionsPayload(): Record<string, unknown>[] {
  return allPositions().slice(-40).map((p) => ({
    id: p.id, symbol: p.symbol, status: p.status, dryRun: p.dryRun, token: p.token,
    pair: p.pairSymbol, pairDecimals: p.pairDecimals,
    entryQuote: p.entryQuote, lastQuote: p.lastQuote, peakQuote: p.peakQuote,
    openedAt: p.openedAt, pnlPct: pnlPct(p, BigInt(p.lastQuote)),
    exits: p.exits.map((x) => ({ at: x.at, quoteOut: x.quoteOut, reason: x.reason })),
  }));
}

export interface BoardOptions {
  port: number;
  live: boolean;
  rules: EngineRules;
  /**
   * Interface to bind. Loopback by default, which is right on a laptop.
   *
   * In a container loopback means the *container's* loopback, so Docker's port forwarding cannot
   * reach it and the page looks dead from the host. There the bind has to be 0.0.0.0 and the
   * restriction moves to the host side of the publish (`127.0.0.1:4663:4663` in compose.yaml).
   */
  host?: string;
}

export function startBoard(opts: BoardOptions): { engine: Engine; close: () => void; url: string; host: string } {
  const clients = new Set<ServerResponse>();
  const recent: Record<string, unknown>[] = [];

  // The opening-tax window is a protocol parameter the owner can change, so it is read rather than
  // assumed. Until the read lands the page falls back to what the factory shipped with.
  let taxSeconds = 3;
  let taxStartBps = 9900;
  void Promise.all([
    client.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "snipeTaxSeconds" }),
    client.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "snipeTaxStartBps" }),
  ]).then(([sec, bps]) => { taxSeconds = Number(sec); taxStartBps = Number(bps); }).catch(() => undefined);

  const push = (data: Record<string, unknown>) => {
    if (data.kind === "launch" || data.kind === "fire" || data.kind === "exit") {
      recent.push(data);
      if (recent.length > 120) recent.shift();
    }
    const frame = `data: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) { try { res.write(frame); } catch { clients.delete(res); } }
  };

  // Always starts paused: the page opens as a feed and fires nothing until someone presses start.
  const engine = startEngine({
    live: opts.live, rules: opts.rules, startPaused: true,
    onEvent: (e) => { push(wire(e)); if (e.kind === "fire" || e.kind === "exit" || e.kind === "mark") push({ kind: "positions", at: Date.now(), positions: positionsPayload() }); },
  });

  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      let s = "";
      req.on("data", (c) => { s += c; if (s.length > 10_000) req.destroy(); });
      req.on("end", () => { try { resolve(JSON.parse(s || "{}") as Record<string, unknown>); } catch { resolve({}); } });
    });

  const hosts = knownHosts();
  const frozen = readOnly();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    const refused = guard(req, hosts);
    if (refused) { json(res, 403, { error: refused }); return; }
    if (frozen && req.method === "POST") { json(res, 403, { error: "this board is read only" }); return; }

    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(HTML());
      return;
    }

    if (req.method === "GET" && path === "/state") {
      json(res, 200, {
        live: opts.live, paused: engine.isPaused(), spent: engine.spent().toString(), readOnly: frozen,
        taxSeconds, taxStartBps,
        rules: Object.fromEntries(Object.keys(EDITABLE).map((k) => [k, engine.rules[k as EditableKey]])),
        bounds: EDITABLE, recent, positions: positionsPayload(),
      });
      return;
    }

    if (req.method === "GET" && path === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ kind: "hello", at: Date.now(), live: opts.live, paused: engine.isPaused() })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (req.method === "POST" && path === "/pause") { engine.pause(); json(res, 200, { paused: true }); return; }
    if (req.method === "POST" && path === "/resume") { engine.resume(); json(res, 200, { paused: false }); return; }

    if (req.method === "POST" && path === "/close") {
      void readBody(req).then(async (b) => {
        const id = String(b.id ?? "");
        try { const r = await engine.closeNow(id); json(res, 200, { ok: true, quoteOut: r.quoteOut.toString(), pnlPct: r.pnlPct, venue: r.venue }); }
        catch (e) { json(res, 400, { ok: false, error: (e as Error).message }); }
      });
      return;
    }

    if (req.method === "POST" && path === "/rule") {
      void readBody(req).then((b) => {
        const key = String(b.key ?? "") as EditableKey;
        const bound = EDITABLE[key];
        if (!bound) { json(res, 400, { ok: false, error: "that rule cannot be changed from here" }); return; }
        const raw = Number(b.value);
        if (!Number.isFinite(raw)) { json(res, 400, { ok: false, error: "not a number" }); return; }
        const value = Math.max(bound.min, Math.min(bound.max, Math.round(raw)));
        (engine.rules as unknown as Record<string, number>)[key] = value;
        push({ kind: "rule", at: Date.now(), key, value });
        json(res, 200, { ok: true, key, value });
      });
      return;
    }

    json(res, 404, { error: "not found" });
  });

  // a heartbeat so the page can tell a quiet chain from a dead engine
  const beat = setInterval(() => push({ kind: "pulse", at: Date.now(), paused: engine.isPaused(), spent: engine.spent().toString(), open: openPositions().length }), 10_000);

  const host = opts.host ?? "127.0.0.1";
  server.listen(opts.port, host);
  return {
    engine,
    host,
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${opts.port}`,
    close: () => { clearInterval(beat); for (const r of clients) r.end(); server.close(); engine.stop(); },
  };
}
