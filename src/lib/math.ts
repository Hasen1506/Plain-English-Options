// Normal distribution and Black-Scholes.
// normCdf is Hart (1968) / West (2005) "double precision" algorithm: accurate to
// ~1e-14 and monotone, unlike the 1.5e-7 Abramowitz-Stegun erf the prototype used.

export function normCdf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const z = Math.abs(x);
  let c: number;
  if (z > 37) {
    c = 0;
  } else {
    const e = Math.exp((-z * z) / 2);
    if (z < 7.07106781186547) {
      let n = 3.52624965998911e-2 * z + 0.700383064443688;
      n = n * z + 6.37396220353165;
      n = n * z + 33.912866078383;
      n = n * z + 112.079291497871;
      n = n * z + 221.213596169931;
      n = n * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      c = (e * n) / d;
    } else {
      let b = z + 0.65;
      b = z + 4 / b;
      b = z + 3 / b;
      b = z + 2 / b;
      b = z + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

export interface BsResult {
  call: number;
  put: number;
  d1: number;
  d2: number;
}

/** Undiscounted Black(-Scholes) prices with zero rates, as the prototype used. */
export function blackScholes(S: number, K: number, T: number, vol: number): BsResult {
  if (!(S > 0) || !(K > 0)) return { call: NaN, put: NaN, d1: NaN, d2: NaN };
  if (!(T > 0) || !(vol > 0)) {
    const call = Math.max(S - K, 0);
    const put = Math.max(K - S, 0);
    const d = S > K ? Infinity : S < K ? -Infinity : 0;
    return { call, put, d1: d, d2: d };
  }
  const sd = vol * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * vol * vol * T) / sd;
  const d2 = d1 - sd;
  const call = S * normCdf(d1) - K * normCdf(d2);
  const put = K * normCdf(-d2) - S * normCdf(-d1);
  return { call: Math.max(call, 0), put: Math.max(put, 0), d1, d2 };
}

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
