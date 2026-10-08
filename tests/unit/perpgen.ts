// Shared generators for perp tests: realistic perp markets and books.
import fc from "fast-check";
import type { PerpInstrument, PerpTicker } from "../../src/lib/perp.ts";
import { NOW } from "./gen.ts";

export const PERP_ADDR = "0xAf65752C4643E25C02F693f9D4FE19cF23a095E3";

export function mkPerp(p: Partial<PerpInstrument> = {}): PerpInstrument {
  return {
    name: "ETH-PERP",
    currency: "ETH",
    isActive: true,
    tickSize: "0.01",
    minAmount: "0.1",
    maxAmount: "10000",
    amountStep: "0.001",
    takerFeeRate: 0.0003,
    makerFeeRate: 0.0001,
    baseFee: 0.1,
    imReq: 0.066,
    mmReq: 0.05,
    maxLeverage: 1 / 0.066,
    maxRatePerHour: 0.004,
    minRatePerHour: -0.004,
    assetAddress: PERP_ADDR,
    subId: "0",
    ...p,
  };
}

export function mkPerpTicker(p: Partial<PerpTicker> = {}): PerpTicker {
  return {
    ts: NOW,
    ask: 2500.5,
    askSize: 50,
    bid: 2500,
    bidSize: 50,
    mark: 2500.2,
    index: 2500.1,
    iv: 0,
    forward: 2500.2,
    delta: null,
    minPrice: 2400,
    maxPrice: 2600,
    change24h: -0.01,
    fundingRate: 0.0000125,
    openInterest: 1000,
    volume24h: 1_000_000,
    ...p,
  };
}

/** A perp market + book around a fair price, with tick/step/min drawn from real venues' shapes. */
export const marketArb = fc
  .record({
    px: fc.double({ min: 0.01, max: 150_000, noNaN: true }),
    spreadTicks: fc.integer({ min: 1, max: 40 }),
    tick: fc.constantFrom("0.00001", "0.0001", "0.01", "0.1", "1"),
    step: fc.constantFrom("0.001", "0.01", "0.1", "1"),
    minMult: fc.integer({ min: 1, max: 100 }),
    im: fc.double({ min: 0.02, max: 0.5, noNaN: true }),
    mmFrac: fc.double({ min: 0.3, max: 1, noNaN: true }),
    taker: fc.integer({ min: 0, max: 10 }).map((b) => b / 10_000), // bps, maker ≤ taker as on every venue
    makerShare: fc.integer({ min: 0, max: 100 }),
    baseFee: fc.integer({ min: 0, max: 100 }).map((c) => c / 100),
    band: fc.double({ min: 0.01, max: 0.2, noNaN: true }),
    funding: fc.double({ min: -0.004, max: 0.004, noNaN: true }),
  })
  .filter((r) => r.px / Number(r.tick) > 20 && r.px / Number(r.tick) < 1e9)
  .map((r) => {
    const t = Number(r.tick);
    const bid = Math.floor(r.px / t) * t;
    const ask = bid + r.spreadTicks * t;
    const min = (r.minMult * Number(r.step)).toFixed(6).replace(/\.?0+$/, "");
    const inst = mkPerp({ tickSize: r.tick, amountStep: r.step, minAmount: min, maxAmount: "1000000", imReq: r.im, mmReq: r.im * r.mmFrac, maxLeverage: 1 / r.im, takerFeeRate: r.taker, makerFeeRate: (r.taker * r.makerShare) / 100, baseFee: r.baseFee });
    const mid = (bid + ask) / 2;
    const ticker = mkPerpTicker({ bid, ask, mark: mid, index: mid, minPrice: bid * (1 - r.band), maxPrice: ask * (1 + r.band), fundingRate: r.funding, askSize: 1e6, bidSize: 1e6 });
    return { inst, ticker };
  });
