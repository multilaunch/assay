import type { Address } from "viem";
import type { LaunchIntel } from "./enrich.js";

/**
 * Launch farms print tokens from fresh wallets with the same calldata: identical opening-buy amount,
 * identical creator tax, identical set of links, identical exemption count, minutes apart. Each
 * launch scores fine alone. Keyed on what the launch fixed, kept in memory for `windowMs`.
 *
 * The cohort is kept, not just its size. "farm ×8" with no way to see the eight is a dead end: the
 * question it provokes is which eight, and matched on what, and the answer has to be somewhere.
 */

/** The fingerprint, before it is joined into a key. Each field is a claim the launches share. */
export interface FarmParts {
  /** the opening buy, in raw token units — the same number, not merely a similar one */
  devBuy: string;
  creatorTaxBps: number;
  /** one character per link slot: twitter, telegram, discord, website, farcaster */
  links: string;
  exempt: number;
  pair: Address;
}

export interface FarmMember {
  t: number;
  deployer: string;
  token: Address;
  symbol: string | null;
}

export interface Cohort {
  key: string;
  parts: FarmParts | null;
  members: FarmMember[];
  /** distinct wallets behind them; one wallet launching twice is a retry, several is an operation */
  wallets: number;
  windowMs: number;
}

const LINK_SLOTS = ["twitter", "telegram", "discord", "website", "farcaster"] as const;

export class FarmDetector {
  private readonly seen = new Map<string, FarmMember[]>();
  constructor(private readonly windowMs = 30 * 60_000) {}

  static parts(intel: LaunchIntel): FarmParts | null {
    if (!intel.tx || !intel.record) return null;
    const s = intel.meta?.socials;
    return {
      devBuy: intel.tx.devBuy.toString(),
      creatorTaxBps: Number(intel.record.creatorTaxBps),
      links: LINK_SLOTS.map((k) => (s?.[k]?.trim() ? "1" : "0")).join(""),
      exempt: intel.tx.exemptions.length,
      pair: intel.pair.address,
    };
  }

  static fingerprint(intel: LaunchIntel): string | null {
    const p = FarmDetector.parts(intel);
    return p === null ? null : `${p.devBuy}|${p.creatorTaxBps}|${p.links}|${p.exempt}|${p.pair.toLowerCase()}`;
  }

  /** Turns a key back into its fields, for a reader who has the key but not the launch. */
  static explain(key: string): FarmParts | null {
    const bits = key.split("|");
    if (bits.length !== 5) return null;
    const [devBuy, tax, links, exempt, pair] = bits as [string, string, string, string, string];
    if (!/^\d+$/.test(devBuy) || !/^\d+$/.test(tax) || !/^[01]{5}$/.test(links) || !/^\d+$/.test(exempt)) return null;
    return { devBuy, creatorTaxBps: Number(tax), links, exempt: Number(exempt), pair: pair as Address };
  }

  /** Records this launch; returns how many earlier launches in the window share it, from other wallets. */
  observe(intel: LaunchIntel, now = Date.now()): { twins: number; key: string | null } {
    const key = FarmDetector.fingerprint(intel);
    if (!key) return { twins: 0, key: null };
    const me = intel.ev.deployer.toLowerCase();
    const list = (this.seen.get(key) ?? []).filter((x) => x.t > now - this.windowMs);
    const twins = list.filter((x) => x.deployer !== me).length;
    list.push({ t: now, deployer: me, token: intel.ev.token, symbol: intel.meta?.symbol ?? null });
    this.seen.set(key, list);
    if (this.seen.size > 5_000) for (const [k, v] of this.seen) if (!v.some((x) => x.t > now - this.windowMs)) this.seen.delete(k);
    return { twins, key };
  }

  /**
   * Everything still inside the window under one fingerprint, newest first.
   *
   * Includes launches that arrived *after* the one you clicked. `observe` counts only what came
   * before, because that is what the score could have known; an investigator wants the whole set.
   */
  cohort(key: string, now = Date.now()): Cohort {
    const members = (this.seen.get(key) ?? []).filter((x) => x.t > now - this.windowMs);
    return {
      key,
      parts: FarmDetector.explain(key),
      members: [...members].sort((a, b) => b.t - a.t),
      wallets: new Set(members.map((m) => m.deployer)).size,
      windowMs: this.windowMs,
    };
  }
}
