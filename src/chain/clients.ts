import { createPublicClient, webSocket, type PublicClient } from "viem";
import { DEFAULT_ENDPOINTS, DEFAULT_WS, robinhoodChain } from "./config.js";
import { envNum, envStr, loadEnv } from "../util/env.js";
import { RpcGate, parseEndpointEnv } from "../util/rpc.js";

loadEnv();

const specs = envStr("RPC_URL") ? parseEndpointEnv(envStr("RPC_URL")) : DEFAULT_ENDPOINTS;

/** The one gate every HTTP request goes through. */
export const gate = new RpcGate(specs, {
  maxInFlight: envNum("RPC_MAX_IN_FLIGHT", 3),
  spacingMs: envNum("RPC_SPACING_MS", 50),
  logsSpacingMs: envNum("RPC_LOGS_SPACING_MS", 400),
  retries: 6,
  timeoutMs: 15_000,
  userAgent: "hoodterm/0.1",
});

/** General reads, retries generously. */
export const client: PublicClient = createPublicClient({ chain: robinhoodChain, transport: gate.transport() });

/** Same gate; a separate object so hot-path code can be told apart in stack traces and swapped later. */
export const fast: PublicClient = createPublicClient({ chain: robinhoodChain, transport: gate.transport() });

const wsUrl = envStr("RPC_WS_URL", DEFAULT_WS);
/** Subscription client for launch detection, or null when RPC_WS_URL=off. */
export const ws: PublicClient | null =
  wsUrl.toLowerCase() === "off" ? null : createPublicClient({ chain: robinhoodChain, transport: webSocket(wsUrl, { reconnect: { attempts: 20, delay: 1000 }, retryCount: 3, timeout: 20_000 }) });

export const wsLabel = (): string => (ws ? wsUrl.replace(/^wss?:\/\//, "").slice(0, 40) : "off");
