import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { render, renderReason, TEXT } from "../src/score/notes.js";

/**
 * Pulls every code the scorer and the gates actually emit out of their own source.
 *
 * Reading the source is blunt, but the failure it catches is real and silent: add a rule, forget
 * its wording, and the board prints `dev_band` at a reader instead of a sentence. Nothing else
 * would notice.
 */
function emittedCodes(): string[] {
  const src = ["src/score/score.ts", "src/engine/rules.ts", "src/engine/engine.ts"].map((f) => readFileSync(f, "utf8")).join("\n");
  const out = new Set<string>();
  for (const m of src.matchAll(/\badd\(\s*-?\d+\s*,\s*"([a-z0-9_]+)"/g)) out.add(m[1]!);
  for (const m of src.matchAll(/\bnote\(\s*"([a-z0-9_]+)"/g)) out.add(m[1]!);
  // the one code chosen at runtime rather than written as a literal argument
  for (const m of src.matchAll(/\bnote\(live \? "([a-z0-9_]+)" : "([a-z0-9_]+)"\)/g)) { out.add(m[1]!); out.add(m[2]!); }
  return [...out].sort();
}

test("every reason the code can emit has English to show for it", () => {
  const codes = emittedCodes();
  assert.ok(codes.length > 30, `expected to find the rules, found ${codes.length}`);
  const missing = codes.filter((c) => TEXT[c] === undefined);
  assert.deepEqual(missing, [], `no wording for: ${missing.join(", ")}`);
});

test("no wording is left behind for a rule that no longer exists", () => {
  const codes = new Set(emittedCodes());
  const orphans = Object.keys(TEXT).filter((c) => !codes.has(c));
  assert.deepEqual(orphans, [], `wording with no rule: ${orphans.join(", ")}`);
});

test("a code nobody wrote wording for renders as itself, not as nothing", () => {
  assert.equal(render({ code: "not_a_real_code" }), "not_a_real_code");
});

test("the terminal still gets its sign in front of the points", () => {
  assert.equal(renderReason({ code: "dev_band", points: 15, vars: { pct: "3.20" } }), "+15 opening buy 3.20%, inside the 1–6% band");
  assert.equal(renderReason({ code: "dev_none", points: -10 }), "-10 no opening buy, nothing at stake");
});

/**
 * The board renders the same codes out of its own dictionary. A code with wording in the terminal
 * and none on the page is the exact gap this refactor existed to close, and it is invisible until
 * somebody switches to Russian and reads `dev_band` where a sentence should be.
 */
function boardDict(lang: "en" | "ru"): Set<string> {
  const html = readFileSync("src/board/index.html", "utf8");
  const block = new RegExp(`\\n  ${lang}: \\{(.*?)\\n  \\},`, "s").exec(html);
  assert.ok(block, `no ${lang} dictionary in the board`);
  return new Set([...block[1]!.matchAll(/^\s*(rc_[a-z0-9_]+)\s*:/gm)].map((m) => m[1]!));
}

for (const lang of ["en", "ru"] as const) {
  test(`the board has ${lang} wording for every reason the code can emit`, () => {
    const dict = boardDict(lang);
    const missing = emittedCodes().filter((c) => !dict.has(`rc_${c}`));
    assert.deepEqual(missing, [], `no ${lang} wording for: ${missing.join(", ")}`);
  });
}

test("the two board dictionaries agree on which reasons exist", () => {
  const en = [...boardDict("en")].sort();
  const ru = [...boardDict("ru")].sort();
  assert.deepEqual(en, ru);
});

test("every board reason carries the placeholders its wording needs", () => {
  const html = readFileSync("src/board/index.html", "utf8");
  for (const lang of ["en", "ru"] as const) {
    const block = new RegExp(`\\n  ${lang}: \\{(.*?)\\n  \\},`, "s").exec(html)![1]!;
    for (const m of block.matchAll(/^\s*rc_([a-z0-9_]+)\s*:\s*"(.*?)",$/gm)) {
      const [, code, text] = m as unknown as [string, string, string];
      const en = TEXT[code];
      if (typeof en !== "function") continue;
      // the English renderer names every variable it uses; the translation must name the same ones
      const wanted = [...String(en({ pct: "{pct}", n: "{n}", perSide: "{perSide}", graduated: "{graduated}", prior: "{prior}", sec: "{sec}", address: "{address}", symbol: "{symbol}", decimals: "{decimals}", detail: "{detail}", have: "{have}", max: "{max}", spent: "{spent}", budget: "{budget}", twins: "{twins}", score: "{score}", min: "{min}", pattern: "{pattern}" })).matchAll(/\{(\w+)\}/g)].map((x) => x[1]!);
      for (const v of wanted) assert.ok(text.includes(`{${v}}`), `${lang} rc_${code} never uses {${v}}`);
    }
  }
});
