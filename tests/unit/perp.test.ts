// Perp maths: parsers on recorded mainnet + testnet frames, sizing/rounding rules,
// fees, funding, average-cost P&L and the cross-margin liquidation estimate.
// Property tests run with the fixed seed from tests/setup.ts.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import {
  applyFill,
  closeAmount,
  fundingApr,
  fundingPerHour,
  liquidationPrice,
  marketLimit,
  maxLossWords,
  minSize,
  parsePerpInstruments,
  parsePerpTicker,
  parsePerpTickers,
  perpFee,
  perpMaxFee,
  quotePerp,
  sizePerp,
  snapLimit,
  unrealizedPnl,
  type CostBasis,
  type PerpInput,
} from "../../src/lib/perp.ts";
import { toE18 } from "../../src/lib/units.ts";
import { marketArb, mkPerp, mkPerpTicker } from "./perpgen.ts";

type Frame = { method: string; params: Record<string, unknown>; result: unknown };
const load = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/perps-${n}.json`, import.meta.url), "utf8")) as { frames: Frame[] };
const frame = (fx: { frames: Frame[] }, m: string, inst?: string) => fx.frames.find((f) => f.method === m && (!inst || f.params.instrument_name === inst))!.result;
const onStep = (v: string, step: string) => toE18(v) % toE18(step) === 0n;

describe("perp parsers on recorded Derive v3 frames", () => {
  for (const net of ["mainnet", "testnet"]) {
    it(`${net}: every perp instrument parses, ETH first, margin fractions sane`, () => {
      const fx = load(net);
      const raw = (frame(fx, "public/get_all_instruments") as { instruments: unknown[] }).instruments;
      const all = parsePerpInstruments(frame(fx, "public/get_all_instruments"));
      expect(all.length).toBe(raw.filter((r) => (r as { instrument_type: string }).instrument_type === "perp").length);
      expect(all[0]!.name).toBe("ETH-PERP");
      for (const p of all) {
        expect(p.mmReq).toBeGreaterThan(0);
        expect(p.mmReq).toBeLessThanOrEqual(p.imReq);
        expect(p.maxLeverage).toBeGreaterThan(1);
        expect(onStep(minSize(p), p.amountStep)).toBe(true);
      }
      const eth = all.find((p) => p.name === "ETH-PERP")!;
      expect(eth.maxLeverage).toBeCloseTo(1 / eth.imReq, 1);
    });
    it(`${net}: tickers carry mark, index, funding and OI`, () => {
      const fx = load(net);
      const tk = parsePerpTickers(frame(fx, "public/get_tickers"));
      expect(Object.keys(tk).length).toBeGreaterThan(1);
      expect(Object.keys(tk).every((k) => k.endsWith("-PERP"))).toBe(true);
      const eth = parsePerpTicker(frame(fx, "public/get_ticker", "ETH-PERP"))!;
      expect(eth.mark).toBeGreaterThan(100);
      expect(eth.index).toBeGreaterThan(100);
      expect(eth.fundingRate).not.toBeNull();
      expect(eth.openInterest).not.toBeNull();
      expect(eth.bid).toBeLessThanOrEqual(eth.ask);
    });
  }
  it("junk never throws and returns nothing", () => {
    fc.assert(
      fc.property(fc.anything(), (x) => {
        expect(Array.isArray(parsePerpInstruments(x))).toBe(true);
        parsePerpTicker(x);
        expect(typeof parsePerpTickers(x)).toBe("object");
      }),
    );
  });
});

describe("sizing and price rules", () => {
  it("size is on the step, at least the minimum, and never puts in more than asked (unless at the minimum)", () => {
    fc.assert(
      fc.property(marketArb, fc.double({ min: 1, max: 100_000, noNaN: true }), fc.double({ min: 1, max: 15, noNaN: true }), ({ inst, ticker }, risk, lev) => {
        const s = sizePerp(risk, lev, ticker.ask, inst);
        if (!s || s.tooLarge) return;
        expect(onStep(s.amount, inst.amountStep)).toBe(true);
        expect(toE18(s.amount) >= toE18(minSize(inst))).toBe(true);
        const putIn = (Number(s.amount) * ticker.ask) / lev;
        if (!s.belowMinimum) {
          expect(putIn).toBeLessThanOrEqual(risk * (1 + 1e-9));
          // and one more step would exceed it
          expect(((Number(s.amount) + Number(inst.amountStep)) * ticker.ask) / lev).toBeGreaterThan(risk * (1 - 1e-9));
        }
      }),
    );
  });
  it("market protection price: on the tick, inside the band, never better than the touch, at most slip through it", () => {
    fc.assert(
      fc.property(marketArb, fc.constantFrom("buy" as const, "sell" as const), fc.double({ min: 0.0005, max: 0.05, noNaN: true }), ({ inst, ticker }, side, slip) => {
        const lim = marketLimit(side, ticker, inst.tickSize, slip)!;
        expect(onStep(lim, inst.tickSize)).toBe(true);
        const p = Number(lim);
        const tick = Number(inst.tickSize);
        expect(p).toBeLessThanOrEqual(ticker.maxPrice! + tick);
        expect(p).toBeGreaterThanOrEqual(ticker.minPrice! - tick);
        if (side === "buy") expect(p).toBeLessThanOrEqual(ticker.ask * (1 + slip) + tick);
        else expect(p).toBeGreaterThanOrEqual(ticker.bid * (1 - slip) - tick);
      }),
    );
  });
  it("empty side of the book: no market order", () => {
    expect(marketLimit("buy", mkPerpTicker({ ask: 0 }), "0.01", 0.005)).toBeNull();
    expect(marketLimit("sell", mkPerpTicker({ bid: 0 }), "0.01", 0.005)).toBeNull();
  });
  it("a typed limit snaps to the tick and never to a worse price", () => {
    fc.assert(
      fc.property(marketArb, fc.constantFrom("buy" as const, "sell" as const), fc.double({ min: 0.5, max: 1.5, noNaN: true }), ({ inst, ticker }, side, f) => {
        const px = ticker.mark * f;
        const s = snapLimit(side, px, ticker, inst.tickSize);
        if (!s) return;
        expect(onStep(s.price, inst.tickSize)).toBe(true);
        if (side === "buy") expect(Number(s.price)).toBeLessThanOrEqual(px * (1 + 1e-12));
        else expect(Number(s.price)).toBeGreaterThanOrEqual(px * (1 - 1e-12));
        expect(s.inBand).toBe(Number(s.price) <= ticker.maxPrice! && Number(s.price) >= ticker.minPrice!);
      }),
    );
  });
  it("partial close never exceeds the position and stays on the step", () => {
    fc.assert(
      fc.property(fc.double({ min: -1000, max: 1000, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), fc.constantFrom("0.001", "0.01", "0.1"), (pos, f, step) => {
        const a = closeAmount(pos, f, step);
        expect(onStep(a, step)).toBe(true);
        expect(Number(a)).toBeLessThanOrEqual(Math.abs(pos) + 1e-12);
      }),
    );
    expect(closeAmount(0.101, 0.5, "0.001")).toBe("0.05");
    expect(closeAmount(-0.101, 1, "0.001")).toBe("0.101");
  });
});

describe("fees and funding", () => {
  it("taker/maker fee = notional × rate + base fee; zero for nothing", () => {
    const i = mkPerp();
    expect(perpFee(i, 0.1, 2500, false)).toBeCloseTo(0.1 * 2500 * 0.0003 + 0.1, 12);
    expect(perpFee(i, 0.1, 2500, true)).toBeCloseTo(0.1 * 2500 * 0.0001 + 0.1, 12);
    expect(perpFee(i, 0, 2500)).toBe(0);
  });
  it("signed max fee per unit always covers the real fee per unit, with headroom", () => {
    fc.assert(
      fc.property(marketArb, fc.double({ min: 0.001, max: 1000, noNaN: true }), ({ inst, ticker }, n) => {
        const per = Number(perpMaxFee(inst, ticker.index, ticker.ask, n));
        expect(per * n).toBeGreaterThanOrEqual(perpFee(inst, n, ticker.ask) * 1.99);
      }),
    );
  });
  it("funding: positive rate → longs pay, shorts receive; APR = hourly × 8760", () => {
    expect(fundingApr(0.0000125)).toBeCloseTo(0.1095, 10);
    expect(fundingPerHour(1, 2500, 0.0000125)).toBeCloseTo(-0.03125, 12);
    expect(fundingPerHour(-1, 2500, 0.0000125)).toBeCloseTo(0.03125, 12);
    expect(fundingPerHour(1, 2500, -0.0001)).toBeGreaterThan(0);
  });
});

describe("average-cost P&L", () => {
  it("worked example: buy 1 @100, buy 1 @200, sell 1.5 @300, sell 1 @100 (flip)", () => {
    let p: CostBasis = { size: 0, entry: 0 };
    let r = 0;
    for (const [s, a, px] of [["buy", 1, 100], ["buy", 1, 200], ["sell", 1.5, 300], ["sell", 1, 100]] as const) {
      const x = applyFill(p, s, a, px);
      p = x.pos;
      r += x.realized;
    }
    // avg 150; sell 1.5 @300 → +225; sell 0.5 of the rest @100 → −25, then short 0.5 @100
    expect(r).toBeCloseTo(200, 9);
    expect(p.size).toBeCloseTo(-0.5, 9);
    expect(p.entry).toBe(100);
  });
  it("realised + unrealised = cash flow + size × mark (no P&L appears or vanishes)", () => {
    const fill = fc.record({ side: fc.constantFrom("buy" as const, "sell" as const), amount: fc.integer({ min: 1, max: 500 }).map((x) => x / 100), price: fc.integer({ min: 100, max: 500_000 }).map((x) => x / 100) });
    fc.assert(
      fc.property(fc.array(fill, { minLength: 1, maxLength: 30 }), fc.integer({ min: 100, max: 500_000 }).map((x) => x / 100), (fills, mark) => {
        let p: CostBasis = { size: 0, entry: 0 };
        let realized = 0, cash = 0, size = 0;
        for (const f of fills) {
          const x = applyFill(p, f.side, f.amount, f.price);
          p = x.pos;
          realized += x.realized;
          const d = f.side === "buy" ? f.amount : -f.amount;
          size += d;
          cash -= d * f.price;
        }
        const ours = realized + unrealizedPnl(p.size, p.entry, mark);
        const truth = cash + size * mark;
        expect(Math.abs(ours - truth)).toBeLessThan(1e-6 * (1 + Math.abs(truth)));
        expect(Math.abs(p.size - size)).toBeLessThan(1e-9);
      }),
    );
  });
});

describe("cross-margin liquidation estimate", () => {
  it("at the estimated price the maintenance headroom is exactly zero", () => {
    fc.assert(
      fc.property(fc.double({ min: -50, max: 50, noNaN: true }).filter((s) => Math.abs(s) > 1e-3), fc.double({ min: 10, max: 100_000, noNaN: true }), fc.double({ min: 0.001, max: 1e6, noNaN: true }), fc.double({ min: 0.005, max: 0.3, noNaN: true }), (size, price, headroom, mm) => {
        const liq = liquidationPrice({ size, price, headroom, mmReq: mm });
        const at = (P: number) => headroom + size * (P - price) - mm * Math.abs(size) * (P - price);
        if (liq === null) {
          // only a long whose collateral survives the price going to zero has none
          expect(size).toBeGreaterThan(0);
          expect(at(0)).toBeGreaterThan(-1e-6 * (1 + headroom));
          return;
        }
        expect(Math.abs(at(liq))).toBeLessThan(1e-6 * (1 + headroom + Math.abs(size) * price));
        if (size > 0) expect(liq).toBeLessThan(price);
        else expect(liq).toBeGreaterThan(price);
      }),
    );
  });
  it("already past maintenance → liquidation at the current price; flat → none", () => {
    expect(liquidationPrice({ size: 1, price: 2500, headroom: -1, mmReq: 0.05 })).toBe(2500);
    expect(liquidationPrice({ size: 0, price: 2500, headroom: 100, mmReq: 0.05 })).toBeNull();
  });
});

describe("the order builder (quotePerp)", () => {
  const base = (p: Partial<PerpInput> = {}): PerpInput => ({ inst: mkPerp(), ticker: mkPerpTicker(), dir: "long", risk: 100, leverage: 5, orderType: "market", slippage: 0.005, leverageCap: 10, ...p });
  const ok = (p: Partial<PerpInput> = {}) => {
    const r = quotePerp(base(p));
    if (!r.ok) throw new Error(r.reason);
    return r.quote;
  };
  it("“ETH goes UP, risk $100 at 5×”: 0.199 ETH IOC buy, $100-ish put in, liq below, funding paid", () => {
    const q = ok({ headroomMM: 300, headroomIM: 250 });
    expect(q.side).toBe("buy");
    expect(q.tif).toBe("ioc");
    expect(q.amount).toBe("0.199");
    expect(q.putIn).toBeLessThanOrEqual(100);
    expect(q.notional).toBeCloseTo(0.199 * 2500.5, 9);
    expect(q.liqPrice!).toBeLessThan(q.entry);
    expect(q.riskPrice).toBeCloseTo(2500.5 * 0.8, 6);
    expect(q.fundingHourly!).toBeLessThan(0);
    expect(q.fundingApr!).toBeCloseTo(0.1095, 6);
    expect(q.problems).toEqual([]);
    expect(maxLossWords(q, "ETH", 1000)).toMatch(/falls 20\.0%.*liquidates near/);
  });
  it("short mirrors it: sell, liq above, funding received at a positive rate", () => {
    const q = ok({ dir: "short", headroomMM: 300 });
    expect(q.side).toBe("sell");
    expect(q.liqPrice!).toBeGreaterThan(q.entry);
    expect(q.fundingHourly!).toBeGreaterThan(0);
  });
  it("limit = GTC maker; post-only that would cross is blocked; a crossing GTC warns", () => {
    expect(ok({ orderType: "limit", limitPrice: 2450 }).tif).toBe("gtc");
    const po = ok({ orderType: "limit", limitPrice: 2450, postOnly: true });
    expect(po.tif).toBe("post_only");
    expect(po.problems).toEqual([]);
    expect(po.estFee).toBeCloseTo(perpFee(mkPerp(), po.n, 2450, true), 9);
    const cross = ok({ orderType: "limit", limitPrice: 2550, postOnly: true });
    expect(cross.postOnlyWouldCross).toBe(true);
    expect(cross.problems[0]).toMatch(/Post-only/);
    expect(ok({ orderType: "limit", limitPrice: 2550 }).warnings.join()).toMatch(/crosses the book/);
    expect(ok({ orderType: "limit", limitPrice: 2700 }).problems.join()).toMatch(/between/);
  });
  it("leverage cap: the user's setting and the exchange maximum both block", () => {
    expect(ok({ leverage: 8, leverageCap: 5 }).problems.join()).toMatch(/capped at 5× \(your setting\)/);
    expect(ok({ leverage: 20, leverageCap: 50 }).problems.join()).toMatch(/exchange maximum/);
  });
  it("free margin and maintenance checks block; reducing an existing position does not need new margin", () => {
    expect(ok({ headroomIM: 5 }).problems.join()).toMatch(/Not enough free margin/);
    expect(ok({ headroomMM: 1 }).problems.join()).toMatch(/below maintenance/);
    expect(ok({ dir: "short", headroomIM: 5, existing: 1 }).problems.filter((p) => /free margin/.test(p))).toEqual([]);
  });
  it("below the exchange minimum: sized up to the minimum and warned", () => {
    const q = ok({ risk: 5, leverage: 2 });
    expect(q.amount).toBe("0.1");
    expect(q.belowMinimum).toBe(true);
    expect(q.warnings.join()).toMatch(/Smallest order is 0.1 ETH/);
  });
  it("TP/SL must be on the right side of entry; SL past liquidation warns", () => {
    const good = ok({ takeProfit: 3000, stopLoss: 2200, headroomMM: 900 });
    expect(good.problems).toEqual([]);
    expect(good.gainAtTp!).toBeCloseTo(good.n * (3000 - good.entry), 9);
    expect(good.lossAtSl!).toBeCloseTo(good.n * (good.entry - 2200), 9);
    expect(ok({ takeProfit: 2000 }).problems.join()).toMatch(/Take-profit must be above/);
    expect(ok({ dir: "short", stopLoss: 2000 }).problems.join()).toMatch(/Stop-loss must be above/);
    expect(ok({ stopLoss: 100, headroomMM: 50 }).warnings.join()).toMatch(/past the liquidation price/);
  });
  it("a big cushion: no liquidation price, and the words say so", () => {
    const q = ok({ headroomMM: 50_000 });
    expect(q.liqPrice).toBeNull();
    expect(maxLossWords(q, "ETH", 50_000)).toMatch(/would not be liquidated/);
  });
  it("no wallet: names the venue (never a literal ${venue} placeholder)", () => {
    const q = ok({ headroomMM: 50_000 });
    for (const v of ["Derive", "Hyperliquid", "Veranta"]) {
      const w = maxLossWords(q, "ETH", null, v);
      expect(w).toContain(`Connect a wallet to see where ${v} would liquidate.`);
      expect(w).not.toContain("${");
    }
    expect(maxLossWords(q, "ETH", null)).toContain("where Derive would liquidate");
  });
  it("touch outside the exchange band: the protected market order is flagged as unlikely to fill", () => {
    const q = ok({ ticker: mkPerpTicker({ ask: 2650, maxPrice: 2600 }) });
    expect(Number(q.limitPrice)).toBeLessThanOrEqual(2600);
    expect(q.warnings.join()).toMatch(/outside the price band/);
  });
  it("no book / inactive / no price → a reason, never a quote", () => {
    expect(quotePerp(base({ ticker: mkPerpTicker({ ask: 0 }) }))).toEqual({ ok: false, reason: "no-book" });
    expect(quotePerp(base({ inst: mkPerp({ isActive: false }) }))).toEqual({ ok: false, reason: "inactive" });
    expect(quotePerp(base({ ticker: mkPerpTicker({ mark: 0, index: 0 }) }))).toEqual({ ok: false, reason: "no-price" });
  });
  it("any market and inputs: amount on the step, limit on the tick, fees ≥ 0, never throws", () => {
    fc.assert(
      fc.property(
        marketArb,
        fc.record({ dir: fc.constantFrom("long" as const, "short" as const), risk: fc.double({ min: 0.5, max: 50_000, noNaN: true }), lev: fc.double({ min: 1, max: 20, noNaN: true }), limit: fc.boolean(), lf: fc.double({ min: 0.8, max: 1.2, noNaN: true }), po: fc.boolean(), hm: fc.option(fc.double({ min: -100, max: 1e6, noNaN: true })) }),
        ({ inst, ticker }, x) => {
          const r = quotePerp({ inst, ticker, dir: x.dir, risk: x.risk, leverage: x.lev, orderType: x.limit ? "limit" : "market", limitPrice: ticker.mark * x.lf, postOnly: x.po, slippage: 0.005, leverageCap: 10, headroomMM: x.hm, headroomIM: x.hm });
          if (!r.ok) return;
          const q = r.quote;
          expect(onStep(q.amount, inst.amountStep)).toBe(true);
          expect(onStep(q.limitPrice, inst.tickSize)).toBe(true);
          expect(q.estFee).toBeGreaterThanOrEqual(0);
          expect(q.worstFee).toBeGreaterThanOrEqual(q.estFee - 1e-9);
          if (q.orderType === "market") expect(q.side === "buy" ? Number(q.limitPrice) >= q.entry - Number(inst.tickSize) : Number(q.limitPrice) <= q.entry + Number(inst.tickSize)).toBe(true);
          if (x.lev > 10 + 1e-9 || x.lev > inst.maxLeverage + 1e-9) expect(q.problems.some((p) => /capped/.test(p))).toBe(true);
          expect(typeof maxLossWords(q, inst.currency, x.hm ?? null)).toBe("string");
        },
      ),
    );
  });
});
