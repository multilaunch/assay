import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string | Buffer, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

/**
 * One operator, one password, a session cookie.
 *
 * The board is two things at once now: a page anyone may read, and a handful of verbs that move
 * money. Only the second half needs a gate, and it needs a real one rather than a shared secret in
 * a proxy config — this is the door in front of a process holding a private key.
 *
 * No dependency does the work here. scrypt and timingSafeEqual ship with Node, and a session is a
 * random token in memory. Sessions die with the process, which is the behaviour you want: a restart
 * after a crash should not leave someone logged in.
 */

/** Deliberately slow. The whole cost of a guess is here. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const KEYLEN = 32;

/** `scrypt$N$r$p$salt$hash`, all base64url. Self-describing so the parameters can be raised later. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(plain.normalize("NFKC"), salt, KEYLEN, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/**
 * Constant-time against the stored hash.
 *
 * A malformed or empty stored hash is a refusal, never an accident that lets everyone in: an
 * operator who forgets to set the password gets a board nobody can drive, which is the safe way to
 * be wrong.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const N = Number(n), R = Number(r), P = Number(p);
  if (!Number.isInteger(N) || !Number.isInteger(R) || !Number.isInteger(P) || N < 2 || N > 2 ** 20) return false;

  let salt: Buffer;
  let want: Buffer;
  try {
    salt = Buffer.from(saltB64, "base64url");
    want = Buffer.from(hashB64, "base64url");
  } catch { return false; }
  if (salt.length === 0 || want.length !== KEYLEN) return false;

  const got = await scrypt(plain.normalize("NFKC"), salt, KEYLEN, { N, r: R, p: P, maxmem: SCRYPT.maxmem }).catch(() => null);
  return got !== null && timingSafeEqual(got, want);
}

export interface SessionOptions {
  /** how long a session lives without being used */
  ttlMs?: number;
  /** most sessions alive at once; the oldest goes when a new one would exceed it */
  max?: number;
}

/**
 * Session tokens, in memory.
 *
 * `verify` slides the expiry forward, so a session in use stays alive and one left alone dies. The
 * cap exists so a login loop cannot grow the map without bound.
 */
export class Sessions {
  private readonly live = new Map<string, number>();
  private readonly ttl: number;
  private readonly max: number;

  constructor(opts: SessionOptions = {}) {
    this.ttl = opts.ttlMs ?? 12 * 60 * 60 * 1000;
    this.max = opts.max ?? 32;
  }

  create(now = Date.now()): string {
    this.sweep(now);
    if (this.live.size >= this.max) {
      const oldest = [...this.live.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) this.live.delete(oldest[0]);
    }
    const token = randomBytes(32).toString("base64url");
    this.live.set(token, now + this.ttl);
    return token;
  }

  verify(token: string | undefined, now = Date.now()): boolean {
    if (!token) return false;
    const expires = this.live.get(token);
    if (expires === undefined) return false;
    if (expires <= now) { this.live.delete(token); return false; }
    this.live.set(token, now + this.ttl);
    return true;
  }

  destroy(token: string | undefined): void {
    if (token) this.live.delete(token);
  }

  count(now = Date.now()): number {
    this.sweep(now);
    return this.live.size;
  }

  private sweep(now: number): void {
    for (const [t, expires] of this.live) if (expires <= now) this.live.delete(t);
  }
}

/**
 * Slows a guessing loop down without ever locking the real operator out for good.
 *
 * The delay doubles per failure and is capped, so a script gets minutes per attempt while someone
 * who mistyped their own password waits seconds. Keyed by source address; a successful login
 * clears the counter.
 */
export class LoginThrottle {
  private readonly fails = new Map<string, { n: number; until: number }>();

  constructor(private readonly baseMs = 1_000, private readonly capMs = 5 * 60_000) {}

  /** Milliseconds still to wait, or 0 when an attempt is allowed now. */
  retryAfter(key: string, now = Date.now()): number {
    const f = this.fails.get(key);
    return f && f.until > now ? f.until - now : 0;
  }

  fail(key: string, now = Date.now()): void {
    const f = this.fails.get(key) ?? { n: 0, until: 0 };
    f.n += 1;
    f.until = now + Math.min(this.capMs, this.baseMs * 2 ** (f.n - 1));
    this.fails.set(key, f);
    if (this.fails.size > 1_000) for (const [k, v] of this.fails) if (v.until <= now) this.fails.delete(k);
  }

  succeed(key: string): void {
    this.fails.delete(key);
  }
}

/** The value of one cookie, or undefined. Does not decode; the token is base64url already. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * The Set-Cookie for a session.
 *
 * `Secure` is decided by how the request arrived rather than hardcoded: behind Caddy it is always
 * https and the flag belongs there, but over an SSH tunnel the page is plain http on loopback and a
 * Secure cookie would be silently dropped, locking the operator out of their own board.
 */
export function sessionCookie(token: string, opts: { secure: boolean; maxAgeSec: number }): string {
  const bits = [`assay_session=${token}`, "HttpOnly", "SameSite=Strict", "Path=/", `Max-Age=${opts.maxAgeSec}`];
  if (opts.secure) bits.push("Secure");
  return bits.join("; ");
}

export const clearCookie = (secure: boolean): string =>
  sessionCookie("", { secure, maxAgeSec: 0 });
