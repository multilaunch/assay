import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal .env loader. KEY=VALUE, `#` comments, optional single or double quotes, no interpolation.
 * A value already in process.env always wins, so CI and shells can override the file.
 */
export function loadEnv(file = resolve(process.cwd(), ".env")): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    const q = val[0];
    if ((q === '"' || q === "'") && val.endsWith(q) && val.length >= 2) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export function envStr(key: string, fallback = ""): string {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

export function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key]?.trim().toLowerCase();
  if (v === undefined || v === "") return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
