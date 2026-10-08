// Trading categories for perp markets (Crypto, Commodities & metals, Stocks, Indices, FX).
// A venue only shows the categories it really lists: every category comes from the
// venue's own data (Hyperliquid: the deployer-set category annotation of HIP-3
// markets; Veranta: the price feed's `assetType`), never from a guess on the ticker.
// Pure and unit-tested.

export type MarketCategory = "crypto" | "commodities" | "stocks" | "indices" | "fx";

export const CATEGORY_ORDER: readonly MarketCategory[] = ["crypto", "commodities", "stocks", "indices", "fx"];

/** Pill words (short, they share one row of the popover). */
export const CATEGORY_LABEL: Record<MarketCategory, string> = {
  crypto: "Crypto",
  commodities: "Commodities",
  stocks: "Stocks",
  indices: "Indices",
  fx: "FX",
};

/** Longer words for captions and screen readers. */
export const CATEGORY_WORDS: Record<MarketCategory, string> = {
  crypto: "crypto",
  commodities: "commodities and metals",
  stocks: "stocks",
  indices: "indices",
  fx: "currencies (FX)",
};

/**
 * Hyperliquid `perpCategories` / `perpAnnotation.category` → ours. Deployers write free
 * text (seen 2026-10-08: "commodities", "stocks", "stock", "indices", "fx", "FX",
 * "crypto", "preipo", "rates"). Anything outside the five categories is left out (null).
 */
export function categoryFromHl(raw: unknown): MarketCategory | null {
  if (typeof raw !== "string") return null;
  const c = raw.trim().toLowerCase();
  if (c === "crypto") return "crypto";
  if (c === "commodities" || c === "commodity" || c === "metals" || c === "metal") return "commodities";
  if (c === "stocks" || c === "stock" || c === "equities" || c === "equity") return "stocks";
  if (c === "indices" || c === "index") return "indices";
  if (c === "fx" || c === "forex") return "fx";
  return null;
}

/** Index pairs on Veranta (their feeds are the index ETFs: US500 → SPY, US100 → QQQ). */
const VERANTA_INDEX_PAIRS = new Set(["US500", "US100", "US30", "US2000"]);

/**
 * Veranta pair → ours, from its price feed attributes (`assetType`: crypto | fx | metal |
 * commodity | equity). Equity pairs that are indices (US500, US100) go to Indices.
 */
export function categoryFromVeranta(assetType: unknown, from: string): MarketCategory | null {
  if (typeof assetType !== "string") return null;
  const t = assetType.trim().toLowerCase();
  if (t === "crypto") return "crypto";
  if (t === "fx") return "fx";
  if (t === "metal" || t === "commodity") return "commodities";
  if (t === "equity") return VERANTA_INDEX_PAIRS.has(from.toUpperCase()) ? "indices" : "stocks";
  return null;
}

/**
 * Derive lists one perp whose price is not a crypto asset's own: XAUT-PERP, Tether Gold
 * (a token redeemable for gold, so its price tracks gold). Everything else Derive lists
 * is a crypto asset. This is the app's classification, not Derive's.
 */
const DERIVE_CATEGORY: Record<string, MarketCategory> = { "XAUT-PERP": "commodities" };
export const categoryFromDerive = (name: string): MarketCategory => DERIVE_CATEGORY[name] ?? "crypto";

/** A market's category; markets without one are crypto (every venue's default listing). */
export const categoryOf = (m: { category?: MarketCategory }): MarketCategory => m.category ?? "crypto";

/** The categories present in a market list, in display order. */
export function categoriesOf(markets: readonly { category?: MarketCategory }[]): MarketCategory[] {
  const have = new Set(markets.map(categoryOf));
  return CATEGORY_ORDER.filter((c) => have.has(c));
}
