import { describe, expect, it } from "vitest";
import { compareHtml, type CompareRow } from "../../src/ui/perpViews.ts";
import { HL_STATUS } from "../../src/venues/hyperliquid/index.ts";

const row = (o: Partial<CompareRow>): CompareRow => ({ venueIdx: 0, venue: "Derive", listed: true, loading: false, mark: 2500, fundingRate: 0.00001, taker: 0.0003, maker: 0.0001, maxLeverage: 10, minOrder: "$10", selected: true, ...o });

describe("venue status in the comparison table (no venue looks proven when it is not)", () => {
  it("a coming-soon venue shows no price, fee or minimum, and cannot be picked", () => {
    const html = compareHtml("ETH", [row({}), row({ venueIdx: 1, venue: "Soon", listed: false, comingSoon: true, mark: null, taker: null, maker: null, minOrder: null, selected: false, note: "not ready" })]);
    const soon = html.slice(html.indexOf('data-cmp="1"'));
    expect(soon).toContain("coming soon: not ready");
    expect(soon).not.toContain("data-cmp-pick");
    expect(soon.split("</tr>")[0]).not.toMatch(/\$|%|×/);
  });
  it("a usable venue's caveat is printed under its name", () => {
    const html = compareHtml("ETH", [row({}), row({ venueIdx: 1, venue: "Hyperliquid", selected: false, note: HL_STATUS.tag })]);
    expect(html).toContain("<small>not live-tested</small>");
  });
  it("Hyperliquid is flagged as not live-tested until a real testnet round trip is recorded", () => {
    expect(HL_STATUS.usable).toBe(true);
    expect(HL_STATUS.tag).toBe("not live-tested");
    expect(HL_STATUS.detail).toMatch(/not yet placed a real Hyperliquid order/);
  });
});
