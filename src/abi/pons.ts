import { parseAbi, toEventSelector, toFunctionSelector } from "viem";

/**
 * Pons v2 ABI, assembled from the protocol source (github.com/ponsdotdev/ponsfamily, contractsV2/src/v2)
 * and from three curve functions the deployed contracts expose but the public source does not yet:
 * `currentSnipeTaxBps`, `launchedAt`, `snipeTaxExempt`. Those three were read on a live curve on
 * 2026-09-07 (docs/GROUND_TRUTH.md); `doctor` reads them again on every start.
 */

/** ILaunchpadV2.GraduationPhase */
export const PHASE = ["NotGraduated", "Swept", "PoolCreated", "Rescued"] as const;
export type Phase = (typeof PHASE)[number];

export const factoryAbi = parseAbi([
  // reads
  "function launchFee() view returns (uint256)",
  "function maxCreatorTaxBps() view returns (uint256)",
  "function snipeTaxStartBps() view returns (uint256)",
  "function snipeTaxSeconds() view returns (uint256)",
  "function launchEnabled() view returns (bool)",
  "function launchConfigCount() view returns (uint256)",
  "function memeHook() view returns (address)",
  "function feeEscrow() view returns (address)",
  "function launchForwarder() view returns (address)",
  "function locker() view returns (address)",
  "function approvedPairTokens(address) view returns (bool)",
  "function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))",
  // launch entrypoints (decoded from calldata, never called by this tool)
  "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }",
  "struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }",
  "function launchToken(TokenParams params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)",
  "function launchToken(TokenParams params, uint256 launchConfigId, address pairToken, address[] snipeTaxExemptions) payable returns (address token, address curve)",
  "function launchTokenFor(TokenParams params, uint256 launchConfigId, address pairToken, address originalDeployer, address[] snipeTaxExemptions) payable returns (address token, address curve)",
  // events
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
  "event LaunchSwept(address indexed token, uint256 quoteOut, uint256 tokenOut)",
  "event PoolGraduated(address indexed token, uint256 quoteIn, uint256 tokenIn, uint256 liquidity)",
]);

export const routerAbi = parseAbi([
  "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }",
  "struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }",
  "function launchAndBuy(TokenParams params, uint256 launchConfigId, address pairToken, uint256 quoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions) payable returns (address token, address curve, uint256 tokensOut)",
  "event Launched(address indexed token, address indexed curve, address indexed recipient, address launcher, uint256 quoteSpent, uint256 tokensReceived)",
]);

export const curveAbi = parseAbi([
  "function token() view returns (address)",
  "function pairToken() view returns (address)",
  "function deployer() view returns (address)",
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "function realQuoteReserve() view returns (uint256)",
  "function phantomQuote() view returns (uint256)",
  "function trackedQuote() view returns (uint256)",
  "function trackedTokens() view returns (uint256)",
  "function sellableTokens() view returns (uint256)",
  "function reservedTokens() view returns (uint256)",
  "function graduationThreshold() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function graduated() view returns (bool)",
  "function readyToGraduate() view returns (bool)",
  "function launchedAt() view returns (uint256)",
  "function currentSnipeTaxBps(address recipient) view returns (uint256)",
  "function snipeTaxExempt(address account) view returns (bool)",
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)",
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
  "event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)",
  "event CurveBuyRefunded(address indexed buyer, uint256 refund)",
  "event CurveCompleted(address recipient, uint256 quoteOut, uint256 tokenOut)",
  "event FeesSwept(uint256 protocolAmount, uint256 buybackAmount, uint256 creatorAmount)",
]);

export const tokenAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function deployer() view returns (address)",
  "function curve() view returns (address)",
  "function logo() view returns (string)",
  "function description() view returns (string)",
  "function socials() view returns (string twitter, string telegram, string discord, string website, string farcaster)",
  "function getTokenInfo() view returns (address tokenDeployer, string tokenLogo, string tokenDescription, (string twitter, string telegram, string discord, string website, string farcaster) tokenSocials)",
]);

export const escrowAbi = parseAbi([
  "function balanceOf(address recipient) view returns (uint256)",
  "function balanceOfToken(address recipient, address token) view returns (uint256)",
  "function claim() returns (uint256 amount)",
  "function claimToken(address token) returns (uint256 amount)",
  "event Credited(address indexed recipient, address indexed depositor, uint256 amount)",
  "event Claimed(address indexed recipient, uint256 amount)",
]);

export const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);

/** Event topics we filter on. */
export const TOPIC = {
  tokenLaunched: toEventSelector("TokenLaunched(address,address,address,address,uint256,uint256)"),
  curveBuy: toEventSelector("CurveBuy(address,address,uint256,uint256,uint256,uint256)"),
  curveSell: toEventSelector("CurveSell(address,address,uint256,uint256,uint256,uint256)"),
  poolGraduated: toEventSelector("PoolGraduated(address,uint256,uint256,uint256)"),
  credited: toEventSelector("Credited(address,address,uint256)"),
  claimed: toEventSelector("Claimed(address,uint256)"),
} as const;

/** Function selectors we recognise in launch transactions. */
export const SELECTOR = {
  launchAndBuy: toFunctionSelector(
    "launchAndBuy((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address,uint256,uint256,address,address[])",
  ),
  launchTokenPlain: toFunctionSelector(
    "launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address)",
  ),
  launchTokenExempt: toFunctionSelector(
    "launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address,address[])",
  ),
} as const;
