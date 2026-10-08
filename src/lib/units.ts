// Exact decimal handling for amounts and prices. Everything that is signed or
// sent to the exchange goes through these helpers, never through float maths.

const E18 = 10n ** 18n;
const DEC_RE = /^-?\d+(\.\d+)?$/;

/** Parse a plain decimal string (no exponent) into an integer scaled by 1e18. */
export function toE18(value: string): bigint {
  const s = value.trim();
  if (!DEC_RE.test(s)) throw new Error(`invalid decimal: ${JSON.stringify(value)}`);
  const neg = s.startsWith("-");
  const [whole = "0", frac = ""] = (neg ? s.slice(1) : s).split(".");
  if (frac.length > 18) throw new Error(`more than 18 decimals: ${value}`);
  const v = BigInt(whole) * E18 + BigInt((frac + "0".repeat(18)).slice(0, 18));
  return neg ? -v : v;
}

/** Render an e18-scaled integer as a minimal plain decimal string. */
export function fromE18(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / E18;
  const frac = (a % E18).toString().padStart(18, "0").replace(/0+$/, "");
  const out = frac ? `${whole}.${frac}` : `${whole}`;
  return neg && out !== "0" ? `-${out}` : out;
}

/** A finite JS number as a plain decimal string with at most 12 decimals (protocol precision). */
export function numToDec(x: number): string {
  if (!Number.isFinite(x)) throw new Error(`not finite: ${x}`);
  return fromE18(toE18(x.toFixed(12)));
}

function step18(step: string): bigint {
  const s = toE18(step);
  if (s <= 0n) throw new Error(`step must be positive: ${step}`);
  return s;
}

/** Largest multiple of `step` that is <= x (x >= 0). */
export function alignDown(x: number, step: string): string {
  const s = step18(step);
  const v = toE18(x.toFixed(12));
  const q = v >= 0n ? v / s : -((-v + s - 1n) / s);
  return fromE18(q * s);
}

/** Smallest multiple of `step` that is >= x. */
export function alignUp(x: number, step: string): string {
  const s = step18(step);
  const v = toE18(x.toFixed(12));
  const q = v >= 0n ? (v + s - 1n) / s : -(-v / s);
  return fromE18(q * s);
}

export function isAligned(value: string, step: string): boolean {
  return toE18(value) % step18(step) === 0n;
}

export const dec = (v: string): number => Number(v);
