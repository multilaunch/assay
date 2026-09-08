import { custom, type Transport } from "viem";

/**
 * One gate in front of every JSON-RPC call.
 *
 * The free endpoints for Robinhood Chain each refuse something: publicnode answers state reads fast
 * but has no `eth_getLogs`; the official RPC serves logs but rate-limits hard, counts every element
 * of a batch array, and challenges chatty clients. So every request is a single (never batched)
 * POST, routed to the first endpoint that (a) advertises the capability the method needs and
 * (b) is not sitting in the penalty box, under a global in-flight cap and a per-endpoint minimum
 * spacing. A 429 or a rate-limit error code benches that endpoint for a while and the request
 * moves on or waits; it does not fail until the retries are spent.
 */

export type Cap = "state" | "logs";

export interface EndpointSpec {
  url: string;
  label: string;
  caps: readonly Cap[];
}

interface Endpoint extends EndpointSpec {
  capSet: Set<Cap>;
  inFlight: number;
  nextFreeAt: number;
  benchedUntil: number;
  errors: number;
  calls: number;
  rejected: number;
}

export interface GateOptions {
  maxInFlight?: number;
  spacingMs?: number;
  logsSpacingMs?: number;
  retries?: number;
  timeoutMs?: number;
  userAgent?: string;
}

const LOG_METHODS = new Set(["eth_getLogs", "eth_newFilter", "eth_getFilterLogs", "eth_getFilterChanges"]);
const capFor = (method: string): Cap => (LOG_METHODS.has(method) ? "logs" : "state");

/** Error shapes that mean "slow down", not "you are wrong". */
function isRateLimit(status: number, body: string): boolean {
  if (status === 429 || status === 403 || status === 503) return true;
  const b = body.toLowerCase();
  return b.includes("rate limit") || b.includes("too many") || b.includes("-32005") || b.includes("-32016") || b.includes("exceeded");
}

export class RpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) { super(message); }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RpcGate {
  private readonly eps: Endpoint[];
  private readonly maxInFlight: number;
  private readonly spacingMs: number;
  private readonly logsSpacingMs: number;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private inFlight = 0;
  private id = 1;
  private cooldownUntil = 0;

  constructor(specs: readonly EndpointSpec[], o: GateOptions = {}) {
    this.eps = specs.map((s) => ({ ...s, capSet: new Set(s.caps), inFlight: 0, nextFreeAt: 0, benchedUntil: 0, errors: 0, calls: 0, rejected: 0 }));
    this.maxInFlight = o.maxInFlight ?? 3;
    this.spacingMs = o.spacingMs ?? 50;
    this.logsSpacingMs = o.logsSpacingMs ?? 400;
    this.retries = o.retries ?? 6;
    this.timeoutMs = o.timeoutMs ?? 15_000;
    this.headers = { "content-type": "application/json", "user-agent": o.userAgent ?? "hoodterm/0.1" };
  }

  /** Endpoints able to serve `cap`, healthiest first. */
  private candidates(cap: Cap, now: number): Endpoint[] {
    return this.eps
      .filter((e) => e.capSet.has(cap))
      .sort((a, b) => (a.benchedUntil > now ? 1 : 0) - (b.benchedUntil > now ? 1 : 0) || a.inFlight - b.inFlight || a.errors - b.errors);
  }

  private async slot(ep: Endpoint, cap: Cap): Promise<void> {
    for (;;) {
      const now = Date.now();
      const wait = Math.max(this.cooldownUntil - now, ep.nextFreeAt - now, ep.benchedUntil - now, 0);
      if (wait === 0 && this.inFlight < this.maxInFlight) break;
      await sleep(wait > 0 ? Math.min(wait, 1000) : 10);
    }
    this.inFlight++;
    ep.inFlight++;
    ep.nextFreeAt = Date.now() + (cap === "logs" ? this.logsSpacingMs : this.spacingMs);
  }

  private release(ep: Endpoint): void {
    this.inFlight--;
    ep.inFlight--;
  }

  async request<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const cap = capFor(method);
    let lastErr: unknown = new RpcError(`no endpoint serves ${method}`);
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const now = Date.now();
      const list = this.candidates(cap, now);
      if (list.length === 0) throw new RpcError(`no endpoint advertises "${cap}" for ${method}`);
      // the healthiest un-benched endpoint; when every one is benched, the first to come back (slot() waits for it)
      const ep = list.find((e) => e.benchedUntil <= now) ?? list[0]!;
      await this.slot(ep, cap);
      const body = JSON.stringify({ jsonrpc: "2.0", id: this.id++, method, params });
      try {
        ep.calls++;
        const res = await fetch(ep.url, { method: "POST", headers: this.headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
        const text = await res.text();
        if (!res.ok || isRateLimit(res.status, text.slice(0, 400))) {
          if (isRateLimit(res.status, text)) this.bench(ep, attempt);
          lastErr = new RpcError(`${ep.label} HTTP ${res.status}: ${text.slice(0, 120)}`);
          continue;
        }
        const json = JSON.parse(text) as { result?: T; error?: { code: number; message: string; data?: unknown } };
        if (json.error) {
          const msg = `${json.error.code} ${json.error.message}`;
          if (isRateLimit(200, msg)) { this.bench(ep, attempt); lastErr = new RpcError(`${ep.label} ${msg}`, json.error.code, json.error.data); continue; }
          // a real contract/JSON-RPC error: not retryable, surface it in viem's shape
          throw Object.assign(new RpcError(json.error.message, json.error.code, json.error.data), { code: json.error.code, data: json.error.data });
        }
        ep.errors = Math.max(0, ep.errors - 1);
        return json.result as T;
      } catch (e) {
        if (e instanceof RpcError && e.code !== undefined && !isRateLimit(200, e.message)) throw e;
        ep.errors++;
        lastErr = e;
        await sleep(Math.min(2000, 100 * 2 ** attempt) + Math.random() * 100);
      } finally {
        this.release(ep);
      }
    }
    throw lastErr instanceof Error ? lastErr : new RpcError(String(lastErr));
  }

  private bench(ep: Endpoint, attempt: number): void {
    ep.rejected++;
    ep.errors++;
    const ms = Math.min(20_000, 1500 * 2 ** Math.min(attempt, 3));
    ep.benchedUntil = Date.now() + ms;
    // one rejection anywhere slows the whole process for a beat: these limits are per-IP
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + 300);
  }

  /** A viem transport that goes through this gate. */
  transport(): Transport {
    return custom({ request: ({ method, params }) => this.request(method, (params as unknown[]) ?? []) }, { retryCount: 0 });
  }

  status(): { label: string; url: string; caps: Cap[]; calls: number; rejected: number; benched: boolean }[] {
    const now = Date.now();
    return this.eps.map((e) => ({ label: e.label, url: e.url, caps: [...e.capSet], calls: e.calls, rejected: e.rejected, benched: e.benchedUntil > now }));
  }

  route(): string {
    return this.eps.map((e) => e.label).join(" → ");
  }
}

/** Parse `RPC_URL`: comma-separated, `#nologs` after an endpoint that refuses eth_getLogs. */
export function parseEndpointEnv(value: string): EndpointSpec[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s, i) => {
      const noLogs = s.endsWith("#nologs");
      const url = noLogs ? s.slice(0, -"#nologs".length) : s;
      let label = `rpc${i + 1}`;
      try { label = new URL(url).hostname.split(".").slice(0, 2).join("."); } catch { /* keep default */ }
      return { url, label, caps: noLogs ? (["state"] as const) : (["state", "logs"] as const) };
    });
}
