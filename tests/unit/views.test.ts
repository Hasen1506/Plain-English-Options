import { describe, expect, it } from "vitest";
import { axisHtml, chartSvg, connectEmptyHtml, describeOption, historyHtml, pairSpreads, portfolioHtml, reviewHtml, ringHtml } from "../../src/ui/views.ts";
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
  it("names option legs in plain words, and leaves other names alone", () => {
    expect(describeOption("ETH-20261127-2500-C")).toEqual({ asset: "ETH", date: "Nov 27", strike: 2500, type: "C" });
    expect(describeOption("ADA-20261030-0_25-P")).toEqual({ asset: "ADA", date: "Oct 30", strike: 0.25, type: "P" });
    expect(describeOption("ETH-PERP")).toBeNull();
    expect(describeOption("ETH-20261327-2500-C")).toBeNull();
  });
  it("portfolio: one card per spread with both legs, a single empty state without a wallet", () => {
    const sub = { id: 1, riskUniverse: 1, managerId: 1, value: 1, ...M, initialMargin: 0, positions: [pos("ETH-20261127-2500-C", 1), pos("ETH-20261127-3000-C", -1)], openOrders: [] };
    const html = portfolioHtml(sub, "Testnet", true);
    expect(html.match(/class="x-pos"/g)).toHaveLength(1);
    expect(html.match(/data-leg/g)).toHaveLength(2);
    expect(html).toContain("ETH call spread · $2,500 → $3,000");
    expect(html).toContain('data-close-spread="ETH-20261127-2500-C|ETH-20261127-3000-C"');
    const empty = portfolioHtml(null, "Testnet", false);
    expect(empty.match(/class="x-card/g)).toHaveLength(1);
    expect(empty).toContain("data-connect");
    expect(empty).toBe(connectEmptyHtml("portfolio", "Testnet"));
    const h = historyHtml({ connected: false, netName: "Mainnet", subId: null, spreads: [], closedSingles: [], trades: [], orders: [], loading: false, error: null });
    expect(h).toContain("historyEmpty");
    expect(h).toContain("Derive mainnet");
  });
  it("review: wallet row, collapsible contracts, axis under the strikes, countdown ring", () => {
    const L = mkInst({ strike: 2500, type: "C" }), S = mkInst({ strike: 3000, type: "C" });
    const r = quoteSpread({ dir: "up", long: { instrument: L, ticker: mkTicker({ ask: 233.7 }), side: "buy" }, short: { instrument: S, ticker: mkTicker({ bid: 58.3 }), side: "sell" }, K1: 2500, K2: 3000, width: 500 }, 1000);
    if (!r.ok) throw new Error();
    const m = { q: r.quote, asset: "ETH", target: 3000, dateLong: "Nov 27, 2026", probability: 0.2, netName: "Testnet", mainnet: false, subs: [], selectedSub: null, assetRU: 1, connected: false, balance: null, preTrade: null, createUrl: "" };
    expect(reviewHtml(m)).toContain("Not connected");
    const on = reviewHtml({ ...m, connected: true, wallet: "0x95B0000000000000000000000000000000008Da8" });
    expect(on).toContain("0x95B0…8Da8");
    expect(on).toMatch(/<details class="x-ctr" id="contracts"><summary>Contracts/);
    expect(on.indexOf("Wallet")).toBeLessThan(on.indexOf("Settlement"));
    const ch = chartSvg(r.quote);
    const ax = axisHtml(r.quote, ch.from, ch.to);
    expect(ax.match(/<span/g)).toHaveLength(4);
    const lefts = [...ax.matchAll(/left:([\d.]+)%/g)].map((x) => Number(x[1]));
    expect(lefts[0]).toBeLessThan(lefts[1]!);
    expect(lefts[1]).toBeLessThan(100);
    expect(ringHtml(10)).toContain('stroke-dashoffset="0.00"');
    expect(ringHtml(0)).toMatch(/stroke-dashoffset="69\.1/);
    expect(ringHtml(4)).toContain("<b>4</b>");
  });
});
