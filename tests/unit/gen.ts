// Shared fast-check generators: realistic instruments, tickers and option chains.
import fc from "fast-check";
import type { Instrument, Ticker } from "../../src/lib/ticker.ts";
import { blackScholes } from "../../src/lib/math.ts";
import { alignDown, alignUp } from "../../src/lib/units.ts";

export const NOW = Date.UTC(2026, 9, 8, 0, 0, 0);
export const ADDR = "0x4BB4C3CDc7562f08e9910A0C7D8bB7e108861eB4";

export function mkInst(p: Partial<Instrument> & { strike: number; type: "C" | "P" }): Instrument {
  const expiry = p.expiry ?? Math.floor(Date.UTC(2026, 10, 27, 8) / 1000);
  const key = p.expiryKey ?? "20261127";
  return {
    name: p.name ?? `ETH-${key}-${p.strike}-${p.type}`,
    currency: "ETH",
    type: p.type,
    strike: p.strike,
    expiry,
    expiryKey: key,
    isActive: p.isActive ?? true,
    deactivation: p.deactivation ?? expiry - 60,
    tickSize: p.tickSize ?? "0.1",
    minAmount: p.minAmount ?? "0.1",
    maxAmount: p.maxAmount ?? "10000",
    amountStep: p.amountStep ?? "0.01",
    takerFeeRate: p.takerFeeRate ?? 0.0003,
    baseFee: p.baseFee ?? 0.5,
    markFeeCap: p.markFeeCap ?? 0.125,
    assetAddress: ADDR,
    subId: p.subId ?? "2576980377601830240000",
  };
}

export function mkTicker(p: Partial<Ticker>): Ticker {
  return { ts: NOW, ask: 0, askSize: 100, bid: 0, bidSize: 100, mark: 0, index: 2500, iv: 0.6, forward: 2500, delta: null, minPrice: null, maxPrice: null, change24h: null, ...p };
}

export interface Chain {
  spot: number;
  instruments: Instrument[];
  tickers: Record<string, Ticker>;
  tick: string;
  step: string;
  min: string;
}

/** A Black-Scholes-priced chain with a book around fair value, plus noise (inactive/expired strikes). */
export const chainArb = fc
  .record({
    spot: fc.double({ min: 0.5, max: 150_000, noNaN: true }),
    nStrikes: fc.integer({ min: 2, max: 25 }),
    spacingPct: fc.double({ min: 0.005, max: 0.2, noNaN: true }),
    iv: fc.double({ min: 0.2, max: 2.5, noNaN: true }),
    skew: fc.double({ min: -0.5, max: 0.5, noNaN: true }),
    days: fc.integer({ min: 3, max: 200 }),
    spreadPct: fc.double({ min: 0, max: 0.2, noNaN: true }),
    tick: fc.constantFrom("0.0001", "0.001", "0.01", "0.1", "1", "5"),
    step: fc.constantFrom("0.01", "0.1", "1"),
    min: fc.constantFrom("0.01", "0.1", "0.5", "1"),
    junk: fc.array(fc.record({ k: fc.integer({ min: 0, max: 30 }), kind: fc.constantFrom("inactive", "expired", "deact", "noticker") }), { maxLength: 4 }),
  })
  .map((r): Chain => {
    const step0 = Math.max(r.spot * r.spacingPct, 1e-4);
    const first = Math.max(step0, r.spot - step0 * Math.floor(r.nStrikes / 2));
    const T = r.days / 365;
    const expiry = Math.floor((NOW + r.days * 86_400_000) / 1000);
    const instruments: Instrument[] = [];
    const tickers: Record<string, Ticker> = {};
    for (let k = 0; k < r.nStrikes; k++) {
      const strike = Number((first + k * step0).toPrecision(6));
      if (!(strike > 0)) continue;
      const iv = Math.max(0.05, r.iv * (1 + r.skew * Math.log(strike / r.spot)));
      const bs = blackScholes(r.spot, strike, T, iv);
      for (const type of ["C", "P"] as const) {
        const fair = type === "C" ? bs.call : bs.put;
        const inst = mkInst({ strike, type, expiry, expiryKey: "20261127", name: `X-20261127-${strike}-${type}`, tickSize: r.tick, amountStep: r.step, minAmount: r.min });
        instruments.push(inst);
        const t = Number(r.tick);
        const ask = fair > 0 ? Number(alignUp(fair * (1 + r.spreadPct) + t, r.tick)) : 0;
        const bid = fair * (1 - r.spreadPct) - t > t ? Number(alignDown(fair * (1 - r.spreadPct) - t, r.tick)) : 0;
        tickers[inst.name] = mkTicker({ ask, bid, mark: Math.max(fair, 0), index: r.spot, forward: r.spot, iv, askSize: 1e6, bidSize: 1e6 });
      }
    }
    // noise the selector must never pick
    for (const j of r.junk) {
      const strike = Number((first + (j.k + 0.5) * step0).toPrecision(6));
      for (const type of ["C", "P"] as const) {
        const inst = mkInst({ strike, type, expiry: j.kind === "expired" ? Math.floor(NOW / 1000) - 10 : expiry, expiryKey: "20261127", name: `JUNK-${j.kind}-${strike}-${type}`, isActive: j.kind !== "inactive", deactivation: j.kind === "deact" ? Math.floor(NOW / 1000) - 5 : expiry, tickSize: r.tick, amountStep: r.step, minAmount: r.min });
        instruments.push(inst);
        if (j.kind !== "noticker") tickers[inst.name] = mkTicker({ ask: 1, bid: 0.5, mark: 0.7, index: r.spot, askSize: 1e6, bidSize: 1e6 });
      }
    }
    return { spot: r.spot, instruments, tickers, tick: r.tick, step: r.step, min: r.min };
  });
