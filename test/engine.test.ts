import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEther, type Address } from "viem";
import { decide, rulesFromEnv, type EngineRules } from "../src/engine/rules.js";
import type { CurveState } from "../src/pons/curve.js";
import type { LaunchIntel, LaunchTx, TokenMeta } from "../src/pons/enrich.js";
import { exitReason, pnlPct } from "../src/trade/positions.js";
import { poolId, poolKeyFor, sellIsZeroForOne } from "../src/trade/v4.js";
import { PONS, ZERO } from "../src/chain/config.js";

const A = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;
const SUPPLY = 1_000_000_000n * 10n ** 18n;

function curve(over: Partial<CurveState> = {}): CurveState {
  return { quoteReserve: 1_680n * 10n ** 18n, tokenReserve: SUPPLY, realQuoteReserve: 0n, phantomQuote: 1_680n * 10n ** 18n, sellableTokens: (SUPPLY * 7143n) / 10_000n, reservedTokens: (SUPPLY * 2857n) / 10_000n, graduationThreshold: 42n * 10n ** 17n, feeBps: 100n, creatorTaxBps: 100n, openingTaxBps: 0n, graduated: false, readyToGraduate: false, launchedAt: 1, readAtMs: 0, ...over };
}
function tx(devPct: number, exemptions = 0): LaunchTx {
  return { from: A(1), devBuy: 10n ** 16n, devTokens: (SUPPLY * BigInt(Math.round(devPct * 100))) / 10_000n, exemptions: Array.from({ length: exemptions }, (_, i) => A(100 + i)), recipient: A(1), timestamp: 1, via: "router" };
}
function meta(over: Partial<TokenMeta> = {}): TokenMeta {
  return { name: "Test", symbol: "TST", logo: "", description: "d", socials: { twitter: "https://x.com/t", telegram: "", discord: "", website: "", farcaster: "" }, ...over };
}
function intel(over: Partial<LaunchIntel> = {}): LaunchIntel {
  return {
    ev: { token: A(9), curve: A(8), deployer: A(1), pairToken: ZERO as Address, launchConfigId: 0n, graduationThreshold: 0n, blockNumber: 1n, txHash: "0x00", logIndex: 0, seenAtMs: 0 },
    meta: meta(),
    record: { deployer: A(1), creatorFeeRecipient: A(1), pairToken: ZERO as Address, graduationThreshold: 0n, poolFee: 3000, tickSpacing: 60, creatorTaxBps: 100n, buybackEnabled: false, phase: "NotGraduated", exists: true },
    curve: curve(), pair: { address: ZERO as Address, symbol: "ETH", decimals: 18, native: true }, tx: tx(3), errors: [], ...over,
  };
}
const GOOD = { total: 80, verdict: "FIRE" as const, reasons: [], flags: [] };
const rules = (over: Partial<EngineRules> = {}) => rulesFromEnv({ minScore: 60, maxOpenPositions: 3, sessionBudget: parseEther("0.05"), entryQuote: parseEther("0.01"), ...over });
const ctx = { openCount: 0, farmTwins: 0, spent: 0n };

test("a clean ETH launch above the score fires", () => {
  const d = decide(intel(), GOOD, rules(), ctx);
  assert.equal(d.fire, true, d.why.join("; "));
});

test("every gate refuses by name", () => {
  const cases: [string, ReturnType<typeof decide>][] = [
    ["score", decide(intel(), { ...GOOD, total: 10 }, rules(), ctx)],
    ["pair is", decide(intel({ pair: { address: A(5), symbol: "USDG", decimals: 6, native: false } }), GOOD, rules(), ctx)],
    ["opening buy", decide(intel({ tx: tx(30) }), GOOD, rules(), ctx)],
    ["exempt wallets", decide(intel({ tx: tx(3, 6) }), GOOD, rules(), ctx)],
    ["creator tax", decide(intel({ record: { ...intel().record!, creatorTaxBps: 900n } }), GOOD, rules(), ctx)],
    ["no socials", decide(intel({ meta: meta({ socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" } }) }), GOOD, rules(), ctx)],
    ["open positions", decide(intel(), GOOD, rules(), { ...ctx, openCount: 3 })],
    ["session budget", decide(intel(), GOOD, rules(), { ...ctx, spent: parseEther("0.05") })],
    ["launch farm", decide(intel(), GOOD, rules(), { ...ctx, farmTwins: 4 })],
    ["curve already closed", decide(intel({ curve: curve({ readyToGraduate: true }) }), GOOD, rules(), ctx)],
  ];
  for (const [needle, d] of cases) {
    assert.equal(d.fire, false, `expected a refusal mentioning "${needle}"`);
    assert.ok(d.why.some((w) => w.includes(needle)), `"${needle}" not in: ${d.why.join("; ")}`);
  }
});

test("an unreadable launch transaction is a refusal, not a silent pass", () => {
  const d = decide(intel({ tx: null }), GOOD, rules(), ctx);
  assert.equal(d.fire, false);
  assert.ok(d.why.some((w) => w.includes("unreadable")));
});

test("a launch nothing could be read about says so instead of listing rules", () => {
  const d = decide(intel({ meta: null, record: null, curve: null, tx: null, errors: ["timeout"] }), GOOD, rules(), ctx);
  assert.equal(d.fire, false);
  assert.equal(d.why.length, 1);
  assert.ok(d.why[0]!.startsWith("unreadable:"));
});

test("--keyword and --deployer narrow the feed", () => {
  assert.equal(decide(intel(), GOOD, rules({ keyword: /grok|claude/i }), ctx).fire, false);
  assert.equal(decide(intel({ meta: meta({ description: "a grok thing" }) }), GOOD, rules({ keyword: /grok/i }), ctx).fire, true);
  assert.equal(decide(intel(), GOOD, rules({ deployers: new Set([A(77).toLowerCase()]) }), ctx).fire, false);
  assert.equal(decide(intel(), GOOD, rules({ deployers: new Set([A(1).toLowerCase()]) }), ctx).fire, true);
});

test("the session budget stops the last entry that would cross it, not the one that lands on it", () => {
  const r = rules({ sessionBudget: parseEther("0.05"), entryQuote: parseEther("0.01") });
  assert.equal(decide(intel(), GOOD, r, { ...ctx, spent: parseEther("0.04") }).fire, true);
  assert.equal(decide(intel(), GOOD, r, { ...ctx, spent: parseEther("0.041") }).fire, false);
});

// ---- exits ---------------------------------------------------------------------------------------

const exits = { takeProfitPct: 80, stopLossPct: 35, trailingPct: 25, maxHoldMin: 45 };
const pos = (entry: bigint, peak: bigint, openedAt: number) => ({ entryQuote: entry.toString(), peakQuote: peak.toString(), openedAt });

test("take profit, stop loss, trailing and max hold each fire on their own", () => {
  const now = 1_000_000;
  const e = 10n ** 18n;
  assert.match(exitReason(pos(e, e, now), (e * 181n) / 100n, exits, now)!, /take profit/);
  assert.match(exitReason(pos(e, e, now), (e * 60n) / 100n, exits, now)!, /stop loss/);
  assert.match(exitReason(pos(e, e * 2n, now), (e * 140n) / 100n, exits, now)!, /trailing/);
  assert.match(exitReason(pos(e, e, now - 46 * 60), e, exits, now)!, /max hold/);
  assert.equal(exitReason(pos(e, e, now), e, exits, now), null);
});

test("the trailing stop only arms once the position has been above the entry", () => {
  const now = 1_000_000;
  const e = 10n ** 18n;
  // peak never exceeded entry: a 30 % drop is the stop loss, never the trailing stop
  assert.match(exitReason(pos(e, e, now), (e * 70n) / 100n, exits, now) ?? "", /^$|stop loss/);
  assert.equal(exitReason(pos(e, e, now), (e * 80n) / 100n, exits, now), null);
});

test("pnl is measured against the entry, in the pair's own units", () => {
  assert.equal(pnlPct({ entryQuote: (10n ** 18n).toString() }, (10n ** 18n * 3n) / 2n), 50);
  assert.equal(pnlPct({ entryQuote: "0" }, 5n), 0);
});

// ---- v4 pool keys ---------------------------------------------------------------------------------

test("native ETH is always currency0 and the pool id is stable", () => {
  const token = A(0xabc);
  const key = poolKeyFor(token, { pairToken: ZERO as Address, poolFee: 3000, tickSpacing: 60 });
  assert.equal(key.currency0, ZERO);
  assert.equal(key.currency1, token);
  assert.equal(key.hooks, PONS.hook);
  assert.equal(sellIsZeroForOne(key, token), false); // selling the token is currency1 → currency0
  const id = poolId(key);
  assert.match(id, /^0x[0-9a-f]{64}$/);
  assert.equal(poolId(poolKeyFor(token, { pairToken: ZERO as Address, poolFee: 3000, tickSpacing: 60 })), id);
});

test("an ERC-20 pair sorts by address", () => {
  const low = A(0x11), high = A(0xff);
  const k1 = poolKeyFor(high, { pairToken: low, poolFee: 500, tickSpacing: 10 });
  assert.equal(k1.currency0, low);
  assert.equal(k1.currency1, high);
  const k2 = poolKeyFor(low, { pairToken: high, poolFee: 500, tickSpacing: 10 });
  assert.equal(k2.currency0, low);
  assert.equal(poolId(k1), poolId(k2), "the same pair must produce the same pool id whichever side is the token");
});
