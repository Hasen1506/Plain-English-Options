// Hyperliquid order rules (docs: for-developers/api/tick-and-lot-size, exchange-endpoint):
//   * size: at most szDecimals decimals (lot = 10^-szDecimals)
//   * price (perps): at most 5 significant figures AND at most 6 − szDecimals
//     decimals; integer prices are always allowed
//   * $10 minimum order value (sz × px), reduce-only closes excepted
//   * wire format: plain decimal, trailing zeros removed (the hash is over the string)
// Everything here is exact decimal maths on strings/bigints, never float rounding.

import { alignDown, alignUp, fromE18, toE18 } from "../../lib/units.ts";

export const MAX_PERP_DECIMALS = 6;
export const MIN_ORDER_USD = 10;

const pow10 = (n: number) => 10n ** BigInt(n);

/** Lot size string for szDecimals: 3 → "0.001", 0 → "1". */
export const lotSize = (szDecimals: number): string => (szDecimals <= 0 ? "1" : "0." + "0".repeat(szDecimals - 1) + "1");

/** Normalised wire decimal: "1.2300" → "1.23", "5.0" → "5", "-0" → "0". */
export function toWire(dec: string): string {
  const v = fromE18(toE18(dec));
  return v === "-0" ? "0" : v;
}

/** Number of significant digits of a plain decimal string (leading zeros dropped). */
export function sigFigs(dec: string): number {
  const d = dec.replace("-", "").replace(".", "").replace(/^0+/, "");
  const trimmed = dec.includes(".") ? d : d.replace(/0+$/, "");
  return Math.max(1, trimmed.length);
}

const decimalsOf = (dec: string) => (dec.includes(".") ? dec.split(".")[1]!.replace(/0+$/, "").length : 0);

/** Is `px` an acceptable perp price for an asset with these szDecimals? */
export function validPrice(px: string, szDecimals: number): boolean {
  if (!/^\d+(\.\d+)?$/.test(px) || !(Number(px) > 0)) return false;
  const w = toWire(px);
  if (!w.includes(".")) return true; // integer prices are always allowed
  return decimalsOf(w) <= MAX_PERP_DECIMALS - szDecimals && sigFigs(w) <= 5;
}

export const validSize = (sz: string, szDecimals: number): boolean => /^\d+(\.\d+)?$/.test(sz) && Number(sz) > 0 && decimalsOf(toWire(sz)) <= Math.max(0, szDecimals);

/**
 * The price step around `px`: the coarser of the 5-significant-figure step and
 * the decimals cap, never coarser than 1 (integers are always valid).
 */
export function priceStep(px: number, szDecimals: number): string {
  if (!(px > 0) || !Number.isFinite(px)) throw new Error("price must be positive");
  const mag = Math.floor(Math.log10(px));
  let e = mag - 4; // 5 significant figures
  // log10 can be off by one right at a power of ten
  if (px >= 10 ** (mag + 1)) e += 1;
  if (px < 10 ** mag) e -= 1;
  const minE = -(MAX_PERP_DECIMALS - szDecimals);
  e = Math.max(e, minE);
  if (e >= 0) return "1";
  return "0." + "0".repeat(-e - 1) + "1";
}

/** Round a price to a valid Hyperliquid price, down or up. Re-checks across a power-of-ten boundary. */
export function roundPrice(px: number, szDecimals: number, dir: "down" | "up"): string {
  let p = dir === "down" ? alignDown(px, priceStep(px, szDecimals)) : alignUp(px, priceStep(px, szDecimals));
  // rounding up can cross into the next decade (99999.5 → 100000), where the step is coarser: re-snap
  for (let i = 0; i < 3 && Number(p) > 0 && !validPrice(p, szDecimals); i++) {
    const n = Number(p);
    p = dir === "down" ? alignDown(n, priceStep(n, szDecimals)) : alignUp(n, priceStep(n, szDecimals));
  }
  if (!(Number(p) > 0)) p = toWire(priceStep(px, szDecimals));
  return toWire(p);
}

/** Size floored to the lot. */
export const roundSize = (sz: number, szDecimals: number): string => toWire(alignDown(Math.max(0, sz), lotSize(szDecimals)));

/** Smallest size whose value at `px` reaches $10 (plus a small cushion for mark moves). */
export function minSizeFor(px: number, szDecimals: number, cushion = 0.01): string {
  return toWire(alignUp((MIN_ORDER_USD * (1 + cushion)) / px, lotSize(szDecimals)));
}

/** Order value check the exchange applies to every non-reduce-only order. */
export const meetsMinimum = (sz: string, px: string): boolean => Number(sz) * Number(px) >= MIN_ORDER_USD - 1e-9;

/** Exact integer helpers for tests. */
export const scaled = (dec: string, decimals: number): bigint => (toE18(dec) * pow10(decimals)) / pow10(18);
