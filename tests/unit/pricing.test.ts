import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { blackScholes, normCdf } from "../../src/lib/math.ts";
import { interpolateIv, probAbove, probabilityAt, type SmilePoint } from "../../src/lib/pricing.ts";

const smileArb = fc
  .array(fc.record({ strike: fc.double({ min: 0.01, max: 2e5, noNaN: true }), iv: fc.double({ min: 0.01, max: 5, noNaN: true }) }), { minLength: 1, maxLength: 30 });
const fwd = fc.double({ min: 0.01, max: 2e5, noNaN: true });
const T = fc.double({ min: 1e-6, max: 3, noNaN: true });

describe("normCdf", () => {
  it("matches known values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 15);
    expect(normCdf(1.959963984540054)).toBeCloseTo(0.975, 12);
    expect(normCdf(-3)).toBeCloseTo(0.0013498980316301, 13);
  });
  it("is monotone and in [0,1]", () => {
    fc.assert(
      fc.property(fc.double({ min: -50, max: 50, noNaN: true }), fc.double({ min: 0, max: 5, noNaN: true }), (x, d) => {
        const a = normCdf(x), b = normCdf(x + d);
        return a >= 0 && b <= 1 && b >= a - 1e-15; // monotone up to one ulp of rounding near 0.5
      }),
      { numRuns: 10000 },
    );
  });
  it("is symmetric", () => {
    fc.assert(fc.property(fc.double({ min: -30, max: 30, noNaN: true }), (x) => Math.abs(normCdf(x) + normCdf(-x) - 1) < 1e-14), { numRuns: 5000 });
  });
});

describe("Black-Scholes", () => {
  it("put-call parity and price bounds", () => {
    fc.assert(
      fc.property(fwd, fwd, T, fc.double({ min: 0.01, max: 4, noNaN: true }), (S, K, t, v) => {
        const r = blackScholes(S, K, t, v);
        expect(r.call).toBeGreaterThanOrEqual(0);
        expect(r.put).toBeGreaterThanOrEqual(0);
        expect(r.call).toBeLessThanOrEqual(S * (1 + 1e-12));
        expect(r.put).toBeLessThanOrEqual(K * (1 + 1e-12));
        expect(Math.abs(r.call - r.put - (S - K))).toBeLessThanOrEqual(1e-9 * (S + K));
      }),
      { numRuns: 5000 },
    );
  });
});

describe("probabilityAt", () => {
  it("is in [0,1]", () => {
    fc.assert(
      fc.property(fc.constantFrom("up" as const, "down" as const), fwd, fwd, T, smileArb, (dir, F, K, t, sm) => {
        const p = probabilityAt(dir, F, K, t, sm);
        return p !== null && p >= 0 && p <= 1;
      }),
      { numRuns: 5000 },
    );
  });
  it("is monotone in the target for a fixed direction (any smile)", () => {
    fc.assert(
      fc.property(fwd, T, smileArb, fc.double({ min: 0.01, max: 2e5, noNaN: true }), fc.double({ min: 0, max: 2e5, noNaN: true }), (F, t, sm, k1, dk) => {
        const k2 = k1 + dk;
        const u1 = probabilityAt("up", F, k1, t, sm)!, u2 = probabilityAt("up", F, k2, t, sm)!;
        const d1 = probabilityAt("down", F, k1, t, sm)!, d2 = probabilityAt("down", F, k2, t, sm)!;
        expect(u2).toBeLessThanOrEqual(u1 + 1e-12);
        expect(d2).toBeGreaterThanOrEqual(d1 - 1e-12);
        expect(Math.abs(u1 + d1 - 1)).toBeLessThan(1e-12);
      }),
      { numRuns: 5000 },
    );
  });
  it("equals N(d2) at a listed strike with a flat smile", () => {
    fc.assert(
      fc.property(fwd, T, fc.double({ min: 0.05, max: 3, noNaN: true }), fc.array(fc.double({ min: 0.01, max: 2e5, noNaN: true }), { minLength: 1, maxLength: 10 }), fc.nat(9), (F, t, iv, ks, i) => {
        const sm: SmilePoint[] = ks.map((strike) => ({ strike, iv }));
        const K = ks[i % ks.length]!;
        expect(probabilityAt("up", F, K, t, sm)!).toBeCloseTo(probAbove(F, K, t, iv), 12);
      }),
      { numRuns: 3000 },
    );
  });
  it("returns null without a usable smile", () => {
    expect(probabilityAt("up", 100, 110, 0.1, [])).toBeNull();
    expect(probabilityAt("up", 100, 110, 0.1, [{ strike: 100, iv: 0 }])).toBeNull();
    expect(probabilityAt("up", 0, 110, 0.1, [{ strike: 100, iv: 0.5 }])).toBeNull();
  });
});

describe("interpolateIv", () => {
  it("stays within the range of the smile", () => {
    fc.assert(
      fc.property(smileArb, fc.double({ min: 0.001, max: 3e5, noNaN: true }), (sm, k) => {
        const v = interpolateIv(sm, k)!;
        const ivs = sm.map((p) => p.iv);
        return v >= Math.min(...ivs) - 1e-12 && v <= Math.max(...ivs) + 1e-12;
      }),
      { numRuns: 3000 },
    );
  });
});
