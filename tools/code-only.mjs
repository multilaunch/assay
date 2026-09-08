#!/usr/bin/env node
// Prints every source file with comments and blank lines stripped, so a comment-only
// edit can be proved to be one: run it before and after, diff the two outputs.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const walk = (dir) => readdirSync(dir).flatMap((e) => {
  const p = join(dir, e);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
});

/** Strips // and /* *\/ comments without touching strings, template literals or regex literals. */
function strip(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let quote = null;      // ' " ` or null
  let depth = 0;         // ${ } nesting inside a template
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (quote) {
      if (c === "\\") { out += c + (d ?? ""); i += 2; continue; }
      if (quote === "`" && c === "$" && d === "{") { depth++; out += "${"; i += 2; continue; }
      if (quote === "`" && c === "}" && depth > 0) { depth--; out += c; i++; continue; }
      if (c === quote && depth === 0) quote = null;
      out += c; i++; continue;
    }
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

for (const f of walk("src").sort()) {
  const body = strip(readFileSync(f, "utf8")).split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  console.log(`===== ${f}`);
  for (const l of body) console.log(l);
}
