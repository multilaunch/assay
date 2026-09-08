import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { factoryAbi } from "../src/abi/pons.js";
import type { CurveState } from "../src/pons/curve.js";
import { decodeLaunchCall, type LaunchIntel, type LaunchTx, type TokenMeta } from "../src/pons/enrich.js";
import { scoreLaunch } from "../src/score/score.js";

const A = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;
const SUPPLY = 1_000_000_000n * 10n ** 18n;

/** A good launch that is not perfect: X only, short description, so the base score has headroom below 100. */
function meta(over: Partial<TokenMeta> = {}): TokenMeta {
  return { name: "Test", symbol: "TST", logo: "", description: "short", socials: { twitter: "https://x.com/t", telegram: "", discord: "", website: "", farcaster: "" }, ...over };
}
function curve(over: Partial<CurveState> = {}): CurveState {
  return { quoteReserve: 1_680n * 10n ** 18n, tokenReserve: SUPPLY, realQuoteReserve: 0n, phantomQuote: 1_680n * 10n ** 18n, sellableTokens: (SUPPLY * 7143n) / 10_000n, reservedTokens: (SUPPLY * 2857n) / 10_000n, graduationThreshold: 42n * 10n ** 17n, feeBps: 100n, creatorTaxBps: 100n, openingTaxBps: 0n, graduated: false, readyToGraduate: false, launchedAt: 1, readAtMs: 0, ...over };
}
function tx(devPct: number, exemptions = 0, over: Partial<LaunchTx> = {}): LaunchTx {
  const devTokens = (SUPPLY * BigInt(Math.round(devPct * 100))) / 10_000n;
  return { from: A(1), devBuy: devTokens > 0n ? 10n ** 16n : 0n, devTokens, exemptions: Array.from({ length: exemptions }, (_, i) => A(100 + i)), recipient: A(1), timestamp: 1, via: "router", ...over };
}
function intel(over: Partial<LaunchIntel> = {}): LaunchIntel {
  return {
    ev: { token: A(9), curve: A(8), deployer: A(1), pairToken: A(0), launchConfigId: 0n, graduationThreshold: 0n, blockNumber: 1n, txHash: "0x00", logIndex: 0, seenAtMs: 0 },
    meta: meta(), record: { deployer: A(1), creatorFeeRecipient: A(1), pairToken: A(0), graduationThreshold: 0n, poolFee: 0, tickSpacing: 0, creatorTaxBps: 100n, buybackEnabled: false, phase: "NotGraduated", exists: true },
    curve: curve(), pair: { address: A(0), symbol: "ETH", decimals: 18, native: true }, tx: tx(3), errors: [], ...over,
  };
}

test("a builder-shaped launch is a FIRE and every point has a reason", () => {
  const s = scoreLaunch(intel(), { deployer: { prior: 0, graduated: 0 } });
  assert.equal(s.verdict, "FIRE");
  assert.ok(s.total >= 75, String(s.total));
  assert.ok(s.reasons.some((r) => r.includes("1–6% band")));
  assert.ok(s.reasons.every((r) => /^[+-]\d+ /.test(r)));
});

test("a serial deployer with no socials and no opening buy is a SKIP", () => {
  const s = scoreLaunch(intel({ meta: meta({ description: "", socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" } }), tx: tx(0) }), { deployer: { prior: 40, graduated: 0 } });
  assert.equal(s.verdict, "SKIP");
  assert.ok(s.reasons.some((r) => r.includes("serial deployer")));
  assert.ok(s.reasons.some((r) => r.includes("no socials")));
});

test("four exempt wallets is a declared bundle and costs 20", () => {
  const clean = scoreLaunch(intel()).total;
  const bundled = scoreLaunch(intel({ tx: tx(3, 4) })).total;
  assert.equal(clean - bundled, 25); // +5 for none → −20 for four
});

test("an opening buy over 10 % costs 25 and a tax over 5 % another 25", () => {
  const base = scoreLaunch(intel()).total;
  const heavy = scoreLaunch(intel({ tx: tx(12) })).total;
  assert.equal(base - heavy, 40); // +15 → −25
  const greedy = scoreLaunch(intel({ record: { ...intel().record!, creatorTaxBps: 600n } })).total;
  assert.equal(base - greedy, 35); // +10 → −25
});

test("a launch farm twin is punished; a third twin is punished hard", () => {
  const base = scoreLaunch(intel()).total;
  assert.equal(base - scoreLaunch(intel(), { farmTwins: 1 }).total, 8);
  assert.equal(base - scoreLaunch(intel(), { farmTwins: 2 }).total, 25);
});

test("fees to a third party is a small plus and a flag; a non-ETH pair is only a flag", () => {
  const s = scoreLaunch(intel({ record: { ...intel().record!, creatorFeeRecipient: A(77) } }));
  assert.ok(s.reasons.some((r) => r.includes("third party")));
  assert.ok(s.flags.some((f) => f.includes("fee recipient")));
  const usd = scoreLaunch(intel({ pair: { address: A(5), symbol: "USDG", decimals: 6, native: false } }));
  assert.equal(usd.total, scoreLaunch(intel()).total);
  assert.ok(usd.flags.some((f) => f.includes("USDG")));
});

test("follow-up activity: distinct buyers help, all-early buys hurt", () => {
  const base = scoreLaunch(intel()).total;
  const organic = scoreLaunch(intel(), { activity: { buys: 12, sells: 1, uniqueBuyers: 11, quoteIn: 0n, quoteOut: 0n, earlyBuys: 2 }, ageSec: 60 }).total;
  assert.equal(organic - base, 10);
  const bots = scoreLaunch(intel(), { activity: { buys: 5, sells: 0, uniqueBuyers: 5, quoteIn: 0n, quoteOut: 0n, earlyBuys: 5 }, ageSec: 15 }).total;
  assert.equal(bots - base, 5 - 10);
});

test("an unreadable launch still scores without throwing", () => {
  const s = scoreLaunch(intel({ meta: null, record: null, curve: null, tx: null, errors: ["call 0: timeout"] }));
  assert.ok(s.total >= 0 && s.total <= 100);
  assert.ok(s.flags.some((f) => f.includes("failed")));
});

test("a launch whose transaction could not be read never outscores one that was read", () => {
  // regression: seen live on 2026-09-08, $ADSTOCKS scored FIRE 81 with "opening buy ?" because the
  // rules that punish a heavy opening buy and a declared bundle were skipped, not failed.
  const readable = scoreLaunch(intel(), { deployer: { prior: 0, graduated: 0 } });
  const unreadable = scoreLaunch(intel({ tx: null }), { deployer: { prior: 0, graduated: 0 } });
  assert.ok(unreadable.total < readable.total, `${unreadable.total} should be under ${readable.total}`);
  assert.notEqual(unreadable.verdict, "FIRE");
  assert.ok(unreadable.reasons.some((r) => r.includes("unreadable")));

  // and the worst readable launch still has to be able to beat nothing-known, or the penalty is too big
  const bad = scoreLaunch(intel({ tx: tx(40, 6) }), { deployer: { prior: 0, graduated: 0 } });
  assert.ok(bad.total < unreadable.total, "a 40% opening buy with six exempt wallets is worse than unknown");
});

test("a missing factory record and a missing curve are each their own penalty", () => {
  const base = scoreLaunch(intel()).total;
  assert.equal(base - scoreLaunch(intel({ record: null })).total, 15 + 10); // -15 unknown, and +10 for the 1% tax is gone
  assert.equal(base - scoreLaunch(intel({ curve: null })).total, 10);
});

test("a launchTokenFor launch with ten exempt wallets is not read as the cleanest possible shape", () => {
  // regression: launchTokenFor was missing from SELECTOR, the decode fell through to via "unknown" with
  // an empty list, and the bundle collected +5 for "no wallets exempt from the opening tax". Same class
  // of hole as $ADSTOCKS above: missing data must never read as good news.
  const b32 = `0x${"0".repeat(64)}` as Hex;
  const params = {
    name: "Test", symbol: "TST", logo: "", description: "",
    socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
    creatorFeeRecipient: A(1), creatorTaxBps: 100, buybackEnabled: false, expectedEconomics: b32, salt: b32,
  } as const;
  const ten = Array.from({ length: 10 }, (_, i) => A(200 + i));
  const call = decodeLaunchCall(encodeFunctionData({ abi: factoryAbi, functionName: "launchTokenFor", args: [params, 0n, A(0), A(2), ten] }));

  const s = scoreLaunch(intel({ tx: tx(3, 0, { via: call.via, exemptions: call.exemptions }) }), { deployer: { prior: 0, graduated: 0 } });
  assert.ok(s.reasons.some((r) => r.includes("10 wallets exempt")), s.reasons.join(" | "));
  assert.ok(!s.reasons.some((r) => r.includes("no wallets exempt")));
  assert.notEqual(s.verdict, "FIRE");
});

test("an entrypoint the decoder does not recognise costs points instead of earning them", () => {
  const clean = scoreLaunch(intel(), { deployer: { prior: 0, graduated: 0 } });
  const opaque = scoreLaunch(intel({ tx: tx(3, 0, { via: "unknown" }) }), { deployer: { prior: 0, graduated: 0 } });
  assert.ok(opaque.total < clean.total, `${opaque.total} should be under ${clean.total}`);
  assert.ok(opaque.reasons.some((r) => r.includes("unrecognised launch entrypoint")));
  assert.ok(!opaque.reasons.some((r) => r.includes("no wallets exempt")), "an unread list is not an empty one");

  // and a bundle we can actually see is still worse than one we could not read, or the penalty is too big
  const seen = scoreLaunch(intel({ tx: tx(3, 4) }), { deployer: { prior: 0, graduated: 0 } });
  assert.ok(seen.total < opaque.total, "four declared exempt wallets is worse than an entrypoint we cannot name");
});
