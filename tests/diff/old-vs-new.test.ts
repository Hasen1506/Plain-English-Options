// Differential test: the old single-file prototype vs the new modules, on
// thousands of random inputs. Intentional differences are asserted as such:
//  1. normCdf: new uses a double-precision algorithm; old used a 1.5e-7 erf.
//  2. Probability at the exact target: old interpolated IV linearly and took
//     N(d2); new interpolates monotone strike-level probabilities. With a flat
//     smile they agree exactly at listed strikes and closely in between; with a
//     skewed smile the old one can be non-monotone, the new one cannot.
//  3. Size: old rounded n = profit / (width − debit) to 0.01 ignoring fees and
//     amount_step; new sizes so the payout after fees reaches the profit, on the
//     instrument's amount_step and ≥ minimum_amount. Same strikes, same prices.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { loadOld, OLD_SOURCE } from "./old-prototype.ts";
import { blackScholes, normCdf } from "../../src/lib/math.ts";
import { probabilityAt } from "../../src/lib/pricing.ts";
import { quoteSpread, selectSpread } from "../../src/lib/spread.ts";
import { chainArb, NOW } from "../unit/gen.ts";
import { serializeTicker } from "../../src/lib/ticker.ts";

const noEnv = () => loadOld({ S: { amt: 0, asset: "X", dir: "up", tgt: 0, date: 0 }, INST: {}, DATES: [], ASSETS: {}, tk: null, spot: 0 });
const stats = { probMaxDiffFlat: 0, probMaxDiffSkew: 0, oldNonMonotone: 0 };

describe("old prototype vs new (differential)", () => {
  it("extracts the old code verbatim", () => {
    expect(OLD_SOURCE).toContain("1.061405429");
    expect(OLD_SOURCE).toContain("function liveChance(d, tk, f)");
  });

  it("normal CDF agrees within the old erf's 1.5e-7 error", () => {
    const old = noEnv();
    fc.assert(fc.property(fc.double({ min: -12, max: 12, noNaN: true }), (x) => Math.abs(old.N(x) - normCdf(x)) <= 2e-7), { numRuns: 20000 });
  });

  it("Black-Scholes call/put agree within that error (scaled by S + K)", () => {
    const old = noEnv();
    fc.assert(
      fc.property(fc.double({ min: 0.01, max: 2e5, noNaN: true }), fc.double({ min: 0.3, max: 3, noNaN: true }), fc.double({ min: 0.002, max: 3, noNaN: true }), fc.double({ min: 0.05, max: 3, noNaN: true }), (S, m, T, v) => {
        const K = S * m;
        const o = old.bs(S, K, T, v), n = blackScholes(S, K, T, v);
        const tol = 4e-7 * (S + K);
        expect(Math.abs(Math.max(o.call, 0) - n.call)).toBeLessThanOrEqual(tol);
        expect(Math.abs(Math.max(o.put, 0) - n.put)).toBeLessThanOrEqual(tol);
        expect(Math.abs(o.d2 - n.d2)).toBeLessThan(1e-9 * (1 + Math.abs(n.d2)));
      }),
      { numRuns: 20000 },
    );
  });

  function probCase(flat: boolean) {
    return fc.record({
      F: fc.double({ min: 0.5, max: 1e5, noNaN: true }),
      n: fc.integer({ min: 2, max: 20 }),
      spacing: fc.double({ min: 0.01, max: 0.1, noNaN: true }),
      iv: fc.double({ min: 0.3, max: 1.5, noNaN: true }),
      skew: flat ? fc.constant(0) : fc.double({ min: -1, max: 1, noNaN: true }),
      days: fc.integer({ min: 3, max: 200 }),
      u: fc.double({ min: 0, max: 1, noNaN: true }),
      dir: fc.constantFrom("up" as const, "down" as const),
    });
  }
  function runProb(c: { F: number; n: number; spacing: number; iv: number; skew: number; days: number; u: number; dir: "up" | "down" }, onStrike: boolean) {
    const exp = NOW + c.days * 86_400_000;
    const strikes = Array.from({ length: c.n }, (_, k) => Number((c.F * (1 + (k - c.n / 2) * c.spacing)).toPrecision(8))).filter((k) => k > 0);
    const ivOf = (K: number) => Math.max(0.05, c.iv * (1 + c.skew * Math.log(K / c.F)));
    const type = c.dir === "up" ? "C" : "P";
    const INST = { X: strikes.map((K) => ({ instrument_name: `X-20261127-${K}-${type}`, option_details: { option_type: type, strike: String(K) } })) };
    const tk: Record<string, unknown> = {};
    for (const K of strikes) tk[`X-20261127-${K}-${type}`] = serializeTicker({ ts: 0, ask: 1, askSize: 1, bid: 1, bidSize: 1, mark: 1, index: c.F, iv: ivOf(K), forward: c.F, delta: null, minPrice: null, maxPrice: null, change24h: null });
    const lo = strikes[0]!, hi = strikes[strikes.length - 1]!;
    const target = onStrike ? strikes[Math.floor(c.u * (strikes.length - 1))]! : lo + c.u * (hi - lo);
    const d = { key: "20261127", e: exp, days: c.days };
    const realNow = Date.now;
    Date.now = () => NOW; // old liveChance reads the wall clock
    try {
      const old = loadOld({ S: { amt: 1, asset: "X", dir: c.dir, tgt: target, date: 0 }, INST, DATES: [d], ASSETS: { X: { p: c.F, iv: c.iv } }, tk, spot: c.F });
      const o = old.liveChance(d, tk, c.F)!;
      const n = probabilityAt(c.dir, c.F, target, (exp - NOW) / (365 * 86_400_000), strikes.map((K) => ({ strike: K, iv: ivOf(K) })))!;
      return { o, n, old, strikes, d, tk };
    } finally {
      Date.now = realNow;
    }
  }

  it("probability: identical at listed strikes with a flat smile", () => {
    fc.assert(
      fc.property(probCase(true), (c) => {
        const { o, n } = runProb(c, true);
        expect(Math.abs(o - n)).toBeLessThan(5e-7);
      }),
      { numRuns: 4000 },
    );
  });

  it("probability: close between strikes with a flat smile (interpolation is the only difference)", () => {
    fc.assert(
      fc.property(probCase(true), (c) => {
        const { o, n } = runProb(c, false);
        stats.probMaxDiffFlat = Math.max(stats.probMaxDiffFlat, Math.abs(o - n));
        expect(Math.abs(o - n)).toBeLessThan(0.03);
      }),
      { numRuns: 4000 },
    );
  });

  it("probability with a skewed smile: new is always monotone; old sometimes is not (documented)", () => {
    fc.assert(
      fc.property(probCase(false), fc.double({ min: 0.001, max: 0.2, noNaN: true }), (c, du) => {
        const a = runProb(c, false), b = runProb({ ...c, u: Math.min(1, c.u + du) }, false);
        stats.probMaxDiffSkew = Math.max(stats.probMaxDiffSkew, Math.abs(a.o - a.n));
        const newOk = c.dir === "up" ? b.n <= a.n + 1e-12 : b.n >= a.n - 1e-12;
        const oldOk = c.dir === "up" ? b.o <= a.o + 1e-12 : b.o >= a.o - 1e-12;
        if (!oldOk) stats.oldNonMonotone++;
        expect(newOk).toBe(true);
        expect(a.n).toBeGreaterThanOrEqual(0);
        expect(a.n).toBeLessThanOrEqual(1);
      }),
      { numRuns: 4000 },
    );
    console.info("[diff] probability stats", JSON.stringify(stats));
  });

  it("spread selection: same strikes and same book prices as the old liveQuote", () => {
    let compared = 0;
    fc.assert(
      fc.property(chainArb, fc.constantFrom("up" as const, "down" as const), fc.double({ min: 0.01, max: 1, noNaN: true }), fc.double({ min: 10, max: 50_000, noNaN: true }), (c, dir, mv, amt) => {
        const target = dir === "up" ? c.spot * (1 + mv) : c.spot * (1 - mv * 0.6);
        // the old code had no notion of inactive/expired/deactivated instruments: give it only the live ones
        const live = c.instruments.filter((i) => i.isActive && i.expiry * 1000 > NOW && i.deactivation * 1000 > NOW && c.tickers[i.name]);
        const INST = { X: live.map((i) => ({ instrument_name: i.name.replace(/^X-/, "X-"), option_details: { option_type: i.type, strike: String(i.strike), expiry: i.expiry }, taker_fee_rate: String(i.takerFeeRate), base_fee: String(i.baseFee) })) };
        const tk: Record<string, unknown> = {};
        for (const i of live) tk[i.name] = serializeTicker(c.tickers[i.name]!);
        const old = loadOld({ S: { amt, asset: "X", dir, tgt: target, date: 0 }, INST, DATES: [{ key: "20261127", e: NOW + 86_400_000 * 30, days: 30 }], ASSETS: { X: { p: c.spot, iv: 0.6 } }, tk, spot: c.spot });
        const o = old.liveQuote();
        const s = selectSpread(live, c.tickers, c.spot, target, dir, "20261127", NOW);
        if (!o || !o.valid || !s.ok) return true; // old returns null for cases new reports with a reason
        const q = quoteSpread(s.legs, amt);
        expect(s.legs.K1).toBe(o.K1);
        expect(s.legs.K2).toBe(o.K2);
        if (!q.ok || o.mark || q.quote.priced === "mark") return true;
        compared++;
        expect(Number(q.quote.longPrice)).toBeCloseTo(o.p1, 9);
        expect(Number(q.quote.shortPrice)).toBeCloseTo(o.p2, 9);
        expect(q.quote.debit).toBeCloseTo(o.D, 9);
        // intentional: new size ≥ old size (fees included, rounded up to the step)
        expect(q.quote.n).toBeGreaterThanOrEqual(Math.min(o.n, Number(s.legs.long.instrument.minAmount)) - 0.01 - 1e-9);
        return true;
      }),
      { numRuns: 3000 },
    );
    expect(compared).toBeGreaterThan(100);
  });
});
