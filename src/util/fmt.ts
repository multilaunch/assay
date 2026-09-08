import { formatUnits } from "viem";

/** 0.0123 ETH style: trims to what a human reads, never scientific notation. */
export function amount(wei: bigint, decimals = 18, maxFrac = 4): string {
  const s = formatUnits(wei, decimals);
  const [i, f = ""] = s.split(".");
  const frac = f.slice(0, maxFrac).replace(/0+$/, "");
  return frac ? `${i}.${frac}` : i ?? "0";
}

export const eth = (wei: bigint): string => amount(wei, 18, 4);

/** 150 → "1.5%" */
export const pct = (bps: bigint | number, digits = 2): string => {
  const n = Number(bps) / 100;
  return `${Number.isInteger(n) ? n : n.toFixed(digits).replace(/\.?0+$/, "")}%`;
};

export const short = (addr: string, head = 6, tail = 4): string =>
  addr.length > head + tail + 2 ? `${addr.slice(0, head)}…${addr.slice(-tail)}` : addr;

/** 1234567 → "1.23M", 12345 → "12.3K" */
export function compact(n: number, digits = 2): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(digits)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(digits)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(a < 10 ? 2 : 0);
}

export const usd = (n: number): string => (n >= 1000 ? `$${compact(n)}` : `$${n.toFixed(2)}`);

export const padR = (s: string, w: number): string => (s.length >= w ? s : s + " ".repeat(w - s.length));
export const padL = (s: string, w: number): string => (s.length >= w ? s : " ".repeat(w - s.length) + s);

/** ▓▓▓░░░░ progress bar, `width` cells. */
export function bar(p: number, width = 20): string {
  const n = Math.max(0, Math.min(width, Math.round(p * width)));
  return "▓".repeat(n) + "░".repeat(width - n);
}

export const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
};
