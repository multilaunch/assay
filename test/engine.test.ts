import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEther, type Address } from "viem";
import { claimOnce, serialized, SessionSpend } from "../src/engine/engine.js";
import { decide, type EngineRules } from "../src/engine/rules.js";
import type { CurveState } from "../src/pons/curve.js";
import type { LaunchIntel, LaunchTx, TokenMeta } from "../src/pons/enrich.js";
import { exitReason, pnlPct } from "../src/trade/positions.js";
import { poolId, poolKeyFor, sellIsZeroForOne } from "../src/trade/v4.js";
import { PONS, ZERO } from "../src/chain/config.js";

/** Reasons are codes now, so tests name the rule instead of quoting its English. */
const has = (ns: readonly { code: string }[], code: string): boolean => ns.some((n) => n.code === code);
const codes = (ns: readonly { code: string }[]): string => ns.map((n) => n.code).join(", ");


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
const exits = { takeProfitPct: 80, stopLossPct: 35, trailingPct: 25, maxHoldMin: 45 };

// Spelled out rather than built by rulesFromEnv: that reads process.env, .env has already been
// loaded by an import, and a developer with MAX_EXEMPT_WALLETS=8 in theirs would otherwise change
// what these tests assert.
const BASE: EngineRules = {
  entryQuote: parseEther("0.01"), slippageBps: 300, maxOpeningTaxBps: 300, maxWaitMs: 12_000,
  minScore: 60, maxDevSharePct: 8, maxCreatorTaxBps: 300, requireSocials: true, maxExemptWallets: 2,
  ethPairsOnly: true, entryQuoteByPair: new Map(), keyword: null, deployers: new Set(), maxOpenPositions: 3, maxFarmTwins: 1,
  sessionBudget: parseEther("0.05"), exits,
};
const rules = (over: Partial<EngineRules> = {}): EngineRules => ({ ...BASE, ...over });
const ctx = { openCount: 0, farmTwins: 0, spent: 0n };

test("a clean ETH launch above the score fires", () => {
  const d = decide(intel(), GOOD, rules(), ctx);
  assert.equal(d.fire, true, codes(d.why));
});

test("every gate refuses by name", () => {
  const cases: [string, ReturnType<typeof decide>][] = [
    ["gate_score", decide(intel(), { ...GOOD, total: 10 }, rules(), ctx)],
    ["gate_pair_not_eth", decide(intel({ pair: { address: A(5), symbol: "USDG", decimals: 6, native: false } }), GOOD, rules(), ctx)],
    ["gate_dev", decide(intel({ tx: tx(30) }), GOOD, rules(), ctx)],
    ["gate_exempt", decide(intel({ tx: tx(3, 6) }), GOOD, rules(), ctx)],
    ["gate_tax", decide(intel({ record: { ...intel().record!, creatorTaxBps: 900n } }), GOOD, rules(), ctx)],
    ["gate_no_socials", decide(intel({ meta: meta({ socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" } }) }), GOOD, rules(), ctx)],
    ["gate_open_positions", decide(intel(), GOOD, rules(), { ...ctx, openCount: 3 })],
    ["gate_budget", decide(intel(), GOOD, rules(), { ...ctx, spent: parseEther("0.05") })],
    ["gate_farm", decide(intel(), GOOD, rules(), { ...ctx, farmTwins: 4 })],
    ["gate_curve_closed", decide(intel({ curve: curve({ readyToGraduate: true }) }), GOOD, rules(), ctx)],
  ];
  for (const [needle, d] of cases) {
    assert.equal(d.fire, false, `expected a refusal mentioning "${needle}"`);
    assert.ok(has(d.why, needle), `"${needle}" not in: ${codes(d.why)}`);
  }
});

test("an unreadable launch transaction is a refusal, not a silent pass", () => {
  const d = decide(intel({ tx: null }), GOOD, rules(), ctx);
  assert.equal(d.fire, false);
  assert.ok(has(d.why, "gate_tx_unreadable"));
});

test("a launch nothing could be read about says so instead of listing rules", () => {
  const d = decide(intel({ meta: null, record: null, curve: null, tx: null, errors: ["timeout"] }), GOOD, rules(), ctx);
  assert.equal(d.fire, false);
  assert.equal(d.why.length, 1);
  assert.equal(d.why[0]!.code, "no_data");
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
  // 30 % down is past the 25 % trailing band, but the peak never got above the entry, so nothing
  // fires: the trailing stop is not a second and tighter stop loss.
  assert.equal(exitReason(pos(e, e, now), (e * 70n) / 100n, exits, now), null);
  assert.equal(exitReason(pos(e, e, now), (e * 80n) / 100n, exits, now), null);
  // the same 30 % drop measured from a peak above the entry is the trailing stop
  assert.equal(exitReason(pos(e, (e * 3n) / 2n, now), (e * 105n) / 100n, exits, now), "trailing stop 30.0% below the peak");
  // and 40 % down from an entry that never rose is the stop loss, named as such
  assert.equal(exitReason(pos(e, e, now), (e * 60n) / 100n, exits, now), "stop loss -40.0%");
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

// ---- overlapping passes and the budget --------------------------------------------------------

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a position stays claimed for the whole sell, so two overlapping passes cannot sell it twice", async () => {
  const closing = new Set<string>();
  let sells = 0;
  const sell = async () => { sells++; await tick(20); return "sold"; };
  const both = await Promise.all([claimOnce(closing, "p1", sell), claimOnce(closing, "p1", sell)]);
  assert.equal(sells, 1);
  assert.deepEqual(both, ["sold", null]);
  assert.equal(closing.size, 0, "the claim is given back when the sell finishes");
  assert.equal(await claimOnce(closing, "p1", sell), "sold", "and the position can be closed later");
});

test("a manage pass that outlives its own tick is skipped, not overlapped", async () => {
  let inside = 0;
  let passes = 0;
  const pass = serialized(async () => {
    passes++;
    inside++;
    assert.equal(inside, 1, "two passes ran at once");
    await tick(20);
    inside--;
  });
  await Promise.all([pass(), pass(), pass()]);
  assert.equal(passes, 1);
  await pass();
  assert.equal(passes, 2, "the guard clears once the slow pass is done");
});

test("the session budget is reserved when the launch clears the gates, not when its buy lands", async () => {
  const spend = new SessionSpend();
  const r = rules({ sessionBudget: parseEther("0.01"), entryQuote: parseEther("0.01") });
  let bought = 0;
  // the shape of onLaunch: gate, reserve, then up to twelve seconds of tax wait and a receipt
  const launch = async () => {
    if (!decide(intel(), GOOD, r, { ...ctx, spent: spend.total() }).fire) return;
    spend.reserve(r.entryQuote);
    await tick(10);
    bought++;
  };
  await Promise.all([launch(), launch(), launch(), launch()]);
  assert.equal(bought, 1, "four launches inside one wait window spent four times the budget");
  assert.equal(spend.total(), parseEther("0.01"));
});

test("a launch that never buys hands its reservation back, once", () => {
  const spend = new SessionSpend();
  const release = spend.reserve(parseEther("0.01"));
  assert.equal(spend.total(), parseEther("0.01"));
  release();
  assert.equal(spend.total(), 0n);
  release();
  assert.equal(spend.total(), 0n, "a second release must not hand the budget back twice");
});
