import { lookup } from "node:dns/promises";
import { isAddress, type Address } from "viem";
import { tokenAbi } from "../abi/pons.js";
import { client } from "../chain/clients.js";

/**
 * Token images, fetched by us and never by the reader's browser.
 *
 * Every launch carries a logo URL, and the launcher chooses the host. A sample of 24 consecutive
 * launches pointed at six different ones — j7m.io, img.koyen.fun, unavatar.io, m.rapidlaunch.io,
 * pinata, and raw ipfs. Letting the page load those directly would hand the address of everyone
 * watching to a server the launcher controls, seconds after they launched, which is a good way to
 * learn who is about to buy your token. It would also mean opening `img-src` to the whole web.
 *
 * So the board fetches them. The reader talks only to the board.
 *
 * The URL is attacker-controlled, which makes this a request-forgery surface and not a convenience
 * feature: a logo of `http://127.0.0.1:4663/state` or `http://169.254.169.254/…` would otherwise
 * have the board read its own loopback, or its host's cloud metadata, and hand back the bytes. The
 * defences, in order: the token address comes from the caller but the URL never does; only http(s);
 * the hostname is resolved and refused if it lands anywhere private; redirects are not followed;
 * the response has to say it is an image; and it is capped in both bytes and seconds.
 */

/**
 * Real launches carry real photographs. 512 KB looked generous until a sample turned up a 2 MB JPEG
 * for what the page renders at 24 pixels, so the ceiling is what the chain actually contains rather
 * than what it ought to. Nothing here resizes — that needs a decoder, and the board ships three
 * dependencies — so the page asks for these lazily and the cache is bounded in bytes rather than in
 * entries, which is the number that would otherwise run away.
 */
const MAX_BYTES = 2 * 1024 * 1024;
const CACHE_BUDGET = 48 * 1024 * 1024;
const TIMEOUT_MS = 5_000;
const TTL_MS = 30 * 60_000;

/**
 * ipfs:// has no host of its own, so it needs one we choose rather than one the launcher does.
 *
 * Several, raced: the public gateways are free and behave like it. Measured against live launches,
 * pinata alone timed out often enough to leave real launches without a picture, and a CID that one
 * gateway is slow to serve another usually has already.
 */
const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
];

/** Who we are. Some hosts refuse an unidentified fetch, and lying about being a browser is not the fix. */
const UA = "assay/0.1 (+https://github.com/multilaunch/assay)";

export interface Logo { body: Buffer; type: string }

type Entry = { at: number; logo: Logo | null };
const cache = new Map<string, Entry>();

/** RFC1918, loopback, link-local, CGNAT, and the v6 equivalents. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;   // link-local, and the cloud metadata address
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;                  // multicast and reserved
    return false;
  }
  const s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  if (s === "::1" || s === "::" || s === "") return true;
  if (s.startsWith("fe80") || s.startsWith("fc") || s.startsWith("fd")) return true;
  // ::ffff:127.0.0.1 and friends
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  return mapped ? isPrivateAddress(mapped[1]!) : false;
}

/** The URL a logo field points at, or null when it is not something we will fetch. */
export function resolveLogoUrl(raw: string): string[] {
  const s = (raw ?? "").trim();
  if (!s) return [];
  if (s.startsWith("ipfs://")) {
    const cid = s.slice(7).replace(/^ipfs\//, "");
    // no traversal: the path is appended to a gateway URL, and ".." in it climbs out of /ipfs/
    if (cid.split("/").some((seg) => seg === "." || seg === "..")) return [];
    if (!/^[a-zA-Z0-9._-]{10,120}(\/[\w.-]{1,80}){0,4}$/.test(cid)) return [];
    return IPFS_GATEWAYS.map((g) => g + cid);
  }
  let u: URL;
  try { u = new URL(s); } catch { return []; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return [];
  return [u.href];
}

async function hostIsPublic(host: string): Promise<boolean> {
  const bare = host.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(bare) || bare.includes(":")) return !isPrivateAddress(bare);
  try {
    const all = await lookup(bare, { all: true });
    return all.length > 0 && all.every((a) => !isPrivateAddress(a.address));
  } catch { return false; }
}

async function fetchLogo(url: string): Promise<Logo | null> {
  if (!(await hostIsPublic(new URL(url).host))) return null;
  const stop = AbortSignal.timeout(TIMEOUT_MS);
  // `redirect: manual` matters: a public host is free to bounce us at 127.0.0.1, and following
  // that would undo the check above.
  const res = await fetch(url, { redirect: "manual", signal: stop, headers: { accept: "image/*", "user-agent": UA } }).catch(() => null);
  if (!res || !res.ok) return null;

  const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!type.startsWith("image/") || type.includes("svg")) return null; // svg is a script container
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) return null;

  const buf = Buffer.from(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (buf.length === 0 || buf.length > MAX_BYTES) return null;
  return { body: buf, type };
}

/**
 * The image for one token, or null.
 *
 * Negative results are cached too: a launch whose logo host is down should cost one attempt per
 * half hour, not one per reader who scrolls past it.
 */
function evict(): void {
  let held = 0;
  for (const e of cache.values()) held += e.logo?.body.length ?? 0;
  if (held <= CACHE_BUDGET) return;
  for (const [k, e] of [...cache].sort((a, b) => a[1].at - b[1].at)) {
    cache.delete(k);
    held -= e.logo?.body.length ?? 0;
    if (held <= CACHE_BUDGET) return;
  }
}

export async function logoFor(token: string): Promise<Logo | null> {
  if (!isAddress(token, { strict: false })) return null;
  const key = token.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.logo;

  let logo: Logo | null = null;
  try {
    const info = await client.readContract({ address: token as Address, abi: tokenAbi, functionName: "getTokenInfo" });
    const urls = resolveLogoUrl((info as readonly [Address, string, string, unknown])[1] ?? "");
    // first one that answers with an image wins; a slow gateway should not cost the whole picture
    for (const u of urls) {
      logo = await fetchLogo(u);
      if (logo) break;
    }
  } catch { /* a launch we cannot read has no picture, which is not an error worth surfacing */ }

  cache.set(key, { at: Date.now(), logo });
  evict();
  return logo;
}
