// Differential tests: the app's Veranta maths (src/venues/veranta/rules.ts, written from
// the rules) against veranta-sdk 0.3.1's own compute module, which mirrors Veranta's UI and
// contracts (makerOrTakerFeeP / pairOpenMakerTakerFeeP, estimateLiquidationPrice,
// LIQ_THRESHOLD_P). Random inputs plus the recorded pair catalogues' real OI and fees.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { compute } from "veranta-sdk";
import testnet from "../fixtures/veranta/testnet.json" with { type: "json" };
import mainnet from "../fixtures/veranta/mainnet.json" with { type: "json" };
import { marketsFrom, openFeeRate, verantaLiqPrice, type VPair } from "../../src/venues/veranta/rules.ts";
import { VERANTA_LIQ_THRESHOLD } from "../../src/venues/veranta/config.ts";

const sdkOpen = (o: { isLong: boolean; size: number; oiLong: number; oiShort: number; maker: number; taker: number }) =>
  compute.pairOpenMakerTakerFeeP({ initialCoinOiLong: o.oiLong, initialCoinOiShort: o.oiShort, positionSizeCoinOi: o.size, isLong: o.isLong, openMakerFeeP: o.maker * 100, openTakerFeeP: o.taker * 100 }).feeP / 100;

/**
 * Same rule, different arithmetic: the SDK's blended fee computes (s − L + S) left to right, so when
 * the open interest is huge next to the trade it loses digits to cancellation. Allow exactly that
 * rounding (a few ulps of the open interest, relative to the trade size) and nothing more.
 */
const tol = (o: { size: number; oiLong: number; oiShort: number; taker: number }) => 1e-15 + (o.taker * 8 * Number.EPSILON * (o.oiLong + o.oiShort + o.size)) / o.size;
const same = (o: { isLong: boolean; size: number; oiLong: number; oiShort: number; maker: number; taker: number }, msg?: string) => {
  const a = openFeeRate(o), b = sdkOpen(o);
  expect(Math.abs(a - b), msg ?? JSON.stringify({ ...o, a, b })).toBeLessThanOrEqual(tol(o));
};

describe("open fee rate vs compute.pairOpenMakerTakerFeeP", () => {
  it("the SDK's liquidation threshold is the app's", () => {
    expect(compute.LIQ_THRESHOLD_P / 100).toBe(VERANTA_LIQ_THRESHOLD);
  });
  it("PROPERTY: identical on random open interest, sizes and fee pairs", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1e7, noNaN: true }),
        fc.double({ min: 0, max: 1e7, noNaN: true }),
        fc.double({ min: 1e-6, max: 1e7, noNaN: true }),
        fc.boolean(),
        fc.double({ min: 0, max: 0.001, noNaN: true }),
        fc.double({ min: 0, max: 0.002, noNaN: true }),
        (L, S, s, isLong, maker, taker) => {
          same({ isLong, size: s, oiLong: L, oiShort: S, maker, taker });
        },
      ),
      { numRuns: 2000 },
    );
  });
  it("PROPERTY: the edges (balanced book, exactly rebalancing, one empty side)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e6 }), fc.integer({ min: 1, max: 1e6 }), fc.boolean(), (L, s, isLong) => {
        for (const S of [L, 0, L + s, Math.max(0, L - s)]) {
          same({ isLong, size: s, oiLong: L, oiShort: S, maker: 0.0001, taker: 0.00045 });
        }
      }),
      { numRuns: 500 },
    );
  });
  it("on every recorded pair's real open interest and fees, for $10–$100,000 positions both ways", () => {
    let n = 0;
    for (const fx of [testnet, mainnet]) {
      const { markets } = marketsFrom(fx.pairs as VPair[], {}, 0);
      for (const m of markets)
        for (const usd of [10, 100, 1000, 1e4, 1e5])
          for (const isLong of [true, false]) {
            const size = usd / 2500;
            const o = { isLong, size, oiLong: m.oiLong, oiShort: m.oiShort, maker: m.makerFeeRate, taker: m.takerFeeRate };
            same(o, `${fx.network} ${m.name} ${usd} ${isLong}`);
            n++;
          }
    }
    expect(n).toBeGreaterThan(40);
  });
});

describe("liquidation price vs compute.estimateLiquidationPrice", () => {
  it("PROPERTY: identical (when above zero) on random entries, margins, leverage and accrued fees", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.0001, max: 2e5, noNaN: true }),
        fc.double({ min: 1, max: 1e6, noNaN: true }),
        fc.double({ min: 1, max: 500, noNaN: true }),
        fc.boolean(),
        fc.double({ min: 0, max: 0.5, noNaN: true }),
        fc.double({ min: 0, max: 0.3, noNaN: true }),
        (entry, coll, lev, isLong, rollFrac, fundFrac) => {
          const rolloverFee = coll * rollFrac, fundingFee = coll * fundFrac;
          const ref = compute.estimateLiquidationPrice({ openPrice: entry, collateral: coll, leverage: lev, isLong, rolloverFee, fundingFee });
          const ours = verantaLiqPrice({ entry, collateral: coll, leverage: lev, isLong, accruedFees: rolloverFee + fundingFee });
          if (ref > 0) expect(ours!).toBeCloseTo(ref, Math.max(0, 9 - Math.ceil(Math.log10(entry + 1))));
          else expect(ours).toBeNull(); // the SDK returns a price ≤ 0; the app shows none
        },
      ),
      { numRuns: 2000 },
    );
  });
  it("the live run's 5× long (open 2567.98, $39.91 margin)", () => {
    const ref = compute.estimateLiquidationPrice({ openPrice: 2567.98, collateral: 39.91, leverage: 5, isLong: true });
    expect(verantaLiqPrice({ entry: 2567.98, collateral: 39.91, leverage: 5, isLong: true })).toBeCloseTo(ref, 9);
  });
});
