// Turn "make $X if ASSET hits/drops to TARGET by DATE" into a listed debit spread.
//   up   → bull call spread: buy call K1 (highest strike ≤ spot), sell call K2 (> spot, nearest target)
//   down → bear put spread:  buy put  K1 (lowest strike ≥ spot),  sell put  K2 (< spot, nearest target)
// Prices are the real book (ask for the leg we buy, bid for the leg we sell),
// tick-aligned; size is floored to amount_step and at least minimum_amount.

import type { Instrument, Ticker } from "./ticker.ts";
import type { Direction } from "./pricing.ts";
import { alignDown, alignUp, toE18, fromE18 } from "./units.ts";

export interface Leg {
  instrument: Instrument;
  ticker: Ticker;
  side: "buy" | "sell";
}

export interface SpreadLegs {
  dir: Direction;
  long: Leg; // K1, bought
  short: Leg; // K2, sold
  K1: number;
  K2: number;
  width: number;
}

export type SelectFail = "no-instruments" | "wrong-side" | "no-long-strike" | "no-short-strike";

/** Instruments that can be traded right now for this expiry/direction. */
export function tradable(instruments: Instrument[], expiryKey: string, dir: Direction, now: number): Instrument[] {
  const type = dir === "up" ? "C" : "P";
  return instruments.filter(
    (i) => i.expiryKey === expiryKey && i.type === type && i.isActive && i.expiry * 1000 > now && i.deactivation * 1000 > now,
  );
}

export function selectSpread(
  instruments: Instrument[],
  tickers: Record<string, Ticker>,
  spot: number,
  target: number,
  dir: Direction,
  expiryKey: string,
  now: number,
): { ok: true; legs: SpreadLegs } | { ok: false; reason: SelectFail } {
  const cands = tradable(instruments, expiryKey, dir, now).filter((i) => tickers[i.name]);
  if (!cands.length || !(spot > 0)) return { ok: false, reason: "no-instruments" };
  if (!(target > 0) || (dir === "up" ? target <= spot : target >= spot)) return { ok: false, reason: "wrong-side" };
  const up = dir === "up";
  const longs = cands.filter((i) => (up ? i.strike <= spot : i.strike >= spot));
  const shorts = cands.filter((i) => (up ? i.strike > spot : i.strike < spot));
  if (!longs.length) return { ok: false, reason: "no-long-strike" };
  if (!shorts.length) return { ok: false, reason: "no-short-strike" };
  const L = longs.reduce((a, b) => (up ? (b.strike > a.strike ? b : a) : b.strike < a.strike ? b : a));
  const S = shorts.reduce((a, b) => {
    const da = Math.abs(a.strike - target), db = Math.abs(b.strike - target);
    // tie → the strike closer to spot (cheaper to reach)
    return db < da || (db === da && (up ? b.strike < a.strike : b.strike > a.strike)) ? b : a;
  });
  return {
    ok: true,
    legs: {
      dir,
      long: { instrument: L, ticker: tickers[L.name]!, side: "buy" },
      short: { instrument: S, ticker: tickers[S.name]!, side: "sell" },
      K1: L.strike,
      K2: S.strike,
      width: Math.abs(S.strike - L.strike),
    },
  };
}

export interface SpreadQuote {
  legs: SpreadLegs;
  amount: string; // contracts per leg, multiple of amount_step, >= minimum_amount
  n: number;
  longPrice: string; // tick-aligned limit for the buy leg
  shortPrice: string; // tick-aligned limit for the sell leg
  debit: number; // per spread, = longPrice - shortPrice
  cost: number; // n × debit (premium paid)
  fees: number; // estimated Derive taker fees, both legs
  maxLoss: number; // cost + fees
  maxProfit: number; // n × width − cost − fees
  breakeven: number;
  priced: "book" | "mark"; // "mark" = a side of the book is empty; display-only, cannot be confirmed
  belowMinimum: boolean; // requested profit needed fewer contracts than the minimum
  depthOk: boolean; // the top of book can fill n on both legs
}

export type QuoteFail = "no-price" | "no-edge" | "too-large";

/** Derive's taker fee for one fill: n × min(rate × index, cap × price) + base fee. */
export function takerFee(inst: Instrument, index: number, price: number, n: number): number {
  return n * Math.min(inst.takerFeeRate * index, inst.markFeeCap * price) + inst.baseFee;
}

function legPrice(leg: Leg): { px: number; mark: boolean } {
  const t = leg.ticker;
  const book = leg.side === "buy" ? t.ask : t.bid;
  if (book > 0) return { px: book, mark: false };
  return { px: t.mark, mark: true };
}

/** Round x up to the instrument's amount step, honouring the minimum. Returns a decimal string. */
export function sizeContracts(x: number, inst: Instrument): { amount: string; belowMinimum: boolean } | null {
  if (!(x > 0) || !Number.isFinite(x)) return null;
  // round UP to the step: the payout must reach the amount the user asked for
  const floored = alignUp(Math.min(x, 1e9), inst.amountStep);
  const min = inst.minAmount;
  // the minimum itself rounded UP to a step multiple, so the result is always both
  const minAligned = alignUp(Number(min), inst.amountStep);
  if (toE18(floored) < toE18(minAligned)) return { amount: minAligned, belowMinimum: true };
  if (toE18(floored) > toE18(inst.maxAmount)) return null;
  return { amount: fromE18(toE18(floored)), belowMinimum: false };
}

export function quoteSpread(legs: SpreadLegs, profitWanted: number): { ok: true; quote: SpreadQuote } | { ok: false; reason: QuoteFail } {
  const l = legPrice(legs.long), s = legPrice(legs.short);
  if (!(l.px > 0) || !(s.px >= 0)) return { ok: false, reason: "no-price" };
  const li = legs.long.instrument, si = legs.short.instrument;
  const longPrice = alignUp(l.px, li.tickSize);
  const shortPrice = s.px > 0 ? alignDown(s.px, si.tickSize) : "0";
  const debit = Number(longPrice) - Number(shortPrice);
  const W = legs.width;
  if (!(debit > 0) || !(W - debit > 0)) return { ok: false, reason: "no-edge" };
  const step = toE18(li.amountStep) > toE18(si.amountStep) ? li : si;
  const idx = legs.long.ticker.index || legs.short.ticker.index;
  const hasShort = Number(shortPrice) > 0;
  // size so that the payout AFTER fees is at least what the user asked for
  const perUnitFees = takerFee(li, idx, Number(longPrice), 1) - li.baseFee + (hasShort ? takerFee(si, idx, Number(shortPrice), 1) - si.baseFee : 0);
  const baseFees = li.baseFee + (hasShort ? si.baseFee : 0);
  const edge = W - debit - perUnitFees;
  if (!(edge > 0)) return { ok: false, reason: "no-edge" };
  const sized = sizeContracts((profitWanted + baseFees) / edge, { ...step, minAmount: maxDec(li.minAmount, si.minAmount) });
  if (!sized) return { ok: false, reason: "too-large" };
  const n = Number(sized.amount);
  const cost = n * debit;
  const fees = takerFee(li, idx, Number(longPrice), n) + (hasShort ? takerFee(si, idx, Number(shortPrice), n) : 0);
  const per = (cost + fees) / n;
  return {
    ok: true,
    quote: {
      legs,
      amount: sized.amount,
      n,
      longPrice,
      shortPrice,
      debit,
      cost,
      fees,
      maxLoss: cost + fees,
      maxProfit: n * W - cost - fees,
      breakeven: legs.dir === "up" ? legs.K1 + per : legs.K1 - per,
      priced: l.mark || s.mark ? "mark" : "book",
      belowMinimum: sized.belowMinimum,
      depthOk: n <= legs.long.ticker.askSize && (Number(shortPrice) === 0 || n <= legs.short.ticker.bidSize),
    },
  };
}

const maxDec = (a: string, b: string): string => (toE18(a) >= toE18(b) ? a : b);

/** Per-unit max fee to sign (derive-ts default: 3 × (max(index, price) × taker rate + base fee)). */
export function maxFeePerUnit(inst: Instrument, index: number, price: number): string {
  const v = 3 * (Math.max(index, price) * inst.takerFeeRate + inst.baseFee);
  return alignUp(v, "0.000001");
}

/** Protective limit for unwinding/closing: cross the book by `slip` but stay inside the exchange band. */
export function protectiveLimit(side: "buy" | "sell", t: Ticker, inst: Instrument, slip = 0.2): string {
  const ref = side === "sell" ? (t.bid > 0 ? t.bid : t.mark) : t.ask > 0 ? t.ask : t.mark;
  let px = side === "sell" ? ref * (1 - slip) : ref * (1 + slip);
  if (t.minPrice !== null) px = Math.max(px, t.minPrice);
  if (t.maxPrice !== null) px = Math.min(px, t.maxPrice);
  px = Math.max(px, Number(inst.tickSize));
  return side === "sell" ? alignUp(px, inst.tickSize) : alignDown(px, inst.tickSize);
}
