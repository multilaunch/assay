#!/usr/bin/env node
// Prefer the compiled build; fall back to tsx on a source checkout.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "cli", "main.js");
if (existsSync(dist)) {
  await import(dist);
} else {
  const { spawn } = await import("node:child_process");
  const p = spawn(process.execPath, ["--import", "tsx", join(here, "..", "src", "cli", "main.ts"), ...process.argv.slice(2)], { stdio: "inherit", cwd: join(here, "..") });
  p.on("exit", (code) => process.exit(code ?? 0));
}
