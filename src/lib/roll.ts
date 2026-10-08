// Count-up ("roll") between two displayed numbers, e.g. "$2,945" → "$3,100".
// Pure string maths so the tween is unit-tested; src/ui/motion.ts drives it.

export interface NumText {
  pre: string;
  value: number;
  decimals: number;
  commas: boolean;
  post: string;
}

/** The first number in a display string, with its formatting. Null when there is none. */
export function parseNumText(s: string): NumText | null {
  const m = /^(.*?)([−-]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(.*)$/s.exec(s);
  if (!m) return null;
  const int = m[3]!, frac = m[4] ?? "";
  const value = Number(int.replace(/,/g, "") + (frac ? "." + frac : "")) * (m[2] ? -1 : 1);
  if (!Number.isFinite(value)) return null;
  return { pre: m[1]!, value, decimals: frac.length, commas: int.includes(","), post: m[5]! };
}

function fmt(t: NumText, v: number): string {
  const a = Math.abs(v);
  const body = t.commas || a >= 1000
    ? a.toLocaleString("en-US", { minimumFractionDigits: t.decimals, maximumFractionDigits: t.decimals, useGrouping: t.commas })
    : a.toFixed(t.decimals);
  return t.pre + (v < 0 ? "−" : "") + body + t.post;
}

/** True when both strings carry a number we can count between. */
export const canRoll = (from: string, to: string): boolean => from !== to && parseNumText(from) !== null && parseNumText(to) !== null;

/**
 * The text at progress t (0..1) of a roll from `from` to `to`. Uses the target's
 * prefix, suffix and decimals throughout, and returns `to` exactly at t >= 1.
 */
export function rollText(from: string, to: string, t: number): string {
  const a = parseNumText(from), b = parseNumText(to);
  if (!a || !b || t >= 1) return to;
  const k = Math.max(0, t);
  return fmt(b, a.value + (b.value - a.value) * k);
}

/** Ease-out cubic. */
export const easeOut = (t: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
