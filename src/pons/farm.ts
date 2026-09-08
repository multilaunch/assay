import type { LaunchIntel } from "./enrich.js";

/**
 * Launch farms print tokens from fresh wallets with the same calldata: identical opening-buy amount,
 * identical creator tax, identical set of links, identical exemption count, minutes apart. Each launch
 * scores fine alone. Keyed on what the launch fixed, kept in memory for `windowMs`.
 */
export class FarmDetector {
  private readonly seen = new Map<string, { t: number; deployer: string }[]>();
  constructor(private readonly windowMs = 30 * 60_000) {}

  static fingerprint(intel: LaunchIntel): string | null {
    if (!intel.tx || !intel.record) return null;
    const s = intel.meta?.socials;
    const links = [s?.twitter, s?.telegram, s?.discord, s?.website, s?.farcaster].map((v) => (v?.trim() ? "1" : "0")).join("");
    return `${intel.tx.devBuy}|${intel.record.creatorTaxBps}|${links}|${intel.tx.exemptions.length}|${intel.pair.address.toLowerCase()}`;
  }

  /** Records this launch; returns how many earlier launches in the window share the fingerprint from other deployers. */
  observe(intel: LaunchIntel, now = Date.now()): { twins: number; key: string | null } {
    const key = FarmDetector.fingerprint(intel);
    if (!key) return { twins: 0, key: null };
    const me = intel.ev.deployer.toLowerCase();
    const list = (this.seen.get(key) ?? []).filter((x) => x.t > now - this.windowMs);
    const twins = list.filter((x) => x.deployer !== me).length;
    list.push({ t: now, deployer: me });
    this.seen.set(key, list);
    if (this.seen.size > 5_000) for (const [k, v] of this.seen) if (!v.some((x) => x.t > now - this.windowMs)) this.seen.delete(k);
    return { twins, key };
  }
}
