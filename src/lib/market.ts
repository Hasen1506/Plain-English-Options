// Glue between parsed market data and the builder: expiries, spot, and the live quote.

import { MIN_EXPIRY_MS } from "../config.ts";
import type { Instrument, Ticker } from "./ticker.ts";
import type { BuilderState, QuoteResult } from "./state.ts";
import { probabilityAt, yearsUntil, type SmilePoint } from "./pricing.ts";
import { quoteSpread, selectSpread } from "./spread.ts";
import { expiryLabel, type ExpiryLabel } from "./format.ts";

/** Expiries with at least one active, not-yet-deactivated option, far enough out. */
export function expiriesFor(instruments: Instrument[], now: number): ExpiryLabel[] {
  const seen = new Map<string, number>();
  for (const i of instruments) {
    const ms = i.expiry * 1000;
    if (!i.isActive || i.deactivation * 1000 <= now || ms - now < MIN_EXPIRY_MS) continue;
    if (!seen.has(i.expiryKey)) seen.set(i.expiryKey, ms);
  }
  return [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([k, ms]) => expiryLabel(k, ms, now));
}

/** Spot (index) and forward for one expiry's ticker set. */
export function spotOf(tickers: Record<string, Ticker>): { spot: number | null; forward: number | null } {
  const ts = Object.values(tickers);
  if (!ts.length) return { spot: null, forward: null };
  const idx = ts.map((t) => t.index).filter((v) => v > 0).sort((a, b) => a - b);
  const fw = ts.map((t) => t.forward).filter((v): v is number => v !== null && v > 0).sort((a, b) => a - b);
  const med = (a: number[]) => (a.length ? a[Math.floor(a.length / 2)]! : null);
  const spot = med(idx);
  return { spot, forward: med(fw) ?? spot };
}

export function smileFor(instruments: Instrument[], tickers: Record<string, Ticker>, expiryKey: string, type: "C" | "P"): SmilePoint[] {
  const pts: SmilePoint[] = [];
  for (const i of instruments) {
    if (i.expiryKey !== expiryKey || i.type !== type) continue;
    const iv = tickers[i.name]?.iv;
    if (iv && iv > 0) pts.push({ strike: i.strike, iv });
  }
  return pts;
}

export function probabilityFor(
  s: Pick<BuilderState, "dir" | "target">,
  instruments: Instrument[],
  tickers: Record<string, Ticker>,
  expiryKey: string,
  expiryMs: number,
  now: number,
): number | null {
  const { forward } = spotOf(tickers);
  if (!forward || !s.target) return null;
  const smile = smileFor(instruments, tickers, expiryKey, s.dir === "up" ? "C" : "P");
  return probabilityAt(s.dir, forward, s.target, yearsUntil(expiryMs, now), smile);
}

export function liveQuote(
  s: BuilderState,
  instruments: Instrument[],
  tickers: Record<string, Ticker> | null,
  expiryMs: number | null,
  now: number,
): QuoteResult & { spot: number | null } {
  if (!tickers || !s.expiryKey || expiryMs === null) return { quote: null, fail: "no-data", probability: null, spot: null };
  const { spot } = spotOf(tickers);
  if (!spot || !s.target) return { quote: null, fail: "no-data", probability: null, spot };
  const probability = probabilityFor(s, instruments, tickers, s.expiryKey, expiryMs, now);
  const sel = selectSpread(instruments, tickers, spot, s.target, s.dir, s.expiryKey, now);
  if (!sel.ok) return { quote: null, fail: sel.reason, probability, spot };
  const q = quoteSpread(sel.legs, s.amount);
  if (!q.ok) return { quote: null, fail: q.reason, probability, spot };
  return { quote: q.quote, fail: null, probability, spot };
}
