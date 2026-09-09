import { createInterface } from "node:readline/promises";
import { formatEther } from "viem";
import { client } from "../chain/clients.js";
import { EXPLORER } from "../chain/config.js";
import { eth } from "../util/fmt.js";
import { c } from "../util/log.js";
import { getAccount } from "../trade/wallet.js";
import type { EngineRules } from "./rules.js";

/**
 * The four walls around a live session.
 *
 *   1. this confirmation, which prints the signer, its balance and every limit, and waits for `arm`
 *   2. the entry size    — what one buy costs
 *   3. the position cap  — how many entries can be open at once
 *   4. the session budget — the total that entries may consume, after which nothing fires
 *
 * A wallet funded with only the budget cannot lose more than the budget. All four are denominated
 * in ETH, which is why a session that may buy other pair assets cannot be armed at all.
 */
export async function confirmLive(rules: EngineRules): Promise<boolean> {
  const acct = getAccount();
  if (!acct) throw new Error("live mode needs PRIVATE_KEY in .env");

  // Everything printed below measures ETH: the entry size, the budget, and the balance they are
  // checked against. A non-ETH pair spends an ERC-20 this wallet may not even hold, so an ETH
  // balance here would be reassurance about the wrong asset.
  if (!rules.ethPairsOnly) {
    console.log("");
    console.log(c.red("  --allow-pairs cannot be armed: the entry size and the session budget are ETH, and a non-ETH pair is bought with its own asset. Refusing."));
    console.log(c.grey("  drop --allow-pairs to run live, or keep it and stay in dry run."));
    return false;
  }

  const balance = await client.getBalance({ address: acct.address });

  console.log("");
  console.log(c.badge(" LIVE "), c.bold("this will sign and send real transactions"));
  console.log(`  signer          ${acct.address}`);
  console.log(`  balance         ${eth(balance)} ETH   ${c.grey(EXPLORER.address(acct.address))}`);
  console.log(`  entry size      ${eth(rules.entryQuote)} ETH per buy`);
  console.log(`  position cap    ${rules.maxOpenPositions} open at once`);
  console.log(`  session budget  ${eth(rules.sessionBudget)} ETH total, then nothing fires`);
  console.log(`  exits           TP +${rules.exits.takeProfitPct}%  SL −${rules.exits.stopLossPct}%  trail ${rules.exits.trailingPct}%  hold ${rules.exits.maxHoldMin} min`);
  console.log(`  min score       ${rules.minScore}   opening-tax ceiling ${rules.maxOpeningTaxBps / 100}%`);

  if (balance < rules.entryQuote) {
    console.log(c.red(`\n  balance does not cover one entry (${eth(rules.entryQuote)} ETH). Refusing.`));
    return false;
  }
  if (balance > rules.sessionBudget * 4n) {
    console.log(c.yellow(`\n  note: this wallet holds far more than the session budget. A fresh wallet funded with only the budget is the safer way to run this.`));
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`\n  type ${c.bold("arm")} to start, anything else to abort: `)).trim();
  rl.close();
  if (answer !== "arm") { console.log(c.grey("  aborted")); return false; }
  console.log(c.green("  armed\n"));
  return true;
}

