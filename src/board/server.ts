import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isAddress, type Address } from "viem";
import { clearCookie, LoginThrottle, readCookie, sessionCookie, Sessions, verifyPassword } from "./auth.js";
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
import { holdersFor } from "./holders.js";
import { logoFor } from "./logo.js";
import { buyQuote } from "./quote.js";
import { factoryAbi } from "../abi/pons.js";
import { MATURE_MS, lift, report, thinFor, wilsonLower } from "../track/accuracy.js";
import { all } from "../track/journal.js";

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

/**
 * The stored password hash, or "" when the operator never set one.
 *
 * Empty means the controls are unreachable from the page at all. That is the right default: a board
 * put on a public box before anyone thought about a password should be a board nobody can drive.
 */
const adminHash = (): string => (process.env.BOARD_ADMIN_PASSWORD_HASH ?? "").trim();

/** Behind a proxy the client is on https even though the hop to us is not. Caddy sets this. */
const isSecure = (req: IncomingMessage): boolean =>
  (req.headers["x-forwarded-proto"] ?? "").toString().split(",")[0]?.trim() === "https";

/** Who to throttle. The proxy's own address would throttle everyone at once, so prefer the header. */
const clientKey = (req: IncomingMessage): string =>
  (req.headers["x-forwarded-for"] ?? "").toString().split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";

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

/** Read once: it never changes while the process runs, and a crawler should not cost a disk read. */
let ogCache: Buffer | null | undefined;
function ogImage(): Buffer | null {
  if (ogCache !== undefined) return ogCache;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, "og.png"), join(here, "..", "..", "src", "board", "og.png")]) {
    try { return (ogCache = readFileSync(p)); } catch { /* try the next one */ }
  }
  return (ogCache = null);
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
    farmKey: e.farmKey,
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

/**
 * The evidence, for the page.
 *
 * Everything the terminal knows about whether its own score has ever been right lives in the
 * journal, and until now only the CLI could see it. The page shows a feed like every other scanner
 * shows a feed; what it did not show was the one thing a stranger cannot check anywhere else.
 *
 * The floor is the claim. A rate on its own is a number anyone can produce by picking a lucky
 * window, so every rate here travels with the sample it came from and with the Wilson lower bound
 * that sample actually supports — and the panel only says the score works when that bound clears
 * the base rate.
 */
interface StatsBucket {
  verdict: string;
  judged: number;
  graduated: number;
  rate: number;
  pending: number;
  /** the 95% lower bound on `rate`; the rate this sample actually supports */
  floor: number;
  /** rate ÷ base, or null when the bucket is empty */
  lift: number | null;
}

interface Stats {
  total: number;
  judged: number;
  pending: number;
  base: number;
  /** judged launches a 2x lift would need before it could be told apart from luck; null when undefinable */
  need: number | null;
  matureHours: number;
  from: number | null;
  to: number | null;
  buckets: StatsBucket[];
  /**
   * What holding would have been worth, which the graduation rate alone flatters. Rows with no
   * trades at all were never a trade anyone could have taken; rows with a peak had an entry.
   */
  priced: { total: number; neverTraded: number; withEntry: number; doubled: number };
  updatedAt: number;
}

/** A payload the page can render without special-casing: a fresh install has an empty journal. */
const emptyStats = (): Stats => ({
  total: 0, judged: 0, pending: 0, base: 0, need: null, matureHours: MATURE_MS / 3_600_000,
  from: null, to: null, buckets: [],
  priced: { total: 0, neverTraded: 0, withEntry: 0, doubled: 0 },
  updatedAt: Date.now(),
});

async function computeStats(): Promise<Stats> {
  const rows = await all();
  if (rows.length === 0) return emptyStats();
  const rep = await report(rows);
  const overall = rep.buckets.find((b) => b.verdict === "all");
  const need = thinFor(rep.base, overall?.judged ?? 0);
  const priced = rows.filter((e) => e.trades !== undefined);
  return {
    total: rep.total,
    judged: rep.total - rep.pending,
    pending: rep.pending,
    base: rep.base,
    need: Number.isFinite(need) ? Math.ceil(need) : null,
    matureHours: MATURE_MS / 3_600_000,
    from: rep.from,
    to: rep.to,
    buckets: rep.buckets.map((b) => ({
      verdict: b.verdict, judged: b.judged, graduated: b.graduated, rate: b.rate, pending: b.pending,
      floor: wilsonLower(b.graduated, b.judged), lift: lift(b, rep.base),
    })),
    priced: {
      total: priced.length,
      neverTraded: priced.filter((e) => e.trades === 0).length,
      withEntry: priced.filter((e) => e.peakX !== undefined).length,
      doubled: priced.filter((e) => (e.peakX ?? 0) >= 2).length,
    },
    updatedAt: Date.now(),
  };
}

/**
 * The journal is tens of thousands of lines and it only changes when a launch is scored or an
 * outcome is resolved, so reading it per request — let alone on the event stream — would be a
 * self-inflicted stall. Read it once, hold the answer for a few minutes, and let one reader in at
 * a time so a page refresh storm cannot start ten parallel scans of the same file.
 */
const STATS_TTL_MS = 5 * 60 * 1000;
let statsAt = 0;
let statsBody: Stats = emptyStats();
let statsRun: Promise<Stats> | null = null;

function stats(now = Date.now()): Promise<Stats> {
  if (statsAt && now - statsAt < STATS_TTL_MS) return Promise.resolve(statsBody);
  if (statsRun) return statsRun;
  statsRun = computeStats()
    .catch(() => emptyStats())   // an unreadable journal is not a reason for the board to fail
    .then((s) => { statsBody = s; statsAt = Date.now(); statsRun = null; return s; });
  return statsRun;
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
  /**
   * Subscribers, each remembering whether it signed in.
   *
   * The stream carries two kinds of frame: what the chain is doing, which anyone may watch, and
   * what this wallet is doing, which is nobody else's business. A subscriber's rights are fixed
   * when it connects — a session that expires mid-stream keeps its open stream until it reconnects,
   * which is the usual trade for not re-authenticating every frame.
   */
  const clients = new Set<{ res: ServerResponse; admin: boolean }>();

  /** Frames that describe this operator rather than the chain. */
  const isPrivate = (kind: unknown): boolean => kind === "positions" || kind === "pulse" || kind === "mark" || kind === "exit" || kind === "fire" || kind === "swept";
  const recent: Record<string, unknown>[] = [];

  // The opening-tax window is a protocol parameter the owner can change, so it is read rather than
  // assumed. Until the read lands the page falls back to what the factory shipped with.
  let taxSeconds = 3;
  let taxStartBps = 9900;
  void Promise.all([
    client.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "snipeTaxSeconds" }),
    client.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "snipeTaxStartBps" }),
  ]).then(([sec, bps]) => { taxSeconds = Number(sec); taxStartBps = Number(bps); }).catch(() => undefined);

  // Warm the journal read now rather than making the first visitor wait on it.
  void stats().catch(() => undefined);

  const push = (data: Record<string, unknown>) => {
    if (data.kind === "launch" || data.kind === "fire" || data.kind === "exit") {
      recent.push(data);
      if (recent.length > 120) recent.shift();
    }
    const frame = `data: ${JSON.stringify(data)}\n\n`;
    const priv = isPrivate(data.kind);
    for (const c of clients) {
      if (priv && !c.admin) continue;
      try { c.res.write(frame); } catch { clients.delete(c); }
    }
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
  const sessions = new Sessions();
  const throttle = new LoginThrottle();
  const SESSION_SEC = 12 * 60 * 60;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    // HEAD is a GET that keeps its mouth shut. Crawlers and health checks use it, and without this
    // every route here answered them with a 404, which is a confusing thing to tell a link preview.
    const head = req.method === "HEAD";
    if (head) { const end = res.end.bind(res); (res as unknown as { end: () => void }).end = () => { end(); }; }
    const method = head ? "GET" : req.method;

    const refused = guard(req, hosts);
    if (refused) { json(res, 403, { error: refused }); return; }
    const admin = sessions.verify(readCookie(req.headers.cookie, "assay_session"));

    // Login is the one POST an anonymous caller may make. Everything else that writes needs a
    // session, and read-only refuses even a signed-in operator.
    if (method === "POST" && path === "/admin/login") {
      const wait = throttle.retryAfter(clientKey(req));
      if (wait > 0) { json(res, 429, { error: `too many attempts, wait ${Math.ceil(wait / 1000)} s` }); return; }
      const hash = adminHash();
      void readBody(req).then(async (b) => {
        const ok = hash !== "" && (await verifyPassword(String(b.password ?? ""), hash));
        if (!ok) {
          throttle.fail(clientKey(req));
          // The same answer whether the password was wrong or never configured: which of the two
          // it is tells an attacker something and tells the operator nothing they cannot read in
          // their own logs.
          json(res, 401, { error: "wrong password" });
          return;
        }
        throttle.succeed(clientKey(req));
        res.setHeader("set-cookie", sessionCookie(sessions.create(), { secure: isSecure(req), maxAgeSec: SESSION_SEC }));
        json(res, 200, { admin: true });
      });
      return;
    }

    if (method === "POST" && path === "/admin/logout") {
      sessions.destroy(readCookie(req.headers.cookie, "assay_session"));
      res.setHeader("set-cookie", clearCookie(isSecure(req)));
      json(res, 200, { admin: false });
      return;
    }

    if (method === "POST") {
      if (!admin) { json(res, 401, { error: "sign in first" }); return; }
      if (frozen) { json(res, 403, { error: "this board is read only" }); return; }
    }

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(HTML());
      return;
    }

    if (method === "GET" && path === "/state") {
      // The feed and the parameters of the protocol are public; what this wallet is holding is not.
      // A page anyone can open should not publish its operator's positions and P&L.
      json(res, 200, {
        live: opts.live, paused: engine.isPaused(), readOnly: frozen, taxSeconds, taxStartBps,
        // `recent` is the replay buffer, and it holds entries and exits alongside launches. Anyone
        // may see what the chain did; only the operator may see what this wallet did about it.
        recent: admin ? recent : recent.filter((e) => e.kind === "launch"),
        admin, canSignIn: adminHash() !== "",
        ...(admin
          ? {
              spent: engine.spent().toString(),
              rules: Object.fromEntries(Object.keys(EDITABLE).map((k) => [k, engine.rules[k as EditableKey]])),
              bounds: EDITABLE,
              positions: positionsPayload(),
            }
          : {}),
      });
      return;
    }

    // GET only, and behind `guard` like everything else. Nothing here writes, so there is no verb
    // to fence off; a POST simply falls through to the 404 at the bottom.
    // A read that prices a buy and hands back the bytes for it. GET on purpose: it changes nothing
    // here, and the only thing it can do to the caller is quote them a trade their own wallet then
    // refuses or signs. Public, because the whole point is that a visitor needs no account.
    if (method === "GET" && path === "/quote") {
      void buyQuote({
        token: url.searchParams.get("token") ?? "",
        buyer: url.searchParams.get("buyer") ?? "",
        quoteIn: url.searchParams.get("wei") ?? "0",
        ...(url.searchParams.has("slippageBps") ? { slippageBps: Number(url.searchParams.get("slippageBps")) } : {}),
      }).then(
        (r) => (r.ok ? json(res, 200, r.quote) : json(res, 400, { error: r.error })),
        () => json(res, 502, { error: "the chain would not answer just now" }),
      );
      return;
    }

    // What is behind a "farm x8" badge: the fingerprint spelled out, and every launch still in the
    // window that shares it. In memory and thirty minutes wide, so it answers for this session only.
    if (method === "GET" && path === "/farm") {
      const key = url.searchParams.get("key") ?? "";
      if (!key) { json(res, 400, { error: "which fingerprint?" }); return; }
      json(res, 200, engine.farmCohort(key));
      return;
    }

    // The link preview. A crawler reaches this with no session and no Origin, which the guard
    // already allows for a GET; it is the one asset a stranger fetches before ever seeing the page.
    if (method === "GET" && path === "/og.png") {
      const png = ogImage();
      if (!png) { json(res, 404, { error: "no preview image" }); return; }
      res.writeHead(200, { "content-type": "image/png", "content-length": png.length, "cache-control": "public, max-age=86400" });
      res.end(png);
      return;
    }

    // The token's picture, fetched by us. See logo.ts for why the reader's browser must not.
    if (method === "GET" && path === "/logo") {
      void logoFor(url.searchParams.get("token") ?? "").then(
        (l) => {
          if (!l) { json(res, 404, { error: "no image" }); return; }
          res.writeHead(200, { "content-type": l.type, "content-length": l.body.length, "cache-control": "public, max-age=1800" });
          res.end(l.body);
        },
        () => json(res, 404, { error: "no image" }),
      );
      return;
    }

    // Who holds it now, as opposed to who bought at launch. See holders.ts for why those differ.
    if (method === "GET" && path === "/holders") {
      const tok = url.searchParams.get("token") ?? "";
      if (!isAddress(tok, { strict: false })) { json(res, 400, { error: "that is not a token address" }); return; }
      void holdersFor(tok as Address).then(
        (h) => (h ? json(res, 200, h) : json(res, 404, { error: "the factory has no record of that token" })),
        () => json(res, 502, { error: "the chain would not answer just now" }),
      );
      return;
    }

    if (method === "GET" && path === "/stats") {
      void stats().then((s) => json(res, 200, s)).catch(() => json(res, 200, emptyStats()));
      return;
    }

    if (method === "GET" && path === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ kind: "hello", at: Date.now(), live: opts.live, paused: engine.isPaused() })}\n\n`);
      const sub = { res, admin };
      clients.add(sub);
      req.on("close", () => clients.delete(sub));
      return;
    }

    if (method === "POST" && path === "/pause") { engine.pause(); json(res, 200, { paused: true }); return; }
    if (method === "POST" && path === "/resume") { engine.resume(); json(res, 200, { paused: false }); return; }

    if (method === "POST" && path === "/close") {
      void readBody(req).then(async (b) => {
        const id = String(b.id ?? "");
        try { const r = await engine.closeNow(id); json(res, 200, { ok: true, quoteOut: r.quoteOut.toString(), pnlPct: r.pnlPct, venue: r.venue }); }
        catch (e) { json(res, 400, { ok: false, error: (e as Error).message }); }
      });
      return;
    }

    if (method === "POST" && path === "/rule") {
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
    close: () => { clearInterval(beat); for (const c of clients) c.res.end(); server.close(); engine.stop(); },
  };
}
