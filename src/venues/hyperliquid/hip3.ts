// Hyperliquid HIP-3 (builder-deployed perp dexes): pure helpers, unit-tested.
//
// Facts used here, checked against the live info API and the docs on 2026-10-08:
//   * {"type":"perpDexs"} → [null, dex1, dex2, …]; index 0 (null) is Hyperliquid's own
//     validator-operated dex. Mainnet: "xyz" is index 1; testnet: "xyz" is index 65 and has a
//     different deployer (0x7770…0777) from mainnet's (0x8880…0888).
//   * Asset ids (docs: for-developers/api/asset-ids): builder perps use
//     100000 + perp_dex_index * 10000 + index_in_meta, where index_in_meta is the coin's
//     position in {"type":"metaAndAssetCtxs","dex":"<name>"}. Coin names are "<dex>:<COIN>"
//     and case-sensitive.
//   * Margin: universe entries carry onlyIsolated and marginMode ("noCross" | "strictIsolated"
//     = isolated only; strictIsolated also forbids removing margin; absent/"normal" = cross allowed).
//   * Collateral: every perp dex margins separately. meta.collateralToken is the spot token
//     index of the collateral (0 = USDC on both networks). agentSendAsset moves the collateral
//     token between the user's own dexes ("" = Hyperliquid's main USDC dex) and can be signed by
//     the one-tap agent (docs: exchange endpoint, "Agent Send Asset").
//   * Fees (docs: trading/fees, feeRates()): HIP-3 scale = deployerFeeScale < 1 ? scale + 1 :
//     scale × 2; growth mode multiplies by 0.1. xyz uses scale 1.0 → 2× the base rate
//     (0.09% taker at tier 0), or 0.2× with growth mode (0.009%).
//   * trade.xyz's own docs (docs.trade.xyz/architecture) name the mainnet "xyz" deployer
//     0x88806a71D74ad0a510b350545C9aE490912F0888.

import type { NetworkId } from "../../config.ts";
import { categoryFromHl, type MarketCategory } from "../../lib/categories.ts";

/** Builder dexes the app lists (each must also exist in perpDexs on the network in use). */
export const HL_BUILDER_DEXES = ["xyz"] as const;

/** Deployers whose identity a first-party source confirms. */
export const KNOWN_DEPLOYERS: Partial<Record<NetworkId, Record<string, { dex: string; who: string; source: string }>>> = {
  mainnet: {
    "0x88806a71d74ad0a510b350545c9ae490912f0888": { dex: "xyz", who: "trade.xyz", source: "https://docs.trade.xyz/architecture" },
  },
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Order asset id of a perp: the coin's index on dex 0, else 100000 + dex × 10000 + index. */
export function hlAssetId(dexIndex: number, indexInMeta: number): number {
  if (!Number.isInteger(dexIndex) || dexIndex < 0) throw new Error(`bad perp dex index ${dexIndex}`);
  if (!Number.isInteger(indexInMeta) || indexInMeta < 0) throw new Error(`bad asset index ${indexInMeta}`);
  if (dexIndex === 0) return indexInMeta;
  if (indexInMeta >= 10_000) throw new Error(`asset index ${indexInMeta} does not fit a builder dex`);
  return 100_000 + dexIndex * 10_000 + indexInMeta;
}

/** The inverse of hlAssetId for perp ids (spot ids, 10000–99999, are not perps). */
export function decodeAssetId(id: number): { dexIndex: number; index: number } | null {
  if (!Number.isInteger(id) || id < 0) return null;
  if (id < 10_000) return { dexIndex: 0, index: id };
  if (id < 110_000) return null; // spot (10000 + i) or the unused 100000–109999 range
  const rest = id - 100_000;
  return { dexIndex: Math.floor(rest / 10_000), index: rest % 10_000 };
}

export interface HlDex {
  name: string;
  index: number;
  fullName: string;
  deployer: string;
}

/** A dex by name in a perpDexs answer (index = its position; 0 is the null main dex). */
export function findDex(raw: unknown, name: string): HlDex | null {
  if (!Array.isArray(raw)) return null;
  for (let i = 1; i < raw.length; i++) {
    const d = raw[i];
    if (isObj(d) && d.name === name) return { name, index: i, fullName: typeof d.fullName === "string" ? d.fullName : name, deployer: typeof d.deployer === "string" ? d.deployer.toLowerCase() : "" };
  }
  return null;
}

export interface HlAnnotation {
  category: MarketCategory;
  /** The deployer's display name ("USDJPY", "S&P500", "WTIOIL"); absent when none is set. */
  displayName?: string;
}

/**
 * FX coins whose quote direction the mainnet deployer states in its annotation (perpAnnotation
 * descriptions, 2026-10-08: "USDJPY references … Japanese yen per 1 U.S. dollar", "EURUSD …
 * U.S. dollars per 1 euro"). Used only when a network's annotation has no display name (the
 * testnet xyz dex sets none), so a yen market never reads as "JPY goes up" when the price is
 * yen per dollar.
 */
export const FX_PAIR_NAMES: Record<string, string> = { "xyz:JPY": "USDJPY", "xyz:KRW": "USDKRW", "xyz:EUR": "EURUSD", "xyz:GBP": "GBPUSD" };

/**
 * perpConciseAnnotations ([["xyz:GOLD",{category,displayName?,keywords?}], …]) or perpCategories
 * ([["xyz:GOLD","commodities"], …]) → coin → our category and display name (unknown kinds dropped).
 */
export function parseCategories(raw: unknown): Map<string, HlAnnotation> {
  const out = new Map<string, HlAnnotation>();
  if (!Array.isArray(raw)) return out;
  for (const r of raw) {
    if (!Array.isArray(r) || typeof r[0] !== "string") continue;
    const a: Record<string, unknown> = isObj(r[1]) ? r[1] : { category: r[1] };
    const c = categoryFromHl(a.category);
    if (!c) continue;
    const dn = typeof a.displayName === "string" && /^[A-Za-z0-9&.\- ]{1,16}$/.test(a.displayName.trim()) ? a.displayName.trim() : (FX_PAIR_NAMES[r[0]] ?? undefined);
    out.set(r[0], dn ? { category: c, displayName: dn } : { category: c });
  }
  return out;
}

/** Only isolated margin is allowed on this coin. */
export const isolatedOnly = (u: Record<string, unknown>): boolean => u.onlyIsolated === true || u.marginMode === "noCross" || u.marginMode === "strictIsolated";

/** The user's fee rates on a HIP-3 coin, from their base perp rates (docs feeRates()). */
export function hip3Fees(base: { taker: number; maker: number }, deployerFeeScale: number, growthMode: boolean): { taker: number; maker: number } {
  const s = Number.isFinite(deployerFeeScale) && deployerFeeScale >= 0 ? deployerFeeScale : 1;
  const scale = s < 1 ? s + 1 : s * 2;
  const g = growthMode ? 0.1 : 1;
  const taker = base.taker * scale * g;
  let maker = base.maker * g;
  if (maker > 0) maker *= scale; // rebates (negative maker) are not scaled up
  return { taker, maker };
}

/** "xyz · trade.xyz builder market", or the deployer's short address when no first-party source names it. */
export function builderLabel(net: NetworkId, dex: HlDex): string {
  const k = KNOWN_DEPLOYERS[net]?.[dex.deployer];
  if (k && k.dex === dex.name) return `${dex.name} · ${k.who} builder market`;
  const d = dex.deployer ? `${dex.deployer.slice(0, 6)}…${dex.deployer.slice(-4)}` : "unknown deployer";
  return `${dex.name} · builder market (deployer ${d}${net === "testnet" ? ", testnet" : ""})`;
}

/** The plain-English note shown with every builder market. */
export function builderNote(net: NetworkId, dex: HlDex, maxLeverage: number, isoOnly: boolean): string {
  const k = KNOWN_DEPLOYERS[net]?.[dex.deployer];
  const who = k && k.dex === dex.name ? k.who : "a third party";
  return (
    `A HIP-3 market: deployed on Hyperliquid by ${who}, not by Hyperliquid itself, which sets its price feed and rules. ` +
    `It can trade 24/7 even while the underlying stock, futures or currency market is closed, so its price can jump when that market reopens. ` +
    `It has its own leverage cap (${Math.floor(maxLeverage)}× here) ` +
    (isoOnly ? "and allows isolated margin only. " : "and this app trades it with isolated margin. ") +
    `Its collateral is kept apart from your main Hyperliquid balance (the app moves the margin over for you when you trade).`
  );
}

/** "USDC:0x6d1e…" for agentSendAsset, from spotMeta and the dex's collateralToken index. */
export function collateralTokenWire(spotMeta: unknown, collateralToken: number): string | null {
  if (!isObj(spotMeta) || !Array.isArray(spotMeta.tokens)) return null;
  const t = spotMeta.tokens.find((x: unknown) => isObj(x) && x.index === collateralToken) as Record<string, unknown> | undefined;
  return t && typeof t.name === "string" && typeof t.tokenId === "string" && /^0x[0-9a-f]{32}$/i.test(t.tokenId) ? `${t.name}:${t.tokenId}` : null;
}

/**
 * agentSendAsset: move collateral between this user's own perp dexes. Field order is the
 * docs' order (it is part of the msgpack hash the agent signs).
 */
export function agentSendAssetAction(o: { destination: string; sourceDex: string; destinationDex: string; token: string; amount: string; nonce: number }) {
  return {
    type: "agentSendAsset",
    destination: o.destination,
    sourceDex: o.sourceDex,
    destinationDex: o.destinationDex,
    token: o.token,
    amount: o.amount,
    fromSubAccount: "",
    nonce: o.nonce,
  };
}

/** USDC needed on a dex, rounded UP to the cent, so the transfer always covers the margin. */
export function shortfall(need: number, free: number): string | null {
  const s = need - free;
  if (!(s > 0)) return null;
  return (Math.ceil(s * 100 - 1e-9) / 100).toFixed(2);
}
