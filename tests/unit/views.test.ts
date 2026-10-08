import { describe, expect, it } from "vitest";
import { pairSpreads, portfolioHtml, reviewHtml } from "../../src/ui/views.ts";
import { quoteSpread } from "../../src/lib/spread.ts";
import { mkInst, mkTicker } from "./gen.ts";
import type { Position } from "../../src/lib/ticker.ts";

const pos = (instrument: string, amount: number): Position => ({ instrument, amount, averagePrice: 1, markPrice: 1, unrealizedPnl: 0, totalFees: 0, instrumentType: "option", liquidationPrice: null, cumulativeFunding: 0, pendingFunding: 0, leverage: null, realizedPnl: 0 });
const M = { maintenanceMargin: 0, collateralsValue: 0, underLiquidation: false };

describe("views", () => {
  it("pairs a long and short of the same expiry/type into a spread", () => {
    const r = pairSpreads([pos("ETH-20261016-2600-C", 1), pos("ETH-20261016-2700-C", -1), pos("BTC-20261016-90000-P", 2)]);
    expect(r.pairs.map(([a, b]) => [a.instrument, b.instrument])).toEqual([["ETH-20261016-2600-C", "ETH-20261016-2700-C"]]);
    expect(r.singles.map((p) => p.instrument)).toEqual(["BTC-20261016-90000-P"]);
  });
  it("escapes everything that comes from the network", () => {
    const html = portfolioHtml({ id: 1, riskUniverse: 1, managerId: 1, value: 1, ...M, initialMargin: 0, positions: [pos('<img src=x onerror="1">', 1)], openOrders: [] }, "Testnet", true);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
  it("review shows the create-subaccount hint when no subaccount is in the asset's universe", () => {
    const L = mkInst({ strike: 2500, type: "C" }), S = mkInst({ strike: 3000, type: "C" });
    const r = quoteSpread({ dir: "up", long: { instrument: L, ticker: mkTicker({ ask: 233.7 }), side: "buy" }, short: { instrument: S, ticker: mkTicker({ bid: 58.3 }), side: "sell" }, K1: 2500, K2: 3000, width: 500 }, 1000);
    if (!r.ok) throw new Error();
    const m = { q: r.quote, asset: "ETH", target: 3000, dateLong: "Nov 27, 2026", probability: 0.2, netName: "Testnet", mainnet: false, subs: [{ id: 87138, riskUniverse: 0, managerId: 0, value: 0, initialMargin: 0, ...M, positions: [], openOrders: [] }], selectedSub: null, assetRU: 1, connected: true, balance: null, preTrade: null, createUrl: "https://testnet.app.derive.xyz" };
    expect(reviewHtml(m)).toContain('id="noSubHint"');
    expect(reviewHtml({ ...m, subs: [{ ...m.subs[0]!, id: 87139, riskUniverse: 1 }] })).not.toContain('id="noSubHint"');
    expect(reviewHtml({ ...m, mainnet: true })).toContain("Real money");
  });
});
