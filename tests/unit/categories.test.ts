// Trading categories: only from venue data; display order; Derive's one gold perp; Veranta's feed types.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CATEGORY_LABEL, CATEGORY_ORDER, categoriesOf, categoryFromDerive, categoryFromHl, categoryFromVeranta, categoryOf } from "../../src/lib/categories.ts";
import { marketsFrom, type VPair } from "../../src/venues/veranta/rules.ts";

describe("categories", () => {
  it("Hyperliquid deployer categories (free text) → ours; others dropped", () => {
    expect(categoryFromHl("commodities")).toBe("commodities");
    expect(categoryFromHl("stock")).toBe("stocks");
    expect(categoryFromHl("FX")).toBe("fx");
    expect(categoryFromHl(" indices ")).toBe("indices");
    expect(categoryFromHl("crypto")).toBe("crypto");
    for (const x of ["preipo", "rates", "", "BIG MEONG", null, 3]) expect(categoryFromHl(x)).toBeNull();
  });
  it("Veranta feed asset types → ours; US500/US100 are indices", () => {
    expect(categoryFromVeranta("metal", "XAU")).toBe("commodities");
    expect(categoryFromVeranta("commodity", "WTI")).toBe("commodities");
    expect(categoryFromVeranta("equity", "NVDA")).toBe("stocks");
    expect(categoryFromVeranta("equity", "US500")).toBe("indices");
    expect(categoryFromVeranta("equity", "US100")).toBe("indices");
    expect(categoryFromVeranta("fx", "EUR")).toBe("fx");
    expect(categoryFromVeranta("crypto", "ETH")).toBe("crypto");
    expect(categoryFromVeranta("", "SHIB")).toBeNull();
  });
  it("Derive: XAUT-PERP (Tether Gold) is a commodity, everything else crypto", () => {
    expect(categoryFromDerive("XAUT-PERP")).toBe("commodities");
    expect(categoryFromDerive("ETH-PERP")).toBe("crypto");
  });
  it("only the categories present, in display order; crypto-only lists have just crypto", () => {
    expect(categoriesOf([{ category: "fx" }, {}, { category: "stocks" }])).toEqual(["crypto", "stocks", "fx"]);
    expect(categoriesOf([{}, {}])).toEqual(["crypto"]);
    expect(categoriesOf([])).toEqual([]);
    expect(categoryOf({})).toBe("crypto");
    expect(CATEGORY_ORDER.map((c) => CATEGORY_LABEL[c])).toEqual(["Crypto", "Commodities", "Stocks", "Indices", "FX"]);
  });
  it("Veranta markets carry the feed's category; pairs without a feed type stay crypto (recorded pairs)", () => {
    const rec = JSON.parse(readFileSync(new URL("../fixtures/veranta/mainnet.json", import.meta.url), "utf8")) as { pairs: VPair[]; prices: Record<number, number> };
    const typed: VPair[] = [
      { index: 21, from: "XAU", to: "USD", feed: { attributes: { assetType: "metal", isOpen: true } } },
      { index: 78, from: "US500", to: "USD", feed: { attributes: { assetType: "equity", isOpen: true } } },
      { index: 81, from: "NVDA", to: "USD", feed: { attributes: { assetType: "equity", isOpen: true } } },
      { index: 11, from: "EUR", to: "USD", feed: { attributes: { assetType: "fx", isOpen: true } } },
      { index: 12, from: "USD", to: "JPY", feed: { attributes: { assetType: "fx", isOpen: true } } },
      { index: 99, from: "SHIB", to: "USD", isPairListed: false, feed: { attributes: { assetType: "", isOpen: false } } },
    ];
    const { markets } = marketsFrom([...rec.pairs.filter((p) => p.from === "ETH"), ...typed], {}, 0);
    const by = (n: string) => markets.find((m) => m.name === n);
    expect(by("ETH-PERP")!.category).toBeUndefined();
    expect(by("XAU-PERP")!.category).toBe("commodities");
    expect(by("US500-PERP")!.category).toBe("indices");
    expect(by("NVDA-PERP")!.category).toBe("stocks");
    expect(by("EUR-PERP")!.category).toBe("fx");
    expect(markets.some((m) => m.currency === "USD")).toBe(false); // USD/JPY: not quoted in USD, left out
    expect(by("SHIB-PERP")).toBeUndefined();
  });
});
