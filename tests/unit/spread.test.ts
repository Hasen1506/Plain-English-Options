import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { chainArb, mkInst, mkTicker, NOW } from "./gen.ts";
import { maxFeePerUnit, protectiveLimit, quoteSpread, selectSpread, sizeContracts, tradable } from "../../src/lib/spread.ts";
import { isAligned, toE18 } from "../../src/lib/units.ts";
import { profitAt, spreadValue } from "../../src/lib/payoff.ts";

const dirArb = fc.constantFrom("up" as const, "down" as const);
const moveArb = fc.double({ min: 0.001, max: 1.5, noNaN: true });
const profitArb = fc.double({ min: 1, max: 200_000, noNaN: true });

describe("spread selection (property)", () => {
  it("brackets correctly and never uses an expired, deactivated, inactive or unpriced instrument", () => {
    fc.assert(
      fc.property(chainArb, dirArb, moveArb, (c, dir, mv) => {
        const target = dir === "up" ? c.spot * (1 + mv) : c.spot * Math.max(0.01, 1 - mv * 0.6);
        const r = selectSpread(c.instruments, c.tickers, c.spot, target, dir, "20261127", NOW);
        if (!r.ok) return true;
        const { long, short, K1, K2 } = r.legs;
        for (const l of [long, short]) {
          expect(l.instrument.isActive).toBe(true);
          expect(l.instrument.expiry * 1000).toBeGreaterThan(NOW);
          expect(l.instrument.deactivation * 1000).toBeGreaterThan(NOW);
          expect(c.tickers[l.instrument.name]).toBeDefined();
          expect(l.instrument.type).toBe(dir === "up" ? "C" : "P");
        }
        if (dir === "up") {
          expect(K1).toBeLessThanOrEqual(c.spot);
          expect(K2).toBeGreaterThan(c.spot);
          expect(K1).toBeLessThan(K2);
        } else {
          expect(K1).toBeGreaterThanOrEqual(c.spot);
          expect(K2).toBeLessThan(c.spot);
          expect(K1).toBeGreaterThan(K2);
        }
        return true;
      }),
      { numRuns: 3000 },
    );
  });

  it("rejects a target on the wrong side of spot", () => {
    fc.assert(
      fc.property(chainArb, dirArb, moveArb, (c, dir, mv) => {
        const target = dir === "up" ? c.spot * Math.max(0.01, 1 - mv * 0.6) : c.spot * (1 + mv);
        const r = selectSpread(c.instruments, c.tickers, c.spot, target, dir, "20261127", NOW);
        return !r.ok && r.reason === "wrong-side";
      }),
      { numRuns: 1000 },
    );
  });
});

describe("spread quote (property)", () => {
  it("cost ≥ 0, size on step and ≥ minimum, tick-aligned prices, max loss = debit + fees, payoff ≤ width − debit", () => {
    let quoted = 0;
    fc.assert(
      fc.property(chainArb, dirArb, moveArb, profitArb, (c, dir, mv, want) => {
        const target = dir === "up" ? c.spot * (1 + mv) : c.spot * Math.max(0.01, 1 - mv * 0.6);
        const s = selectSpread(c.instruments, c.tickers, c.spot, target, dir, "20261127", NOW);
        if (!s.ok) return true;
        const r = quoteSpread(s.legs, want);
        if (!r.ok) return true;
        quoted++;
        const q = r.quote;
        expect(q.cost).toBeGreaterThan(0);
        expect(q.debit).toBeGreaterThan(0);
        expect(q.fees).toBeGreaterThanOrEqual(0);
        expect(isAligned(q.amount, s.legs.long.instrument.amountStep)).toBe(true);
        expect(toE18(q.amount) >= toE18(s.legs.long.instrument.minAmount)).toBe(true);
        expect(isAligned(q.longPrice, s.legs.long.instrument.tickSize)).toBe(true);
        expect(isAligned(q.shortPrice, s.legs.short.instrument.tickSize)).toBe(true);
        expect(isAligned(q.longLimit, s.legs.long.instrument.tickSize)).toBe(true);
        expect(isAligned(q.shortLimit, s.legs.short.instrument.tickSize)).toBe(true);
        expect(Number(q.longLimit)).toBeGreaterThanOrEqual(Number(q.longPrice));
        expect(Number(q.shortLimit)).toBeLessThanOrEqual(Number(q.shortPrice));
        expect(q.worstLoss).toBeGreaterThanOrEqual(q.maxLoss - 1e-9);
        expect(q.maxLoss).toBeCloseTo(q.n * q.debit + q.fees, 6);
        expect(Math.abs(q.cost - q.n * (Number(q.longPrice) - Number(q.shortPrice)))).toBeLessThan(1e-6 * Math.max(1, q.cost));
        // the user gets at least what they asked for (fees included), unless the exchange minimum forced a bigger size
        if (!q.belowMinimum) expect(q.maxProfit).toBeGreaterThanOrEqual(want - 1e-6 * want);
        // payoff per contract never exceeds width − debit, and the loss is bounded by max loss
        const spec = { dir, K1: s.legs.K1, K2: s.legs.K2, n: q.n, cost: q.cost, fees: q.fees };
        for (const x of [0, s.legs.K1, s.legs.K2, (s.legs.K1 + s.legs.K2) / 2, c.spot, s.legs.K2 * 3]) {
          expect(spreadValue(spec, x) - q.debit).toBeLessThanOrEqual(s.legs.width - q.debit + 1e-9);
          expect(profitAt(spec, x)).toBeGreaterThanOrEqual(-q.maxLoss - 1e-6);
          expect(profitAt(spec, x)).toBeLessThanOrEqual(q.maxProfit + 1e-6);
        }
        return true;
      }),
      { numRuns: 4000 },
    );
    expect(quoted).toBeGreaterThan(200); // the generator really exercises the quote path
  });

  it("refuses when the buy leg has no price, and flags mark-only books", () => {
    const L = mkInst({ strike: 2500, type: "C" }), S = mkInst({ strike: 3000, type: "C" });
    const legs = (ta: number, tb: number) => ({
      dir: "up" as const,
      long: { instrument: L, ticker: mkTicker({ ask: ta, mark: 200 }), side: "buy" as const },
      short: { instrument: S, ticker: mkTicker({ bid: tb, mark: 50 }), side: "sell" as const },
      K1: 2500,
      K2: 3000,
      width: 500,
    });
    const r = quoteSpread(legs(0, 49), 1000);
    expect(r.ok && r.quote.priced).toBe("mark");
    expect(quoteSpread(legs(234, 58), 1000).ok && quoteSpread(legs(234, 58), 1000)).toMatchObject({ quote: { priced: "book" } });
    const noEdge = quoteSpread(legs(600, 10), 1000);
    expect(noEdge).toEqual({ ok: false, reason: "no-edge" });
  });

  it("reproduces the first real testnet trade (ETH 2600/2700 Oct-16, size 1)", () => {
    const L = mkInst({ strike: 2600, type: "C", expiryKey: "20261016" }), S = mkInst({ strike: 2700, type: "C", expiryKey: "20261016" });
    const r = quoteSpread(
      { dir: "up", long: { instrument: L, ticker: mkTicker({ ask: 51.5, index: 2575.3 }), side: "buy" }, short: { instrument: S, ticker: mkTicker({ bid: 17.7, index: 2575.3 }), side: "sell" }, K1: 2600, K2: 2700, width: 100 },
      63.6, // the profit that 1 contract pays after fees
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.debit).toBeCloseTo(33.8, 9);
    // the real fills were charged 1.2726 per leg for 1 contract; our estimate for n=1 must match
    expect(r.quote.amount).toBe("1");
    expect(r.quote.fees).toBeCloseTo(2 * (0.0003 * 2575.3 + 0.5), 6);
  });
});

describe("helpers", () => {
  it("sizeContracts is a step multiple ≥ minimum, or null above the maximum", () => {
    fc.assert(
      fc.property(fc.double({ min: 1e-6, max: 1e6, noNaN: true }), fc.constantFrom("0.01", "0.1", "1"), fc.constantFrom("0.01", "0.1", "0.5", "1"), (x, step, min) => {
        const r = sizeContracts(x, mkInst({ strike: 1, type: "C", amountStep: step, minAmount: min, maxAmount: "10000" }));
        if (!r) return x > 10000;
        return isAligned(r.amount, step) && toE18(r.amount) >= toE18(min) && Number(r.amount) >= Math.min(x, Number(r.amount));
      }),
      { numRuns: 5000 },
    );
  });
  it("protective limits are tick-aligned, positive and inside the exchange band", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.0001, max: 5e4, noNaN: true }), fc.double({ min: 0, max: 0.9, noNaN: true }), fc.constantFrom("0.0001", "0.01", "0.1", "1"), fc.constantFrom("buy" as const, "sell" as const), (mark, slip, tick, side) => {
        const inst = mkInst({ strike: 1, type: "C", tickSize: tick });
        const t = mkTicker({ mark, bid: mark * 0.95, ask: mark * 1.05, minPrice: Math.max(Number(tick), mark * 0.5), maxPrice: mark * 2 + 10 * Number(tick) });
        const p = protectiveLimit(side, t, inst, slip);
        expect(isAligned(p, tick)).toBe(true);
        expect(Number(p)).toBeGreaterThan(0);
        if (side === "sell") expect(Number(p)).toBeGreaterThanOrEqual(t.minPrice! - 1e-12);
        else expect(Number(p)).toBeLessThanOrEqual(t.maxPrice! + 1e-12);
      }),
      { numRuns: 3000 },
    );
  });
  it("maxFeePerUnit covers the exchange's minimum (2 × rate × max(index, price) + base fee ÷ amount)", () => {
    // testnet: amount 0.1 @ index 2581 required ≥ 6.548 per unit
    expect(Number(maxFeePerUnit(mkInst({ strike: 1, type: "C" }), 2581.6, 113.8, 0.1))).toBeGreaterThanOrEqual(6.548);
    fc.assert(
      fc.property(fc.double({ min: 0.01, max: 2e5, noNaN: true }), fc.double({ min: 0, max: 1e4, noNaN: true }), fc.double({ min: 0.01, max: 1e4, noNaN: true }), (idx, px, amt) => {
        const inst = mkInst({ strike: 1, type: "C" });
        return Number(maxFeePerUnit(inst, idx, px, amt)) >= 2 * inst.takerFeeRate * Math.max(idx, px) + inst.baseFee / amt;
      }),
      { numRuns: 2000 },
    );
  });
  it("tradable filters by expiry key, type and liveness", () => {
    const a = mkInst({ strike: 1, type: "C" }), b = mkInst({ strike: 1, type: "P" }), c = mkInst({ strike: 2, type: "C", isActive: false });
    expect(tradable([a, b, c], "20261127", "up", NOW)).toEqual([a]);
    expect(tradable([a, b, c], "20261127", "down", NOW)).toEqual([b]);
    expect(tradable([a], "20261127", "up", a.expiry * 1000 + 1)).toEqual([]);
  });
});
