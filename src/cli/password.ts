import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { hashPassword } from "../board/auth.js";
import { c, log } from "../util/log.js";

/** Everything on stdin, for `echo secret | assay password`. */
async function readPiped(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8").split("\n")[0] ?? "";
}

export function registerPasswordCommand(program: Command): void {
  program
    .command("password")
    .description("hash a board password, for BOARD_ADMIN_PASSWORD_HASH")
    .action(async () => {
      let pw: string;
      if (process.stdin.isTTY) {
        // Asked for rather than taken as an argument: an argument lands in shell history and in
        // the process list, where anyone else on the box can read it.
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        pw = await rl.question("new board password: ");
        const again = await rl.question("again: ");
        rl.close();
        if (pw !== again) { log.error("they do not match"); process.exitCode = 2; return; }
      } else {
        pw = await readPiped();
      }

      if (pw.length < 12) { log.error("use at least 12 characters; this is the door in front of a wallet"); process.exitCode = 2; return; }

      // stdout is the hash and nothing else, so it can be piped straight into a config. The advice
      // goes to stderr for the same reason: log.info writes to stdout and would end up in the file.
      console.log(await hashPassword(pw));
      process.stderr.write(c.grey("put that in BOARD_ADMIN_PASSWORD_HASH. the password itself is stored nowhere.\n"));
    });
}
