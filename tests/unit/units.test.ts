import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { alignDown, alignUp, fromE18, isAligned, numToDec, toE18 } from "../../src/lib/units.ts";

const steps = fc.constantFrom("0.0001", "0.001", "0.01", "0.1", "0.5", "1", "5", "25");

describe("units", () => {
  it("toE18/fromE18 round-trip for any e18 integer", () => {
    fc.assert(fc.property(fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }), (v) => toE18(fromE18(v)) === v), { numRuns: 5000 });
  });
  it("rejects exponents and junk", () => {
    for (const bad of ["1e5", "", "abc", "1.2.3", "--1", "1.0000000000000000001"]) expect(() => toE18(bad)).toThrow();
  });
  it("alignDown/alignUp give step multiples that bracket x", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e7, noNaN: true }), steps, (x, s) => {
        const d = alignDown(x, s), u = alignUp(x, s);
        expect(isAligned(d, s)).toBe(true);
        expect(isAligned(u, s)).toBe(true);
        const xs = toE18(x.toFixed(12));
        expect(toE18(d) <= xs).toBe(true);
        expect(toE18(u) >= xs).toBe(true);
        expect(toE18(u) - toE18(d) <= toE18(s)).toBe(true);
      }),
      { numRuns: 5000 },
    );
  });
  it("numToDec keeps 12 decimals and never uses exponent notation", () => {
    fc.assert(fc.property(fc.double({ min: -1e9, max: 1e9, noNaN: true }), (x) => !/e/i.test(numToDec(x)) && Math.abs(Number(numToDec(x)) - x) <= 1e-12 + Math.abs(x) * 1e-15), { numRuns: 3000 });
  });
});
