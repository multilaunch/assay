import { createWalletClient, type Address, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { gate } from "../chain/clients.js";
import { robinhoodChain } from "../chain/config.js";

/**
 * The only file that touches PRIVATE_KEY.
 *
 * The key is read from the user's own .env on the user's own machine, used to sign transactions sent
 * to the RPC they configured, and never printed, logged, written to data/, or sent anywhere else.
 */

let cached: PrivateKeyAccount | null | undefined;

export function getAccount(): PrivateKeyAccount | null {
  if (cached !== undefined) return cached;
  const raw = process.env.PRIVATE_KEY?.trim();
  if (!raw) { cached = null; return null; }
  const hex = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("PRIVATE_KEY is not a 32-byte hex key");
  cached = privateKeyToAccount(hex);
  return cached;
}

export function requireAccount(): PrivateKeyAccount {
  const a = getAccount();
  if (!a) throw new Error("PRIVATE_KEY is not set in .env; live trades need a signer (dry run does not)");
  return a;
}

export function walletClient(): WalletClient {
  return createWalletClient({ account: requireAccount(), chain: robinhoodChain, transport: gate.transport() });
}

/** The address the engine quotes for. Live: the signer. Dry run: a wallet that is never exempt. */
export const quotingAddress = (dead: Address): Address => getAccount()?.address ?? dead;
