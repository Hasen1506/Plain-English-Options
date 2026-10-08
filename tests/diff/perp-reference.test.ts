// Differential test: the app's perp maths (src/lib/perp.ts, floats + closed
// forms) against an independent reference written here from first principles
// in EXACT rational arithmetic (BigInt fractions) with different algorithms:
//   sizing        floor(risk·lev / price / step) · step, exact
//   P&L           total-cost-basis ledger (no entry price), exact
//   liquidation   bisection on the whole subaccount's equity − maintenance requirement
//   max fee       the options rule (src/lib/spread.ts maxFeePerUnit), already live-verified
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { applyFill, liquidationPrice, perpMaxFee, sizePerp, type CostBasis } from "../../src/lib/perp.ts";
import { maxFeePerUnit } from "../../src/lib/spread.ts";

// ---------- a tiny exact rational ----------
type Q = { n: bigint; d: bigint };
const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b));
const q = (n: bigint, d = 1n): Q => {
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
};
const dec = (s: string): Q => {
  const [w, f = ""] = s.replace("-", "").split(".");
  const v = q(BigInt(w + f), 10n ** BigInt(f.length));
  return s.startsWith("-") ? q(-v.n, v.d) : v;
};
const add = (a: Q, b: Q) => q(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Q, b: Q) => q(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Q, b: Q) => q(a.n * b.n, a.d * b.d);
const div = (a: Q, b: Q) => q(a.n * b.d, a.d * b.n);
const num = (a: Q) => Number(a.n) / Number(a.d);
const floorQ = (a: Q) => (a.n >= 0n ? a.n / a.d : -((-a.n + a.d - 1n) / a.d));
const sign = (a: Q) => (a.n > 0n ? 1 : a.n < 0n ? -1 : 0);
const abs = (a: Q) => q(a.n < 0n ? -a.n : a.n, a.d);
const minQ = (a: Q, b: Q) => (num(sub(a, b)) <= 0 ? a : b);
const cents = (lo: number, hi: number) => fc.integer({ min: lo * 100, max: hi * 100 }).map((x) => (x / 100).toFixed(2));

// ---------- reference implementations ----------
function refSize(risk: string, lev: string, price: string, step: string): Q {
  const raw = div(mul(dec(risk), dec(lev)), dec(price));
  return mul(q(floorQ(div(raw, dec(step)))), dec(step));
}

/** Total-cost-basis ledger: cost = Σ signed cash paid for the open size; realised on reductions in proportion. */
function refLedger(fills: { side: "buy" | "sell"; amount: string; price: string }[]) {
  let size = q(0n), cost = q(0n), realized = q(0n);
  for (const f of fills) {
    const d = f.side === "buy" ? dec(f.amount) : q(-dec(f.amount).n, dec(f.amount).d);
    const px = dec(f.price);
    if (sign(size) === 0 || sign(size) === sign(d)) {
      size = add(size, d);
      cost = add(cost, mul(d, px));
      continue;
    }
    const closing = minQ(abs(d), abs(size)); // amount of the old position closed
    const frac = div(closing, abs(size));
    const costClosed = mul(cost, frac);
    const proceeds = mul(mul(closing, px), q(BigInt(sign(size)))); // long sells receive, short buys pay
    realized = add(realized, sub(proceeds, costClosed));
    cost = sub(cost, costClosed);
    size = add(size, sign(d) > 0 ? closing : q(-closing.n, closing.d));
    const rest = sub(abs(d), closing);
    if (sign(rest) > 0) {
      const r = sign(d) > 0 ? rest : q(-rest.n, rest.d);
      size = add(size, r);
      cost = add(cost, mul(r, px));
    }
  }
  return { size, cost, realized };
}

/** Equity − maintenance requirement of a subaccount holding cash + one perp, at perp price P (bisection root). */
function refLiq(o: { collateral: number; size: number; entry: number; mm: number; price: number }): number | null {
  const f = (P: number) => o.collateral + o.size * (P - o.entry) - o.mm * Math.abs(o.size) * P;
  if (f(o.price) <= 0) return o.price;
  let lo: number, hi: number;
  if (o.size > 0) {
    if (f(0) > 0) return null;
    lo = 0;
    hi = o.price;
  } else {
    lo = o.price;
    hi = o.price * 2;
    let k = 0;
    while (f(hi) > 0 && k++ < 200) hi *= 2;
    if (f(hi) > 0) return null;
  }
  for (let i = 0; i < 200; i++) {
    const m = (lo + hi) / 2;
    if ((f(m) > 0) === (o.size > 0)) hi = m;
    else lo = m;
  }
  return (lo + hi) / 2;
}

describe("perp maths vs an independent exact reference", () => {
  it("sizing: identical contract count (when within the exchange limits)", () => {
    fc.assert(
      fc.property(cents(1, 50_000), fc.constantFrom("1", "2", "2.5", "3", "5", "7.5", "10"), cents(1, 120_000), fc.constantFrom("0.001", "0.01", "0.1", "1"), (risk, lev, price, step) => {
        const ours = sizePerp(Number(risk), Number(lev), Number(price), { minAmount: step, maxAmount: "100000000", amountStep: step });
        const ref = refSize(risk, lev, price, step);
        if (!ours || ours.belowMinimum || ours.tooLarge) {
          expect(num(ref)).toBeLessThan(Number(step) * 1.000001);
          return;
        }
        expect(Number(ours.amount)).toBe(num(ref));
      }),
    );
  });
  it("realised P&L and open size: float average-cost walk = exact cost-basis ledger", () => {
    const fill = fc.record({ side: fc.constantFrom("buy" as const, "sell" as const), amount: fc.integer({ min: 1, max: 5000 }).map((x) => (x / 1000).toFixed(3)), price: cents(100, 100_000) });
    fc.assert(
      fc.property(fc.array(fill, { minLength: 1, maxLength: 40 }), (fills) => {
        let p: CostBasis = { size: 0, entry: 0 };
        let realized = 0;
        for (const f of fills) {
          const r = applyFill(p, f.side, Number(f.amount), Number(f.price));
          p = r.pos;
          realized += r.realized;
        }
        const ref = refLedger(fills);
        const scale = 1 + fills.reduce((s, f) => s + Number(f.amount) * Number(f.price), 0);
        expect(Math.abs(realized - num(ref.realized))).toBeLessThan(1e-9 * scale);
        expect(Math.abs(p.size - num(ref.size))).toBeLessThan(1e-9);
        if (sign(ref.size) !== 0) expect(Math.abs(p.entry - num(div(ref.cost, ref.size)))).toBeLessThan(1e-7 * (1 + p.entry));
      }),
    );
  });
  it("liquidation price: closed form = bisection on the whole subaccount's equity", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -50_000, max: 50_000 }).filter((x) => x !== 0).map((x) => x / 1000),
        fc.integer({ min: 100, max: 200_000 }),
        fc.double({ min: 0.9, max: 1.1, noNaN: true }),
        fc.integer({ min: 0, max: 200_000 }),
        fc.constantFrom(0.01, 0.03, 0.05, 0.1),
        (size, entry, drift, collateral, mm) => {
          const price = entry * drift;
          // the app is given the exchange's headroom at the current price
          const headroom = collateral + size * (price - entry) - mm * Math.abs(size) * price;
          const ours = liquidationPrice({ size, price, headroom, mmReq: mm });
          const ref = refLiq({ collateral, size, entry, mm, price });
          if (ref === null || ours === null) {
            expect(ours === null && ref === null).toBe(true);
            return;
          }
          expect(Math.abs(ours - ref)).toBeLessThan(1e-6 * (1 + ref));
        },
      ),
    );
  });
  it("signed max fee: perps use exactly the options rule that Derive already accepted live", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 0.001, noNaN: true }), fc.double({ min: 0, max: 2, noNaN: true }), fc.double({ min: 0.01, max: 150_000, noNaN: true }), fc.double({ min: 0.01, max: 150_000, noNaN: true }), fc.double({ min: 0.001, max: 1000, noNaN: true }), (rate, base, index, price, amount) => {
        expect(perpMaxFee({ takerFeeRate: rate, baseFee: base }, index, price, amount)).toBe(maxFeePerUnit({ takerFeeRate: rate, baseFee: base }, index, price, amount));
      }),
    );
  });
});
