// Probability that the underlying ends beyond the user's exact target.
//
// Each listed strike gets a risk-neutral probability N(d2) from its own mark IV.
// Those strike-level probabilities are forced monotone (a smile can otherwise
// produce a higher chance of ending above a higher strike), and the probability
// at the exact target is linearly interpolated between the bracketing strikes.
// Outside the listed range the edge strike's IV is used with a monotone clamp.
// With a flat smile this equals N(d2) at the target up to interpolation error,
// which tests/diff measures against the prototype.

import { clamp, normCdf } from "./math.ts";

export type Direction = "up" | "down";

export interface SmilePoint {
  strike: number;
  iv: number;
}

/** P(S_T > K) under a lognormal with forward F, vol iv, time T (years). */
export function probAbove(F: number, K: number, T: number, iv: number): number {
  if (!(F > 0) || !(K > 0)) return NaN;
  if (!(T > 0) || !(iv > 0)) return F > K ? 1 : 0;
  const sd = iv * Math.sqrt(T);
  const d2 = (Math.log(F / K) - 0.5 * sd * sd) / sd;
  return clamp(normCdf(d2), 0, 1);
}

/** Linear IV interpolation in strike with flat extrapolation (what the prototype did). */
export function interpolateIv(points: SmilePoint[], target: number): number | null {
  const pts = points.filter((p) => p.strike > 0 && p.iv > 0).sort((a, b) => a.strike - b.strike);
  if (!pts.length) return null;
  const first = pts[0]!, last = pts[pts.length - 1]!;
  if (target <= first.strike) return first.iv;
  if (target >= last.strike) return last.iv;
  for (let i = 1; i < pts.length; i++) {
    const hi = pts[i]!, lo = pts[i - 1]!;
    if (target <= hi.strike) {
      if (hi.strike === lo.strike) return hi.iv;
      const w = (target - lo.strike) / (hi.strike - lo.strike);
      return lo.iv + w * (hi.iv - lo.iv);
    }
  }
  return last.iv;
}

/**
 * Probability that the move the user described happens: ending above `target`
 * for "up", below it for "down". Returns null when there is no usable smile.
 */
export function probabilityAt(dir: Direction, forward: number, target: number, T: number, smile: SmilePoint[]): number | null {
  if (!(forward > 0) || !(target > 0) || !Number.isFinite(T)) return null;
  const pts = dedupe(smile.filter((p) => p.strike > 0 && p.iv > 0 && Number.isFinite(p.iv)).sort((a, b) => a.strike - b.strike));
  if (!pts.length) return null;
  // strike-level P(above), forced non-increasing in strike
  const raw = pts.map((p) => probAbove(forward, p.strike, T, p.iv));
  const env: number[] = [];
  raw.forEach((p, i) => env.push(i === 0 ? p : Math.min(env[i - 1]!, p)));
  const first = pts[0]!, last = pts[pts.length - 1]!;
  let above: number;
  if (target <= first.strike) {
    above = Math.max(env[0]!, probAbove(forward, target, T, first.iv));
  } else if (target >= last.strike) {
    above = Math.min(env[env.length - 1]!, probAbove(forward, target, T, last.iv));
  } else {
    let i = 1;
    while (pts[i]!.strike < target) i++;
    const lo = pts[i - 1]!, hi = pts[i]!;
    const w = (target - lo.strike) / (hi.strike - lo.strike);
    above = env[i - 1]! + w * (env[i]! - env[i - 1]!);
  }
  above = clamp(above, 0, 1);
  return dir === "up" ? above : 1 - above;
}

function dedupe(pts: SmilePoint[]): SmilePoint[] {
  const out: SmilePoint[] = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (prev && prev.strike === p.strike) prev.iv = (prev.iv + p.iv) / 2;
    else out.push({ ...p });
  }
  return out;
}

export const YEAR_MS = 365 * 86_400_000;
export const yearsUntil = (expiryMs: number, now: number): number => Math.max((expiryMs - now) / YEAR_MS, 1e-6);
