// Veranta (Base) rules: pair catalogue → markets, sizing through the shared quote builder,
// the open-interest-skew fee, isolated liquidation, USDC rounding, positions / limits /
// history parsers. Unit cases on the recorded catalogues plus fast-check properties
// (fixed seed from tests/setup.ts).
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import testnet from "../fixtures/veranta/testnet.json" with { type: "json" };
import mainnet from "../fixtures/veranta/mainnet.json" with { type: "json" };
import { historyFrom, limitsFrom, marketsFrom, openFeeRate, positionsFrom, tickFor, usdc6, verantaLiqPrice, verantaName, type VHistoryRow, type VPair, type VerantaMarket } from "../../src/venues/veranta/rules.ts";
import { VERANTA_LIQ_THRESHOLD } from "../../src/venues/veranta/config.ts";
import { quotePerp, type PerpInput } from "../../src/lib/perp.ts";
import { historyPage } from "../../src/venues/veranta/api.ts";
import { feeWords } from "../../src/ui/perpViews.ts";

const NOW = 1_791_000_000_000;
const load = (fx: { pairs: unknown[]; prices: Record<string, number> }) => marketsFrom(fx.pairs as VPair[], Object.fromEntries(Object.entries(fx.prices).map(([k, v]) => [Number(k), v])), NOW);

const eth = (): { m: VerantaMarket; px: number } => {
  const r = load(testnet);
  return { m: r.markets.find((x) => x.name === "ETH-PERP")!, px: r.tickers["ETH-PERP"]!.mark };
};
const input = (m: VerantaMarket, px: number, over: Partial<PerpInput> = {}): PerpInput => {
  const t = load(testnet).tickers[m.name] ?? { ts: NOW, mark: px, index: px, bid: px * (1 - m.spread), ask: px * (1 + m.spread), bidSize: 1e12, askSize: 1e12, iv: null, forward: null, delta: null, minPrice: null, maxPrice: null, change24h: null, fundingRate: null, openInterest: null, volume24h: null };
  return { inst: m, ticker: t, dir: "long", risk: 100, leverage: 3, orderType: "market", limitPrice: null, postOnly: false, takeProfit: null, stopLoss: null, slippage: 0.01, headroomMM: null, headroomIM: null, existing: 0, leverageCap: 50, ...over };
};

describe("pair catalogue → markets (recorded testnet + mainnet catalogues)", () => {
  it("keeps USD-quoted pairs, drops upside and inverse pairs, sorted by pair index", () => {
    for (const fx of [testnet, mainnet]) {
      const { markets } = load(fx);
      const names = markets.map((m) => m.name);
      expect(names).toContain("ETH-PERP");
      expect(names).toContain("BTC-PERP");
      expect(names.some((n) => /UPSIDE/.test(n))).toBe(false);
      expect(names).not.toContain("USD-PERP"); // USD/JPY is quoted in JPY
      expect(markets.map((m) => m.pairIndex)).toEqual([...markets.map((m) => m.pairIndex)].sort((a, b) => a - b));
    }
  });
  it("ETH/USD on testnet: $100 minimum position, 0.045% taker / 0.01% maker, 1–50×, spread 0.01%", () => {
    const { m } = eth();
    expect(m.symbol).toBe("ETH/USD");
    expect(m.pairIndex).toBe(0);
    expect(m.minNotional).toBe(100);
    expect(m.takerFeeRate).toBeCloseTo(0.00045, 12);
    expect(m.makerFeeRate).toBeCloseTo(0.0001, 12);
    expect(m.closeTakerFeeRate).toBeCloseTo(0.00045, 12);
    expect(m.minLeverage).toBe(1);
    expect(m.maxLeverage).toBe(50);
    expect(m.imReq).toBeCloseTo(1 / 50, 12);
    expect(m.mmReq).toBeCloseTo((1 - VERANTA_LIQ_THRESHOLD) / 50, 12);
    expect(m.spread).toBeCloseTo(0.0001, 12);
    expect(m.isActive).toBe(true);
  });
  it("tickers are the oracle price ± the pair spread; pairs without a recorded price get no ticker", () => {
    const r = load(testnet);
    const t = r.tickers["ETH-PERP"]!;
    expect(t.mark).toBe(testnet.prices["0"]);
    expect(t.ask).toBeCloseTo(t.mark * 1.0001, 9);
    expect(t.bid).toBeCloseTo(t.mark * 0.9999, 9);
    expect(r.tickers["EUR-PERP"]).toBeUndefined();
  });
  it("closed markets and close-only pairs are inactive; unlisted pairs are dropped", () => {
    const base = testnet.pairs[0] as unknown as VPair;
    const r = marketsFrom(
      [
        { ...base, index: 50, from: "AAA", feed: { attributes: { isOpen: false } } },
        { ...base, index: 51, from: "BBB", additionalPairParams2: { ...base.additionalPairParams2, closeOnlyMode: true } },
        { ...base, index: 52, from: "CCC", isPairListed: false },
      ],
      {},
      NOW,
    );
    expect(r.markets.map((m) => [m.name, m.isActive])).toEqual([
      ["AAA-PERP", false],
      ["BBB-PERP", false],
    ]);
  });
  it("names", () => {
    expect(verantaName({ from: "ETH", to: "USD" })).toBe("ETH-PERP");
    expect(verantaName({ from: "ETH_UPSIDE", to: "USD" })).toBeNull();
    expect(verantaName({ from: "USD", to: "JPY" })).toBeNull();
    expect(verantaName({ from: "1000PEPE", to: "USD" })).toBe("1000PEPE-PERP");
  });
  it("PROPERTY: tickFor gives ≥ 6 significant digits for any positive price", () => {
    fc.assert(
      fc.property(fc.double({ min: 1e-6, max: 1e7, noNaN: true }), (p) => {
        const t = Number(tickFor(p));
        expect(t).toBeGreaterThan(0);
        expect(t / p).toBeLessThanOrEqual(1e-5 + 1e-12);
      }),
    );
  });
});

describe("sizing through the shared quote (money put in × leverage, $100 minimum)", () => {
  it("$100 at 3× on ETH: $300 position, never below Veranta's minimum", () => {
    const { m, px } = eth();
    const r = quotePerp(input(m, px));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.notional).toBeGreaterThan(299);
    expect(r.quote.notional).toBeLessThanOrEqual(300 + 1e-9);
    expect(r.quote.notional).toBeGreaterThanOrEqual(m.minNotional!);
  });
  it("$100 at 1× floors under $100, so the quote sizes up to the minimum and says so", () => {
    const { m, px } = eth();
    const r = quotePerp(input(m, px, { leverage: 1 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.notional).toBeGreaterThanOrEqual(100);
    expect(r.quote.warnings.join(" ")).toContain("Smallest order");
  });
  it("PROPERTY: every quote's notional is ≥ the minimum, and its margin (USDC, 6 dp) × leverage clears the minimum too", () => {
    const { m, px } = eth();
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2000 }), fc.integer({ min: 1, max: 50 }), fc.boolean(), (risk, lev, long) => {
        const r = quotePerp(input(m, px, { risk, leverage: lev, dir: long ? "long" : "short" }));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.quote.notional).toBeGreaterThanOrEqual(m.minNotional!);
        // what the venue sends: collateral rounded DOWN to 6 dp
        expect(Number(usdc6(r.quote.putIn)) * lev + 1e-6).toBeGreaterThanOrEqual(m.minNotional!);
        expect(r.quote.putIn).toBeLessThanOrEqual(Math.max(risk, (m.minNotional! * 1.005) / lev + px * 1e-6) + 1e-6);
      }),
    );
  });
});

describe("open fee: maker or taker by open-interest skew", () => {
  const f = { maker: 0.0001, taker: 0.00045 };
  it("balanced or empty book → taker; adding to the heavy side → taker", () => {
    expect(openFeeRate({ ...f, isLong: true, size: 1, oiLong: 0, oiShort: 0 })).toBe(f.taker);
    expect(openFeeRate({ ...f, isLong: true, size: 1, oiLong: 5, oiShort: 5 })).toBe(f.taker);
    expect(openFeeRate({ ...f, isLong: true, size: 1, oiLong: 10, oiShort: 5 })).toBe(f.taker);
  });
  it("rebalancing without crossing → maker; crossing the middle → blend", () => {
    expect(openFeeRate({ ...f, isLong: false, size: 2, oiLong: 10, oiShort: 5 })).toBe(f.maker);
    const blend = openFeeRate({ ...f, isLong: false, size: 10, oiLong: 10, oiShort: 5 });
    expect(blend).toBeCloseTo((f.maker * 5 + f.taker * 5) / 10, 15);
  });
  it("PROPERTY: the rate is always between maker and taker", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e6, noNaN: true }), fc.double({ min: 0, max: 1e6, noNaN: true }), fc.double({ min: 1e-6, max: 1e6, noNaN: true }), fc.boolean(), (L, S, s, isLong) => {
        const r = openFeeRate({ ...f, isLong, size: s, oiLong: L, oiShort: S });
        expect(r).toBeGreaterThanOrEqual(f.maker - 1e-15);
        expect(r).toBeLessThanOrEqual(f.taker + 1e-15);
      }),
    );
  });
  it("the fee line names what is charged (taker, maker or blend) with the rate read back from the fee", () => {
    const inst = { takerFeeRate: f.taker, makerFeeRate: f.maker, baseFee: 0 } as never;
    expect(feeWords({ estFee: 0.135, notional: 300, inst })).toBe("$0.14 taker · 0.045% + $0.00");
    expect(feeWords({ estFee: 0.03, notional: 300, inst })).toBe("$0.03 maker · 0.01% + $0.00");
    expect(feeWords({ estFee: 0.08, notional: 300, inst })).toContain("maker/taker blend");
  });
});

describe("isolated liquidation (loss reaches 85% of the margin)", () => {
  it("a 5× long from 2500 with $40 margin liquidates 17% lower", () => {
    expect(verantaLiqPrice({ entry: 2500, collateral: 40, leverage: 5, isLong: true })).toBeCloseTo(2500 * (1 - 0.85 / 5), 9);
    expect(verantaLiqPrice({ entry: 2500, collateral: 40, leverage: 5, isLong: false })).toBeCloseTo(2500 * (1 + 0.85 / 5), 9);
  });
  it("accrued fees bring it closer; 1× long never liquidates above 0 only when the room exceeds the price", () => {
    const a = verantaLiqPrice({ entry: 2500, collateral: 40, leverage: 5, isLong: true })!;
    const b = verantaLiqPrice({ entry: 2500, collateral: 40, leverage: 5, isLong: true, accruedFees: 2 })!;
    expect(b).toBeGreaterThan(a);
    expect(verantaLiqPrice({ entry: 2500, collateral: 40, leverage: 0, isLong: true })).toBeNull();
    expect(verantaLiqPrice({ entry: 2500, collateral: 40, leverage: 0.5, isLong: true })).toBeNull(); // would be below 0
  });
  it("PROPERTY: the loss at the liquidation price is exactly 85% of margin less fees", () => {
    fc.assert(
      fc.property(fc.double({ min: 1, max: 1e5, noNaN: true }), fc.double({ min: 1, max: 1e4, noNaN: true }), fc.double({ min: 1.2, max: 500, noNaN: true }), fc.boolean(), (entry, coll, lev, isLong) => {
        const liq = verantaLiqPrice({ entry, collateral: coll, leverage: lev, isLong });
        expect(liq).not.toBeNull();
        const coins = (coll * lev) / entry;
        const loss = isLong ? (entry - liq!) * coins : (liq! - entry) * coins;
        expect(loss).toBeCloseTo(coll * VERANTA_LIQ_THRESHOLD, 6);
      }),
    );
  });
});

describe("USDC amounts", () => {
  it("6 decimals, rounded down, no trailing zeros", () => {
    expect(usdc6(40)).toBe("40");
    expect(usdc6(33.3333339)).toBe("33.333333");
    expect(usdc6(0.1 + 0.2)).toBe("0.3");
    expect(usdc6(0)).toBe("0");
    expect(usdc6(-1)).toBe("0");
  });
  it("PROPERTY: never more than asked, never more than 1 micro-USDC less", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.000001, max: 1e7, noNaN: true }), (x) => {
        const v = Number(usdc6(x));
        expect(v).toBeLessThanOrEqual(x + 1e-6);
        expect(x - v).toBeLessThan(1e-6 + 1e-9 * x);
      }),
    );
  });
});

describe("positions, limit orders and history (raw SDK / API shapes)", () => {
  const { markets, tickers } = load(testnet);
  const byIndex = new Map(markets.map((m) => [m.pairIndex, m]));
  it("a 5× long with $39.91 margin from the live run (scaled 1e6 / 1e10)", () => {
    const [p] = positionsFrom([{ pairIndex: 0, index: 0, buy: true, collateral: "39910000", leverage: "50000000000", openPrice: "25680000000000", tp: "30816000000000", sl: "21828000000000", liquidationPrice: "0", rolloverFee: "0", unrealisedFundingFee: "0" }], byIndex, { "ETH-PERP": 2600 });
    expect(p!.instrument).toBe("ETH-PERP");
    expect(p!.collateral).toBeCloseTo(39.91, 9);
    expect(p!.leverage).toBe(5);
    expect(p!.averagePrice).toBe(2568);
    expect(p!.amount).toBeCloseTo((39.91 * 5) / 2568, 12);
    expect(p!.unrealizedPnl).toBeCloseTo(p!.amount * 32, 9);
    expect(p!.tp).toBe(3081.6);
    expect(p!.sl).toBe(2182.8);
    expect(p!.liquidationPrice).toBeCloseTo(verantaLiqPrice({ entry: 2568, collateral: 39.91, leverage: 5, isLong: true })!, 9); // API sent 0: estimate
  });
  it("short positions are negative; unknown pairs and empty rows are skipped; API liquidation price wins", () => {
    const r = positionsFrom(
      [
        { pairIndex: 0, index: 1, buy: false, collateral: "20000000", leverage: "30000000000", openPrice: "25000000000000", liquidationPrice: "26000000000000" },
        { pairIndex: 999, index: 0, buy: true, collateral: "1", leverage: "1", openPrice: "1" },
        { pairIndex: 0, index: 2, buy: true, collateral: "0", leverage: "1", openPrice: "1" },
      ],
      byIndex,
      {},
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.amount).toBeLessThan(0);
    expect(r[0]!.liquidationPrice).toBe(2600);
    expect(r[0]!.markPrice).toBe(2500); // no mark: open price
  });
  it("limit orders keep their trade index and margin", () => {
    const [o] = limitsFrom([{ pairIndex: 0, index: 3, buy: true, collateral: "25000000", leverage: "50000000000", price: "21800000000000" }], byIndex);
    expect(o).toMatchObject({ orderId: "0:3", instrument: "ETH-PERP", direction: "buy", limitPrice: 2180, tradeIndex: 3, collateral: 25 });
    expect(o!.amount).toBeCloseTo(125 / 2180, 12);
  });
  it("history: opens buy (long) / sell (short), closes the other way with P&L; funding + borrowing as paid", () => {
    const rows: VHistoryRow[] = [
      { timestamp: 200, type: "MARKET_CLOSE", open: false, market: "ETH/USD", side: "long", positionSize: 100, openPrice: 2500, closePrice: 2600, openFee: null, closeFee: 0.045, borrowFee: 0.01, funding: 0.02, netPnl: 3.9, orderId: 2 },
      { timestamp: 100, type: "MARKET_OPEN", open: true, market: "ETH/USD", side: "long", positionSize: 200, openPrice: 2500, closePrice: null, openFee: 0.09, closeFee: null, borrowFee: null, funding: null, netPnl: null, orderId: 1 },
      { timestamp: 300, type: "MARKET_OPEN", open: true, market: "ETH_UPSIDE/USD", side: "long", positionSize: 200, openPrice: 2500, closePrice: null, openFee: 0.09, closeFee: null, borrowFee: null, funding: null, netPnl: null, orderId: 3 },
    ];
    const { trades, funding } = historyFrom(rows);
    expect(trades.map((t) => [t.direction, t.price, t.fee, t.realizedPnl])).toEqual([
      ["buy", 2500, 0.09, null],
      ["sell", 2600, 0.045, 3.9],
    ]);
    expect(trades[1]!.amount).toBeCloseTo(100 / 2500, 12);
    expect(funding).toEqual([{ instrument: "ETH-PERP", funding: -0.03, pnl: 0, timestamp: 200_000 }]);
    expect(tickers["ETH-PERP"]).toBeTruthy();
  });
  it("PROPERTY: a position's coins × open price is exactly margin × leverage", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1e9 }), fc.integer({ min: 1, max: 500 }), fc.integer({ min: 1, max: 1e8 }), fc.boolean(), (coll6, lev, open10k, buy) => {
        const [p] = positionsFrom([{ pairIndex: 0, index: 0, buy, collateral: String(coll6), leverage: String(lev * 1e10), openPrice: String(open10k * 1e6) }], byIndex, {});
        expect(Math.abs(p!.amount) * p!.averagePrice).toBeCloseTo((coll6 / 1e6) * lev, 6);
        expect(Math.sign(p!.amount)).toBe(buy ? 1 : -1);
      }),
    );
  });
});

describe("history API paging (seen live: page 0 is an error, not an empty list)", () => {
  it("asks for page 1 and returns its trades", async () => {
    const calls: [string, number, number][] = [];
    const info = { tradeHistory: async (t: string, p: number, n: number) => (calls.push([t, p, n]), { success: true, trades: [{ type: "MARKET_OPEN" }], count: 1, pageCount: 1 }) };
    expect(await historyPage(info, "0xabc")).toEqual([{ type: "MARKET_OPEN" }]);
    expect(calls).toEqual([["0xabc", 1, 100]]);
  });
  it("a {success:false} answer is an error the card shows, never 'no trades'", async () => {
    const info = { tradeHistory: async () => ({ success: false, errorMessage: "Unable to get the trade history." }) };
    await expect(historyPage(info, "0xabc")).rejects.toThrow("Unable to get the trade history.");
  });
});
