import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Sentence embeddings, used for one job: spotting the launch farm that changes its wording.
 *
 * The structural fingerprint in pons/farm.ts catches the operator who reuses the same numbers —
 * same opening buy, same tax, same link pattern. It cannot see the one who ships "Pons Prime",
 * "PonsMax" and "Pons v2 Official" from three wallets with three descriptions saying the same
 * thing. That is what this is for, and it is the only thing it is for. No text this returns ever
 * becomes a number in the score directly; it produces a twin count, the same shape the structural
 * detector already produces, so it can be measured against the journal like any other rule.
 *
 * Off unless OPENLUX_API_KEY is set. Everything upstream has to work without it.
 */

const CACHE_VERSION = 1;

export interface EmbedConfig {
  key: string;
  baseUrl: string;
  model: string;
}

export function embedConfig(): EmbedConfig | null {
  const key = process.env.OPENLUX_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  if (!key) return null;
  return {
    key,
    baseUrl: (process.env.OPENLUX_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openlux.ai/v1").replace(/\/+$/, ""),
    model: process.env.EMBED_MODEL ?? "text-embedding-3-small",
  };
}

const cachePath = (): string => resolve(process.env.HOODTERM_DATA ?? resolve(process.cwd(), "data"), "embeddings.json");

type Cache = { version: number; model: string; vectors: Record<string, number[]> };

function loadCache(model: string): Cache {
  const f = cachePath();
  if (!existsSync(f)) return { version: CACHE_VERSION, model, vectors: {} };
  try {
    const c = JSON.parse(readFileSync(f, "utf8")) as Cache;
    // a different model means different geometry; mixing the two would compare nonsense
    if (c.version !== CACHE_VERSION || c.model !== model) return { version: CACHE_VERSION, model, vectors: {} };
    return c;
  } catch {
    return { version: CACHE_VERSION, model, vectors: {} };
  }
}

function saveCache(c: Cache): void {
  const f = cachePath();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(c));
}

const keyOf = (text: string): string => createHash("sha1").update(text).digest("hex").slice(0, 20);

async function post(cfg: EmbedConfig, input: string[]): Promise<number[][]> {
  const res = await fetch(`${cfg.baseUrl}/embeddings`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: cfg.model, input }),
  });
  if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const body = (await res.json()) as { data: { index: number; embedding: number[] }[] };
  const out: number[][] = new Array(input.length);
  // the API is allowed to reorder; index is the only thing that maps a vector back to its text
  for (const d of body.data) out[d.index] = d.embedding;
  if (out.some((v) => !v)) throw new Error("embeddings response was missing a vector");
  return out;
}

export interface EmbedResult {
  vectors: (number[] | null)[];
  fromCache: number;
  fetched: number;
  failed: number;
}

/**
 * Embeds `texts`, in batches, reusing anything already on disk.
 *
 * A batch that fails leaves nulls rather than throwing: a farm report with one cluster missing is
 * worth more than no report, and the caller is told how many are missing.
 */
export async function embed(texts: string[], batchSize = 128): Promise<EmbedResult> {
  const cfg = embedConfig();
  if (!cfg) return { vectors: texts.map(() => null), fromCache: 0, fetched: 0, failed: 0 };

  const cache = loadCache(cfg.model);
  const vectors: (number[] | null)[] = texts.map((t) => cache.vectors[keyOf(t)] ?? null);
  let fromCache = vectors.filter((v) => v !== null).length;
  let fetched = 0;
  let failed = 0;

  const todo = texts.map((t, i) => [t, i] as const).filter(([, i]) => vectors[i] === null);
  // an empty string has no meaning to embed and would waste a slot in every batch
  const real = todo.filter(([t]) => t.trim() !== "");
  failed += todo.length - real.length;

  for (let i = 0; i < real.length; i += batchSize) {
    const slice = real.slice(i, i + batchSize);
    try {
      const got = await post(cfg, slice.map(([t]) => t));
      slice.forEach(([t, idx], k) => {
        const v = got[k]!;
        vectors[idx] = v;
        cache.vectors[keyOf(t)] = v;
      });
      fetched += slice.length;
    } catch {
      failed += slice.length;
    }
  }

  if (fetched > 0) saveCache(cache);
  return { vectors, fromCache, fetched, failed };
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Single-link clustering at `threshold`.
 *
 * Single-link on purpose: a farm is a chain, not a ball. The operator drifts the wording a little
 * each time, so the first and the twentieth token can sit far apart while every neighbouring pair
 * is close. Requiring everything in a cluster to resemble everything else would cut that chain in
 * the middle and report two farms where there is one.
 */
export function cluster(vectors: (number[] | null)[], threshold = 0.86): number[][] {
  const n = vectors.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[x] !== r) { const next = parent[x]!; parent[x] = r; x = next; }
    return r;
  };
  const union = (a: number, b: number) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb; };

  for (let i = 0; i < n; i++) {
    const vi = vectors[i];
    if (!vi) continue;
    for (let j = i + 1; j < n; j++) {
      const vj = vectors[j];
      if (!vj) continue;
      if (cosine(vi, vj) >= threshold) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (!vectors[i]) continue;
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}
