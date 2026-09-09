/**
 * Reasons as codes and numbers, not as sentences.
 *
 * The score's whole claim is that every point has a reason you can read, so the reasons are the most
 * useful text on the page — and they were being built here, in English, and shipped to the board
 * already glued together. A reader who had switched the board to Russian got the interface in
 * Russian and the actual explanation in English, because by then there was nothing left to
 * translate.
 *
 * So a reason is now a code and its numbers. English lives in `TEXT` below, which the terminal uses;
 * the board renders the same codes out of its own dictionary. The journal gets to store codes too,
 * which means a rule can later be counted by what it is rather than by a regex over its wording.
 */

export interface Note {
  code: string;
  vars?: Record<string, string | number>;
}

export interface Reason extends Note {
  points: number;
}

export const note = (code: string, vars?: Record<string, string | number>): Note => (vars ? { code, vars } : { code });

type Render = (v: Record<string, string | number>) => string;

/** The English wording. One entry per code; anything missing renders as the code, which is loud. */
export const TEXT: Record<string, Render | string> = {
  // what could not be read
  tx_unreadable: "launch transaction unreadable: opening buy and declared bundle unknown",
  no_record: "no factory record: creator tax and fee recipient unknown",
  curve_unreadable: "curve unreadable",

  // the launcher's own skin
  dev_none: "no opening buy, nothing at stake",
  dev_tiny: (v) => `opening buy ${v.pct}% of supply, token-sized`,
  dev_band: (v) => `opening buy ${v.pct}%, inside the 1–6% band`,
  dev_heavy: (v) => `opening buy ${v.pct}%, heavy`,
  dev_huge: (v) => `opening buy ${v.pct}%, over 10%: one wallet can flatten the curve`,

  // what the creator charges
  tax_none: "no creator tax",
  tax_low: (v) => `creator tax ${v.pct}%: earns on volume, has a reason to keep posting`,
  tax_mid: (v) => `creator tax ${v.pct}%`,
  tax_high: (v) => `creator tax ${v.pct}%: traders pay ${v.perSide}% per side, flow dies`,
  fees_third_party: "fees routed to a third party (builder / KOL deal shape)",

  // somewhere for flow to come from
  no_socials: "no socials: no one to bring flow",
  has_x: "has X",
  has_web: "has website",
  has_tg: "has telegram",
  real_description: "real description",

  // the declared bundle
  entrypoint_unknown: "unrecognised launch entrypoint: the declared bundle could not be read",
  exempt_none: "no wallets exempt from the opening tax",
  exempt_few: (v) => `${v.n} wallet${Number(v.n) > 1 ? "s" : ""} exempt from the opening tax`,
  exempt_many: (v) => `${v.n} wallets exempt from the opening tax: a declared bundle`,

  // one operator, many wallets
  farm_many: (v) => `launch farm: ${v.n} launches with this exact fingerprint in 30 min`,
  farm_one: "one earlier launch with this exact fingerprint in 30 min",

  // the deployer's record
  dep_fresh: "fresh deployer",
  dep_good: (v) => `deployer graduated ${v.graduated} of ${v.prior} recent launches`,
  dep_serial: (v) => `serial deployer: ${v.prior} launches, none graduated`,
  dep_mixed: (v) => `deployer: ${v.prior} recent launches, ${v.graduated} graduated`,

  // the first minute
  buyers_many: (v) => `${v.n} distinct buyers`,
  buyers_some: (v) => `${v.n} distinct buyers`,
  bots_only: "every buy so far landed inside the opening-tax window: bots only",
  more_sells: "more sells than buys",
  fast_fill: (v) => `${v.pct}% of the curve filled in ${v.sec}s`,

  // flags: worth knowing, did not move the number
  flag_mint_elsewhere: (v) => `opening buy minted to ${v.address}, not the launcher`,
  flag_fee_recipient: (v) => `fee recipient ${v.address}`,
  flag_pair_not_eth: (v) => `paired with ${v.symbol} (${v.decimals} decimals), not ETH`,
  flag_buyback: "buyback-and-lock enabled",
  flag_reads_failed: (v) => `${v.n} read${Number(v.n) > 1 ? "s" : ""} failed`,

  // refusals
  no_data: (v) => `unreadable: ${v.detail}`,
  gate_open_positions: (v) => `open positions ${v.have} ≥ ${v.max}`,
  gate_budget: (v) => `session budget reached (${v.spent} of ${v.budget} wei spent)`,
  gate_farm: (v) => `launch farm: ${v.twins} twins in 30 min > ${v.max}`,
  gate_pair_not_eth: (v) => `pair is ${v.symbol}, not ETH`,
  gate_pair_decimals: (v) => `pair ${v.symbol} has ${v.decimals} decimals and no entry size of its own`,
  gate_score: (v) => `score ${v.score} < ${v.min}`,
  gate_tx_unreadable: "launch transaction unreadable: opening buy and exempt wallets unknown",
  gate_dev: (v) => `opening buy ${v.pct}% > ${v.max}%`,
  gate_exempt: (v) => `${v.n} exempt wallets > ${v.max}`,
  gate_no_record: "no factory record: creator tax unknown",
  gate_tax: (v) => `creator tax ${v.pct}% > ${v.max}%`,
  gate_no_socials: "no socials",
  gate_keyword: (v) => `keyword ${v.pattern} not found`,
  gate_deployer: "deployer not on the allow-list",
  gate_curve_unreadable: "curve unreadable",
  gate_curve_closed: "curve already closed",
  gate_not_armed: "not armed",
  gate_dry_run: "dry run not started",
};

/** One note in English. An unknown code prints as itself rather than as an empty string. */
export function render(n: Note): string {
  const t = TEXT[n.code];
  if (t === undefined) return n.code;
  return typeof t === "string" ? t : t(n.vars ?? {});
}

/** A reason with its points in front, the way the terminal has always printed them. */
export const renderReason = (r: Reason): string => `${r.points >= 0 ? "+" : ""}${r.points} ${render(r)}`;
