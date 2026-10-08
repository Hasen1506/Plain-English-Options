import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseCurrencies, parseInstrument, parseInstruments, parseSubaccount, parseTicker, parseTickers, serializeTicker, type Ticker } from "../../src/lib/ticker.ts";

const fin = (min: number, max: number) => fc.double({ min, max, noNaN: true, noDefaultInfinity: true }).map((x) => x + 0); // JSON has no -0
const tickerArb: fc.Arbitrary<Ticker> = fc.record({
  ts: fc.integer({ min: 0, max: 2 ** 45 }),
  ask: fin(0, 1e6),
  askSize: fin(0, 1e6),
  bid: fin(0, 1e6),
  bidSize: fin(0, 1e6),
  mark: fin(0, 1e6),
  index: fin(1e-6, 1e6),
  iv: fc.option(fin(1e-6, 10)),
  forward: fc.option(fin(1e-6, 1e6)),
  delta: fc.option(fin(-1, 1)),
  minPrice: fc.option(fin(1e-6, 1e6)),
  maxPrice: fc.option(fin(1e-6, 1e6)),
  change24h: fc.option(fin(-1, 10)),
});

describe("ticker parsing", () => {
  it("round-trips serialize → parse", () => {
    fc.assert(
      fc.property(tickerArb, (t) => {
        const back = parseTicker(JSON.parse(JSON.stringify(serializeTicker(t))));
        // an all-null option_pricing block is omitted, which parses back to the same nulls
        expect(back).toEqual(t);
      }),
      { numRuns: 5000 },
    );
  });
  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.anything({ withNullPrototype: true, withBigInt: true, withDate: true, withMap: true }), (x) => {
        parseTicker(x);
        parseTickers(x);
        parseTickers({ tickers: x });
        parseInstrument(x);
        parseInstruments(x);
        parseCurrencies(x);
        parseSubaccount(x);
        return true;
      }),
      { numRuns: 5000 },
    );
  });
  it("never throws on mutated real frames and keeps only valid entries", () => {
    const real = { t: 1, a: "579.7", A: "50", b: "575.7", B: "50", option_pricing: { i: "0.72", f: "2578", d: "0.99" }, I: "2576.2", M: "578.3", stats: { p: "-0.046" }, minp: "539.7", maxp: "618.9" };
    const keys = Object.keys(real);
    fc.assert(
      fc.property(fc.subarray(keys), fc.anything(), (drop, junk) => {
        const m: Record<string, unknown> = { ...real };
        for (const k of drop) m[k] = junk;
        const t = parseTicker(m);
        if (t) {
          for (const v of [t.ask, t.bid, t.mark, t.index, t.askSize, t.bidSize]) expect(Number.isFinite(v) && v >= 0).toBe(true);
          expect(t.index).toBeGreaterThan(0);
        }
        return true;
      }),
      { numRuns: 3000 },
    );
  });
  it("reads the slim format", () => {
    const t = parseTicker({ t: 5, a: "1.3", A: "3.88", b: "0.2", B: "11.64", option_pricing: { i: "0.59323", f: "2578.1", d: "0.00897" }, I: "2576.4", M: "0.6", stats: { p: "-0.046" }, minp: "0.1", maxp: "3.6" })!;
    expect(t).toMatchObject({ ask: 1.3, bid: 0.2, mark: 0.6, index: 2576.4, iv: 0.59323, forward: 2578.1, change24h: -0.046, minPrice: 0.1, maxPrice: 3.6 });
  });
});
