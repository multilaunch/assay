import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { factoryAbi, routerAbi } from "../src/abi/pons.js";
import { ZERO } from "../src/chain/config.js";
import type { CurveState } from "../src/pons/curve.js";
import { decodeLaunchCall, isComplete, mergeIntel, type LaunchIntel } from "../src/pons/enrich.js";

const A = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;
const EV = { token: A(9), curve: A(8), deployer: A(1), pairToken: ZERO as Address, launchConfigId: 0n, graduationThreshold: 0n, blockNumber: 1n, txHash: "0x00" as `0x${string}`, logIndex: 0, seenAtMs: 0 };
const curve = (real: bigint): CurveState => ({ quoteReserve: 1n, tokenReserve: 1n, realQuoteReserve: real, phantomQuote: 0n, sellableTokens: 0n, reservedTokens: 0n, graduationThreshold: 1n, feeBps: 100n, creatorTaxBps: 0n, openingTaxBps: 0n, graduated: false, readyToGraduate: false, launchedAt: 1, readAtMs: 0 });
const UNKNOWN_PAIR = { address: ZERO as Address, symbol: "?", decimals: 18, native: true };
const ETH_PAIR = { address: ZERO as Address, symbol: "ETH", decimals: 18, native: true };
const META = { name: "T", symbol: "T", logo: "", description: "", socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" } };
const TX = { from: A(1), devBuy: 1n, devTokens: 1n, exemptions: [], recipient: A(1), timestamp: 1, via: "router" as const };

const empty: LaunchIntel = { ev: EV, meta: null, record: null, curve: null, pair: UNKNOWN_PAIR, tx: null, errors: ["not found"] };
const full: LaunchIntel = { ev: EV, meta: META, record: null, curve: curve(5n), pair: ETH_PAIR, tx: TX, errors: [] };

test("isComplete wants metadata, a curve and the launch transaction", () => {
  assert.equal(isComplete(empty), false);
  assert.equal(isComplete(full), true); // a missing factory record is survivable; these three are not
  assert.equal(isComplete({ ...empty, meta: META, curve: curve(1n), tx: TX }), true);
});

test("a retry fills in what the first read could not see", () => {
  // this is the live failure: the websocket beat the RPC to the block, so nothing was readable
  const merged = mergeIntel(empty, full);
  assert.equal(merged.meta, META);
  assert.equal(merged.tx, TX);
  assert.equal(merged.pair.symbol, "ETH", "an unknown pair must be replaced by the one that resolved");
  assert.deepEqual(merged.errors, [], "the surviving errors are the last attempt's, not the first's");
});

test("the curve takes the newest read because it moves; the rest keeps the first", () => {
  const first: LaunchIntel = { ...full, curve: curve(1n) };
  const later: LaunchIntel = { ...full, meta: { ...META, name: "changed" }, curve: curve(9n) };
  const merged = mergeIntel(first, later);
  assert.equal(merged.curve?.realQuoteReserve, 9n);
  assert.equal(merged.meta?.name, "T", "immutable metadata keeps the first value that arrived");
});

test("a retry that also failed leaves the earlier data intact", () => {
  const merged = mergeIntel(full, empty);
  assert.equal(merged.meta, META);
  assert.equal(merged.tx, TX);
  assert.equal(merged.curve?.realQuoteReserve, 5n);
  assert.equal(merged.pair.symbol, "ETH");
});

const B32 = `0x${"0".repeat(64)}` as Hex;
const PARAMS = {
  name: "Test", symbol: "TST", logo: "", description: "",
  socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
  creatorFeeRecipient: A(1), creatorTaxBps: 100, buybackEnabled: false, expectedEconomics: B32, salt: B32,
} as const;
const bundle = (n: number): Address[] => Array.from({ length: n }, (_, i) => A(200 + i));
const lower = (xs: readonly Address[]): string[] => xs.map((x) => x.toLowerCase());

test("launchTokenFor is a recognised entrypoint and its exemption list is read", () => {
  // regression: launchTokenFor had no selector, so a launch through the forwarder fell off the end of
  // the chain with an empty exemption list, and the score paid it +5 for declaring no bundle at all
  const ten = bundle(10);
  const call = decodeLaunchCall(encodeFunctionData({ abi: factoryAbi, functionName: "launchTokenFor", args: [PARAMS, 0n, ZERO as Address, A(2), ten] }));
  assert.equal(call.via, "forwarder");
  assert.deepEqual(lower(call.exemptions), lower(ten));
});

test("the entrypoints that were already recognised still decode the same way", () => {
  const four = bundle(4);
  const viaRouter = decodeLaunchCall(encodeFunctionData({ abi: routerAbi, functionName: "launchAndBuy", args: [PARAMS, 0n, ZERO as Address, 10n ** 17n, 0n, A(3), four] }));
  assert.equal(viaRouter.via, "router");
  assert.equal(viaRouter.devBuy, 10n ** 17n);
  assert.equal(viaRouter.recipient?.toLowerCase(), A(3));
  assert.deepEqual(lower(viaRouter.exemptions), lower(four));

  const plain = decodeLaunchCall(encodeFunctionData({ abi: factoryAbi, functionName: "launchToken", args: [PARAMS, 0n, ZERO as Address] }));
  assert.equal(plain.via, "factory", "this entrypoint has no exemption parameter, so an empty list is a fact");
});

test("an entrypoint nobody recognises reports itself as unread, not as an empty bundle", () => {
  const call = decodeLaunchCall(`0xdeadbeef${"0".repeat(64)}` as Hex);
  assert.equal(call.via, "unknown");
  assert.deepEqual(call.exemptions, [], "empty here means unread, and only `via` can say which");
});
