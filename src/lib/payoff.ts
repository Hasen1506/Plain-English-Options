// Expiry payoff of a debit spread.

import type { Direction } from "./pricing.ts";

export interface PayoffSpec {
  dir: Direction;
  K1: number; // long strike
  K2: number; // short strike
  n: number; // contracts per leg
  cost: number; // premium paid (net debit × n)
  fees: number;
}

/** Value at expiry of one spread (one contract per leg). */
export function spreadValue(spec: Pick<PayoffSpec, "dir" | "K1" | "K2">, x: number): number {
  const W = Math.abs(spec.K2 - spec.K1);
  const intrinsic = spec.dir === "up" ? x - spec.K1 : spec.K1 - x;
  return Math.min(Math.max(intrinsic, 0), W);
}

/** Profit or loss of the whole position at expiry price x (fees included). */
export function profitAt(spec: PayoffSpec, x: number): number {
  return spec.n * spreadValue(spec, x) - spec.cost - spec.fees;
}

export const maxLoss = (s: PayoffSpec): number => s.cost + s.fees;
export const maxProfit = (s: PayoffSpec): number => s.n * Math.abs(s.K2 - s.K1) - s.cost - s.fees;

export interface ChartPoint {
  x: number;
  pl: number;
}

/** Evenly spaced points from 0.8 widths below the spread to 0.8 widths above it. */
export function chartPoints(spec: PayoffSpec, count = 14): ChartPoint[] {
  const lo = Math.min(spec.K1, spec.K2), hi = Math.max(spec.K1, spec.K2), W = hi - lo;
  const from = Math.max(lo - W * 0.8, 0), to = hi + W * 0.8;
  const pts: ChartPoint[] = [];
  for (let i = 0; i < count; i++) {
    const x = from + ((to - from) * i) / (count - 1);
    pts.push({ x, pl: profitAt(spec, x) });
  }
  return pts;
}
