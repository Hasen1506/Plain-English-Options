// Differential tests: the app's Hyperliquid maths against independent references.
//  1. price/size rounding vs the official SDK's own rounding formula (examples/rounding.py),
//     600 recorded samples (tests/fixtures/hyperliquid/rounding-ref.json, scripts/hl/gen_rounding.py)
//  2. the shared liquidation maths vs Hyperliquid's published formula
//     (docs trading/liquidations: liq = price − side·margin_available / size / (1 − l·side), l = 1/maintenance leverage)
//  3. funding: our per-hour convention vs the exchange's recorded funding payments
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import ref from "../fixtures/hyperliquid/rounding-ref.json" with { type: "json" };
import mainnet from "../fixtures/hyperliquid/mainnet.json" with { type: "json" };
import { priceStep, roundPrice, roundSize, validPrice } from "../../src/venues/hyperliquid/rules.ts";
import { hlName, parseMeta } from "../../src/venues/hyperliquid/parse.ts";
import { fundingPerHour, liquidationPrice } from "../../src/lib/perp.ts";

describe("rounding vs the SDK's formula round(float(f'{px:.5g}'), 6 − szDecimals)", () => {
  const rows = ref.rows.map((r) => ({ px: Number(r.px), d: r.szDecimals, refPx: Number(r.refPx), sz: Number(r.sz), refSz: Number(r.refSz) }));
  it("our down/up rounding brackets the reference whenever the reference is a valid price", () => {
    let compared = 0;
    for (const r of rows) {
      const refStr = String(r.refPx);
      if (!(r.refPx > 0) || /e/i.test(refStr) || !validPrice(refStr, r.d)) continue; // the SDK one-liner can produce 0 for tiny prices
      compared++;
      const d = Number(roundPrice(r.px, r.d, "down")), u = Number(roundPrice(r.px, r.d, "up"));
      if (r.px >= 1e5) {
        // ≥ 100,000 every integer is valid (docs), so our step (1) is finer than 5 significant figures: at least as close as the SDK
        expect(Math.min(Math.abs(d - r.px), Math.abs(u - r.px))).toBeLessThanOrEqual(Math.abs(r.refPx - r.px) + 1e-9);
        continue;
      }
      expect(d, `${r.px}/${r.d}`).toBeLessThanOrEqual(r.refPx + 1e-12);
      expect(u, `${r.px}/${r.d}`).toBeGreaterThanOrEqual(r.refPx - 1e-12);
      // and the reference is one of the two (nearest rounding picks one side)
      const step = Number(priceStep(r.px, r.d));
      expect(Math.min(Math.abs(d - r.refPx), Math.abs(u - r.refPx))).toBeLessThanOrEqual(step * 1e-6 + 1e-15);
    }
    expect(compared).toBeGreaterThan(400);
  });
  it("sizes: ours floors, the SDK rounds to nearest; they differ by at most one lot", () => {
    for (const r of rows) {
      const ours = Number(roundSize(r.sz, r.d));
      expect(Math.abs(ours - r.refSz)).toBeLessThanOrEqual(10 ** -r.d + 1e-9);
      expect(ours).toBeLessThanOrEqual(r.sz + 1e-12);
    }
  });
});

/** Hyperliquid docs' liquidation formula, verbatim. */
function docsLiq(price: number, side: 1 | -1, marginAvailable: number, positionSize: number, maintenanceLeverage: number): number {
  const l = 1 / maintenanceLeverage;
  return price - (side * marginAvailable) / positionSize / (1 - l * side);
}

describe("liquidation price vs Hyperliquid's published formula", () => {
  it("PROPERTY: identical for longs and shorts, any size, margin and max leverage", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.001, max: 200_000, noNaN: true }),
        fc.double({ min: 0.0001, max: 1_000, noNaN: true }),
        fc.constantFrom(1, -1),
        fc.double({ min: 0.01, max: 50_000, noNaN: true }),
        fc.constantFrom(3, 5, 10, 20, 25, 40, 50),
        (price, size, side, margin, maxLev) => {
          const mmReq = 1 / (2 * maxLev); // maintenance leverage = 2 × max leverage
          const ours = liquidationPrice({ size: side * size, price, headroom: margin, mmReq });
          const theirs = docsLiq(price, side as 1 | -1, margin, size, 2 * maxLev);
          if (theirs <= 0) expect(ours).toBeNull();
          else expect(ours! / theirs).toBeCloseTo(1, 9);
        },
      ),
      { numRuns: 3000 },
    );
  });
});

describe("funding convention vs recorded payments", () => {
  it("usdc paid per event = −szi × price × hourly rate, the price being the coin's own (within 15% over the recorded 6 h)", () => {
    const { tickers } = parseMeta(mainnet.frames.find((f) => f.req.type === "metaAndAssetCtxs")!.res);
    const raw = mainnet.frames.find((f) => f.req.type === "userFunding")!.res as { delta: { coin: string; usdc: string; szi: string; fundingRate: string } }[];
    let checked = 0;
    for (const e of raw) {
      const usdc = Number(e.delta.usdc), szi = Number(e.delta.szi), rate = Number(e.delta.fundingRate);
      if (rate === 0 || Math.abs(usdc) < 1e-3) continue;
      const impliedPx = usdc / (-szi * rate); // fundingPerHour(szi, px, rate) = −szi·px·rate
      expect(impliedPx).toBeGreaterThan(0);
      const mark = tickers[hlName(e.delta.coin)]?.mark;
      if (mark) expect(Math.abs(impliedPx / mark - 1)).toBeLessThan(0.15);
      expect(fundingPerHour(szi, impliedPx, rate)).toBeCloseTo(usdc, 6);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });
});
