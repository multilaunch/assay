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
