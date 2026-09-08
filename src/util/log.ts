/** Terminal colours with NO_COLOR and non-TTY fallbacks. Kept tiny on purpose: no dependency for this. */
const tty = process.stdout.isTTY === true || !!process.env.FORCE_COLOR;
const on = tty && !process.env.NO_COLOR;
const wrap = (open: string, close = "\x1b[0m") => (s: string) => (on ? `${open}${s}${close}` : s);

export const c = {
  dim: wrap("\x1b[2m"),
  bold: wrap("\x1b[1m"),
  white: wrap("\x1b[97m"),
  grey: wrap("\x1b[90m"),
  green: wrap("\x1b[32m"),
  yellow: wrap("\x1b[33m"),
  red: wrap("\x1b[31m"),
  cyan: wrap("\x1b[36m"),
  magenta: wrap("\x1b[35m"),
  /** Inverse video for the one word per line that must be seen. */
  badge: wrap("\x1b[7m\x1b[1m"),
  strip: (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, ""),
};

/** OSC 8 hyperlink; Ctrl/Cmd+click in iTerm2, Windows Terminal, kitty, VS Code. Plain text elsewhere. */
export function link(text: string, url: string): string {
  if (!url || !on) return text;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

export const hhmmss = (d = new Date()): string => d.toTimeString().slice(0, 8);

let quiet = false;
export const setQuiet = (q: boolean): void => { quiet = q; };

export const log = {
  info: (...a: unknown[]) => { if (!quiet) console.log(...a); },
  warn: (...a: unknown[]) => console.error(c.yellow("warn"), ...a),
  error: (...a: unknown[]) => console.error(c.red("error"), ...a),
  /** Machine-readable line for pipelines (`--json`). */
  json: (o: unknown) => console.log(JSON.stringify(o)),
};
