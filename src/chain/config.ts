import { defineChain, type Address } from "viem";

/**
 * Robinhood Chain mainnet. Arbitrum Orbit stack, chain id 4663, ETH gas, ~100 ms blocks,
 * sequencer orders by arrival, no public mempool, no priority-fee auction.
 */
export const CHAIN_ID = 4663;

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address } },
});

/**
 * Pons v2 addresses from docs.ponsfamily.com/v2, re-read from the live factory on 2026-09-07
 * (`memeHook()`, `feeEscrow()`, `launchForwarder()`, `locker()` all matched). `doctor` re-checks
 * them on every run; nothing below is trusted without that read.
 */
export const PONS = {
  factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as Address,
  /** Launch & Buy router. The factory calls it `launchForwarder`. */
  router: "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948" as Address,
  deployer: "0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42" as Address,
  escrow: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e" as Address,
  hook: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044" as Address,
  locker: "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952" as Address,
  buybackVault: "0x42df2a798f82289E177311362e8f5ccC45c1219c" as Address,
  graduationExecutor: "0xC7819B64A1dAECD7eC19856d026cb14EfBd89046" as Address,
  graduationGuard: "0xf5695117b99B6f6401e67d4195BD653628176C6C" as Address,
} as const;

/** Uniswap v4 on Robinhood Chain, for trading after graduation. Verified by `doctor --probe`. */
export const UNI = {
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Address,
  quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94" as Address,
  stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b" as Address,
  universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904" as Address,
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address,
} as const;

export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const ZERO: Address = "0x0000000000000000000000000000000000000000";
/** A recipient that is never exempt from the opening tax; used to read the public tax curve. */
export const DEAD: Address = "0x000000000000000000000000000000000000dEaD";

/** Every pons v2 launch mints exactly this. */
export const LAUNCH_SUPPLY = 1_000_000_000n * 10n ** 18n;
export const BPS = 10_000n;

/** Public RPC endpoints and what each one will serve. See util/rpc.ts for the routing. */
export const DEFAULT_ENDPOINTS = [
  { url: "https://robinhood-rpc.publicnode.com", label: "publicnode", caps: ["state"] as const },
  { url: "https://rpc.mainnet.chain.robinhood.com", label: "robinhood", caps: ["state", "logs"] as const },
];
export const DEFAULT_WS = "wss://robinhood-rpc.publicnode.com";

export const EXPLORER = {
  tx: (h: string) => `https://robinhoodchain.blockscout.com/tx/${h}`,
  address: (a: string) => `https://robinhoodchain.blockscout.com/address/${a}`,
  token: (a: string) => `https://robinhoodchain.blockscout.com/token/${a}`,
  pons: (a: string) => `https://www.ponsfamily.com/launchpad/${a}`,
};
