// Hyperliquid sizing, rounding, parsing and order building: unit + fast-check properties.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import mainnet from "../fixtures/hyperliquid/mainnet.json" with { type: "json" };
import testnet from "../fixtures/hyperliquid/testnet.json" with { type: "json" };
import { lotSize, meetsMinimum, minSizeFor, priceStep, roundPrice, roundSize, sigFigs, toWire, validPrice, validSize } from "../../src/venues/hyperliquid/rules.ts";
import { applyBook, exchangeStatuses, hlName, parseClearinghouse, parseFills, parseMeta, parseOpenOrders, parseStatus, parseUserFees, parseUserFunding, triggerOrders } from "../../src/venues/hyperliquid/parse.ts";
import { closeOrder, entryOrders, hlLeverage, iocNoFill, outcome, wire } from "../../src/venues/hyperliquid/orders.ts";
import { quotePerp } from "../../src/lib/perp.ts";

const frame = (fx: { frames: { req: { type: string; coin?: string }; res: unknown }[] }, type: string, coin?: string) => fx.frames.find((f) => f.req.type === type && (!coin || f.req.coin === coin))!.res;

describe("price and size rules (docs: tick-and-lot-size)", () => {
  it("accepts and rejects the docs' own examples", () => {
    expect(validPrice("1234.5", 0)).toBe(true);
    expect(validPrice("1234.56", 0)).toBe(false); // 6 significant figures
    expect(validPrice("0.001234", 0)).toBe(true);
    expect(validPrice("0.0012345", 0)).toBe(false); // > 6 decimals
    expect(validPrice("0.01234", 1)).toBe(true);
    expect(validPrice("0.012345", 1)).toBe(false); // > 6 − szDecimals decimals
    expect(validPrice("123456", 3)).toBe(true); // integers always allowed
    expect(validSize("1.001", 3)).toBe(true);
    expect(validSize("1.0001", 3)).toBe(false);
  });
  it("wire format drops trailing zeros", () => {
    expect(toWire("1.2300")).toBe("1.23");
    expect(toWire("5.0")).toBe("5");
    expect(toWire("0.000")).toBe("0");
    expect(sigFigs("0.00012340")).toBe(5);
  });
  it("lot size and steps", () => {
    expect(lotSize(0)).toBe("1");
    expect(lotSize(4)).toBe("0.0001");
    expect(priceStep(2563.3, 4)).toBe("0.1");
    expect(priceStep(82674, 5)).toBe("1");
    expect(priceStep(114.99, 2)).toBe("0.01");
    expect(priceStep(0.1996, 0)).toBe("0.00001");
    expect(priceStep(0.000012, 0)).toBe("0.000001"); // capped at 6 decimals
  });
  it("PROPERTY: roundPrice always returns a valid price on the requested side of the input, within one step", () => {
    fc.assert(
      fc.property(fc.double({ min: 1e-5, max: 2e6, noNaN: true }), fc.integer({ min: 0, max: 5 }), (px, sz) => {
        const d = roundPrice(px, sz, "down"), u = roundPrice(px, sz, "up");
        expect(validPrice(d, sz)).toBe(true);
        expect(validPrice(u, sz)).toBe(true);
        expect(Number(u)).toBeGreaterThanOrEqual(Number(d));
        const minStep = 10 ** -(6 - sz);
        if (px >= minStep) {
          expect(Number(d)).toBeLessThanOrEqual(px * (1 + 1e-12));
          expect(Number(u)).toBeGreaterThanOrEqual(px * (1 - 1e-12));
          // one step of 5 significant figures is at most 1e-4 relative (or the decimals cap)
          expect((Number(u) - Number(d)) / px).toBeLessThanOrEqual(Math.max(1.0001e-4 * 10, (10 * minStep) / px));
        }
      }),
      { numRuns: 2000 },
    );
  });
  it("PROPERTY: sizes floor to the lot and never exceed the input", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e6, noNaN: true }), fc.integer({ min: 0, max: 6 }), (sz, d) => {
        const s = roundSize(sz, d);
        expect(Number(s)).toBeLessThanOrEqual(sz + 1e-9);
        expect(sz - Number(s)).toBeLessThan(10 ** -d + 1e-9);
        if (Number(s) > 0) expect(validSize(s, d)).toBe(true);
      }),
      { numRuns: 1500 },
    );
  });
  it("PROPERTY: the $10 minimum size really is ≥ $10 at that price", () => {
    fc.assert(
      fc.property(fc.double({ min: 1e-4, max: 2e5, noNaN: true }), fc.integer({ min: 0, max: 5 }), (px, d) => {
        const m = minSizeFor(px, d);
        expect(meetsMinimum(m, String(px))).toBe(true);
        expect(validSize(m, d)).toBe(true);
      }),
      { numRuns: 1500 },
    );
  });
});

describe("parsing recorded frames (mainnet + testnet, 2026-10-08)", () => {
  const m = parseMeta(frame(mainnet, "metaAndAssetCtxs"));
  const t = parseMeta(frame(testnet, "metaAndAssetCtxs"));
  it("lists perps with asset ids, szDecimals and max leverage; ETH then BTC first", () => {
    expect(m.markets.length).toBeGreaterThan(100);
    expect(t.markets.length).toBeGreaterThan(50);
    expect(m.markets[0]!.name).toBe("ETH-PERP");
    expect(m.markets[1]!.name).toBe("BTC-PERP");
    const eth = m.markets[0]!;
    expect(eth.asset).toMatchObject({ index: 1, coin: "ETH", szDecimals: 4 });
    expect(eth.amountStep).toBe("0.0001");
    expect(eth.imReq).toBeCloseTo(1 / eth.maxLeverage, 12);
    expect(eth.mmReq).toBeCloseTo(eth.imReq / 2, 12); // docs: maintenance = half the initial margin at max leverage
    expect(eth.takerFeeRate).toBe(0.00045);
    expect(eth.makerFeeRate).toBe(0.00015);
    // asset ids are the index in the full universe, delisted included
    const raw = (frame(mainnet, "metaAndAssetCtxs") as [{ universe: { name: string }[] }])[0].universe;
    for (const mk of m.markets.slice(0, 30)) expect(raw[mk.asset.index]!.name).toBe(mk.asset.coin);
  });
  it("skips delisted coins", () => {
    const raw = (frame(mainnet, "metaAndAssetCtxs") as [{ universe: { name: string; isDelisted?: boolean }[] }])[0].universe;
    const delisted = raw.filter((u) => u.isDelisted).map((u) => hlName(u.name));
    expect(delisted.length).toBeGreaterThan(0);
    for (const d of delisted) expect(m.markets.some((x) => x.name === d)).toBe(false);
  });
  it("tickers: mark, oracle index, hourly funding, OI, 24h change", () => {
    const e = m.tickers["ETH-PERP"]!;
    expect(e.mark).toBeGreaterThan(100);
    expect(e.index).toBeGreaterThan(100);
    expect(Math.abs(e.fundingRate!)).toBeLessThan(0.01);
    expect(e.openInterest!).toBeGreaterThan(0);
    expect(e.change24h).not.toBeNull();
    const b = applyBook(e, frame(mainnet, "l2Book", "ETH"));
    expect(b.bid).toBeLessThan(b.ask);
    expect(b.bidSize).toBeGreaterThan(0);
    expect(b.ask - b.bid).toBeLessThan(e.mark * 0.01);
  });
  it("account: value, free and maintenance headroom, positions with liq price and funding sign", () => {
    const st = parseClearinghouse(frame(mainnet, "clearinghouseState"))!;
    expect(st.account.id).toBe(0);
    expect(st.account.value).toBeGreaterThan(0);
    expect(st.account.maintenanceMargin).toBeLessThanOrEqual(st.account.value);
    expect(st.account.positions.length).toBeGreaterThan(0);
    const raw = (frame(mainnet, "clearinghouseState") as { assetPositions: { position: { coin: string; szi: string; cumFunding: { sinceOpen: string } } }[] }).assetPositions;
    for (const p of st.account.positions) {
      const r = raw.find((x) => hlName(x.position.coin) === p.instrument)!;
      expect(p.amount).toBe(Number(r.position.szi));
      expect(p.cumulativeFunding).toBe(-Number(r.position.cumFunding.sinceOpen)); // exchange "+ = paid" → app "+ = received"
    }
  });
  it("funding events: a long pays when the rate is positive (usdc < 0)", () => {
    const f = parseUserFunding(frame(mainnet, "userFunding"));
    expect(f.length).toBeGreaterThan(0);
    const raw = frame(mainnet, "userFunding") as { delta: { usdc: string; szi: string; fundingRate: string } }[];
    for (const r of raw) {
      const s = Number(r.delta.szi), rate = Number(r.delta.fundingRate), usdc = Number(r.delta.usdc);
      if (Math.abs(usdc) > 1e-6 && rate !== 0) expect(Math.sign(usdc)).toBe(-Math.sign(s * rate));
    }
  });
  it("fills and open orders", () => {
    const fills = parseFills(frame(mainnet, "userFills"));
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.every((f) => f.instrument.endsWith("-PERP") && (f.direction === "buy" || f.direction === "sell"))).toBe(true);
    const oo = parseOpenOrders(frame(mainnet, "frontendOpenOrders"));
    expect(oo.length).toBeGreaterThan(0);
    expect(triggerOrders(oo).every((x) => x.status === "untriggered")).toBe(true);
    expect(parseUserFees({ userCrossRate: "0.00045", userAddRate: "0.00015" })).toEqual({ taker: 0.00045, maker: 0.00015 });
    expect(parseUserFees({ userCrossRate: "junk" })).toBeNull();
  });
  it("never throws on junk", () => {
    fc.assert(
      fc.property(fc.anything(), (x) => {
        parseMeta(x);
        parseClearinghouse(x);
        parseFills(x);
        parseUserFunding(x);
        parseOpenOrders(x);
        parseStatus(x);
      }),
      { numRuns: 300 },
    );
  });
});

describe("order building", () => {
  const { markets, tickers } = parseMeta(frame(mainnet, "metaAndAssetCtxs"));
  const eth = markets.find((x) => x.name === "ETH-PERP")!;
  const ethT = applyBook(tickers["ETH-PERP"]!, frame(mainnet, "l2Book", "ETH"));
  it("a market long becomes an IOC at a valid price no looser than the shown protection", () => {
    const r = quotePerp({ inst: eth, ticker: ethT, dir: "long", risk: 50, leverage: 3, orderType: "market", slippage: 0.005, leverageCap: 10 });
    expect(r.ok).toBe(true);
    const q = r.ok ? r.quote : null!;
    const { wires, grouping } = entryOrders(eth.asset, q);
    expect(grouping).toBe("na");
    expect(wires[0]).toMatchObject({ a: 1, b: true, r: false, t: { limit: { tif: "Ioc" } } });
    expect(Number(wires[0]!.p)).toBeLessThanOrEqual(Number(q.limitPrice));
    expect(Number(wires[0]!.p)).toBeGreaterThan(ethT.ask);
  });
  it("TP/SL ride along as reduce-only market triggers (normalTpsl)", () => {
    const r = quotePerp({ inst: eth, ticker: ethT, dir: "short", risk: 50, leverage: 2, orderType: "limit", limitPrice: ethT.ask * 1.01, postOnly: true, takeProfit: ethT.mark * 0.9, stopLoss: ethT.mark * 1.1, slippage: 0.005, leverageCap: 10 });
    const q = r.ok ? r.quote : null!;
    const { wires, grouping } = entryOrders(eth.asset, q);
    expect(grouping).toBe("normalTpsl");
    expect(wires[0]!.t).toEqual({ limit: { tif: "Alo" } });
    expect(wires[1]).toMatchObject({ b: true, r: true, t: { trigger: { isMarket: true, tpsl: "tp" } } });
    expect(wires[2]).toMatchObject({ b: true, r: true, t: { trigger: { isMarket: true, tpsl: "sl" } } });
    expect(wires[1]!.s).toBe(wires[0]!.s);
  });
  it("refuses orders below $10", () => {
    expect(() => entryOrders(eth.asset, { side: "buy", amount: "0.002", limitPrice: "2500", tif: "gtc", takeProfit: null, stopLoss: null })).toThrow(/minimum order is \$10/);
  });
  it("PROPERTY: every built order passes the exchange's price/size rules and the $10 minimum", () => {
    fc.assert(
      fc.property(fc.constantFrom(...markets.slice(0, 40)), fc.double({ min: 12, max: 5000, noNaN: true }), fc.integer({ min: 1, max: 10 }), fc.constantFrom("long", "short"), fc.constantFrom("market", "limit"), (mk, risk, lev, dir, ot) => {
        const tk = tickers[mk.name];
        if (!tk || !(tk.mark > 0)) return;
        const r = quotePerp({ inst: mk, ticker: tk, dir: dir as "long", risk, leverage: Math.min(lev, mk.maxLeverage), orderType: ot as "market", limitPrice: tk.mark, slippage: 0.005, leverageCap: 50 });
        if (!r.ok) return;
        let built;
        try {
          built = entryOrders(mk.asset, r.quote);
        } catch (e) {
          expect(String(e)).toMatch(/minimum order is \$10/);
          return;
        }
        for (const w of built.wires) {
          expect(validPrice(w.p, mk.asset.szDecimals)).toBe(true);
          expect(validSize(w.s, mk.asset.szDecimals)).toBe(true);
        }
        expect(meetsMinimum(built.wires[0]!.s, built.wires[0]!.p)).toBe(true);
      }),
      { numRuns: 600 },
    );
  });
  it("closes are reduce-only IOCs on the opposite side", () => {
    expect(closeOrder(eth.asset, 0.5, "0.25", ethT.bid, 0.005)).toMatchObject({ b: false, r: true, s: "0.25", t: { limit: { tif: "Ioc" } } });
    expect(closeOrder(eth.asset, -0.5, "0.5", ethT.ask, 0.005)).toMatchObject({ b: true, r: true });
    expect(() => wire(eth.asset, true, "2563.33", "0.1", false, { limit: { tif: "Gtc" } })).toThrow(/not a valid/);
  });
  it("leverage is a whole number within the asset's maximum", () => {
    expect(hlLeverage(2.5, 25)).toBe(2);
    expect(hlLeverage(0.5, 25)).toBe(1);
    expect(hlLeverage(60, 25)).toBe(25);
  });
  it("maps exchange statuses to outcomes", () => {
    const w = wire(eth.asset, true, "2600", "0.01", false, { limit: { tif: "Ioc" } });
    expect(outcome(eth.asset, w, { filled: { totalSz: "0.01", avgPx: "2563.3", oid: 7 } })).toMatchObject({ status: "filled", filled: 0.01, avgPrice: 2563.3, orderId: "7" });
    expect(outcome(eth.asset, w, { filled: { totalSz: "0.004", avgPx: "2563.3", oid: 7 } }).status).toBe("partial");
    expect(outcome(eth.asset, w, { resting: { oid: 9 } })).toMatchObject({ status: "open", orderId: "9" });
    expect(iocNoFill(outcome(eth.asset, w, { error: "Order could not immediately match against any resting orders. asset=1" })).status).toBe("cancelled");
    expect(() => exchangeStatuses({ status: "err", response: "User or API Wallet 0xabc does not exist." })).toThrow(/does not exist/);
  });
});
