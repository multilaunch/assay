import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEther, parseUnits, type Address } from "viem";
import { ZERO } from "../src/chain/config.js";
import { decide, entryQuoteFor, rulesFromEnv, type EngineRules } from "../src/engine/rules.js";
import type { CurveState } from "../src/pons/curve.js";
import type { LaunchIntel, PairInfo } from "../src/pons/enrich.js";

/** Reasons are codes now, so tests name the rule instead of quoting its English. */
const has = (ns: readonly { code: string }[], code: string): boolean => ns.some((n) => n.code === code);
const codes = (ns: readonly { code: string }[]): string => ns.map((n) => n.code).join(", ");


const A = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;
const SUPPLY = 1_000_000_000n * 10n ** 18n;
const USDG: PairInfo = { address: A(5), symbol: "USDG", decimals: 6, native: false };
const STOCK: PairInfo = { address: A(6), symbol: "NVDAx", decimals: 18, native: false };

const curve: CurveState = {
  quoteReserve: 1_680n * 10n ** 18n, tokenReserve: SUPPLY, realQuoteReserve: 0n, phantomQuote: 1_680n * 10n ** 18n,
  sellableTokens: (SUPPLY * 7143n) / 10_000n, reservedTokens: (SUPPLY * 2857n) / 10_000n, graduationThreshold: 42n * 10n ** 17n,
  feeBps: 100n, creatorTaxBps: 100n, openingTaxBps: 0n, graduated: false, readyToGraduate: false, launchedAt: 1, readAtMs: 0,
};

function intel(pair: PairInfo): LaunchIntel {
  return {
    ev: { token: A(9), curve: A(8), deployer: A(1), pairToken: pair.address, launchConfigId: 0n, graduationThreshold: 0n, blockNumber: 1n, txHash: "0x00", logIndex: 0, seenAtMs: 0 },
    meta: { name: "Test", symbol: "TST", logo: "", description: "d", socials: { twitter: "https://x.com/t", telegram: "", discord: "", website: "", farcaster: "" } },
    record: { deployer: A(1), creatorFeeRecipient: A(1), pairToken: pair.address, graduationThreshold: 0n, poolFee: 3000, tickSpacing: 60, creatorTaxBps: 100n, buybackEnabled: false, phase: "NotGraduated", exists: true },
    curve,
    pair,
    tx: { from: A(1), devBuy: 10n ** 16n, devTokens: (SUPPLY * 300n) / 10_000n, exemptions: [], recipient: A(1), timestamp: 1, via: "router" },
    errors: [],
  };
}

const GOOD = { total: 80, verdict: "FIRE" as const, reasons: [], flags: [] };
const ctx = { openCount: 0, farmTwins: 0, spent: 0n };
const rules = (over: Partial<EngineRules> = {}) => rulesFromEnv({ ethPairsOnly: false, entryQuote: parseEther("0.01"), sessionBudget: parseEther("0.05"), ...over });

test("--allow-pairs still refuses a pair whose decimals are not 18", () => {
  // entryQuote is parseEther, so 0.01 against a 6-decimal stable is ten billion units of it
  const d = decide(intel(USDG), GOOD, rules(), ctx);
  assert.equal(d.fire, false);
  assert.ok(has(d.why, "gate_pair_decimals"), codes(d.why));
  assert.equal(d.why.find((w) => w.code === "gate_pair_decimals")!.vars!.symbol, "USDG");
});

test("an explicit size for that pair lifts the refusal and is what gets spent", () => {
  const r = rules({ entryQuoteByPair: new Map([[USDG.address.toLowerCase(), parseUnits("25", 6)]]) });
  assert.equal(decide(intel(USDG), GOOD, r, ctx).fire, true);
  assert.equal(entryQuoteFor(r, USDG), 25_000_000n);
  // a pair with no size of its own falls back to the ETH-denominated entry, which is why the gate
  // above only lets 18-decimal assets through unsized
  assert.equal(entryQuoteFor(r, STOCK), parseEther("0.01"));
});

test("an 18-decimal pair passes the decimals gate, and the ETH pair is untouched", () => {
  assert.equal(decide(intel(STOCK), GOOD, rules(), ctx).fire, true);
  assert.equal(decide(intel({ address: ZERO as Address, symbol: "ETH", decimals: 18, native: true }), GOOD, rules({ ethPairsOnly: true }), ctx).fire, true);
});

test("SLIPPAGE_BPS is clamped where the rules are built, not where the buy runs", () => {
  process.env.SLIPPAGE_BPS = "2.5";
  try { assert.equal(rulesFromEnv().slippageBps, 3); } finally { delete process.env.SLIPPAGE_BPS; }
  process.env.SLIPPAGE_BPS = "-100";
  try { assert.equal(rulesFromEnv().slippageBps, 0); } finally { delete process.env.SLIPPAGE_BPS; }
});
