import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { AMOUNT_MAX, AMOUNT_MIN, initialState, reduce, sentence, type Action, type BuilderState } from "../../src/lib/state.ts";
import { ASSETS } from "../../src/config.ts";
import { expiryLabel, money, movePct, pct, price } from "../../src/lib/format.ts";

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.record({ type: fc.constant("amount" as const), value: fc.oneof(fc.double(), fc.double({ min: -1e7, max: 1e7, noNaN: true })) }),
  fc.record({ type: fc.constant("asset" as const), asset: fc.constantFrom(...ASSETS), spot: fc.option(fc.double({ min: -10, max: 2e5, noNaN: true })) }),
  fc.record({ type: fc.constant("toggleDir" as const), spot: fc.option(fc.double({ min: -10, max: 2e5, noNaN: true })) }),
  fc.record({ type: fc.constant("target" as const), value: fc.double() }),
  fc.record({ type: fc.constant("expiry" as const), key: fc.constantFrom("20261016", "20261127", "20261225") }),
  fc.record({ type: fc.constant("expiries" as const), list: fc.array(fc.record({ key: fc.constantFrom("20261016", "20261127", "20261225", "20270326"), days: fc.integer({ min: 0, max: 400 }) }), { maxLength: 5 }) }),
  fc.record({ type: fc.constant("spot" as const), spot: fc.double() }),
  fc.record({ type: fc.constant("open" as const), pop: fc.constantFrom("amt" as const, "asset" as const, "tgt" as const, "date" as const) }),
  fc.constant({ type: "close" as const }),
);

const valid = (s: BuilderState) =>
  Number.isFinite(s.amount) && s.amount >= AMOUNT_MIN && s.amount <= AMOUNT_MAX && (s.target === null || (s.target > 0 && Number.isFinite(s.target))) && (s.dir === "up" || s.dir === "down") && ASSETS.includes(s.asset);

describe("sentence builder state machine", () => {
  it("any sequence of actions keeps the state valid", () => {
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 40 }), (acts) => {
        let s = initialState();
        for (const a of acts) {
          s = reduce(s, a);
          if (!valid(s)) return false;
        }
        return true;
      }),
      { numRuns: 3000 },
    );
  });
  it("the sentence view never throws and the buy button needs a quote", () => {
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 20 }), fc.option(fc.double({ min: 0, max: 2e5, noNaN: true })), (acts, spot) => {
        const s = acts.reduce(reduce, initialState());
        const v = sentence(s, spot, "Nov 27", { quote: null, fail: "wrong-side", probability: null });
        expect(v.buyEnabled).toBe(false);
        expect(typeof v.cost).toBe("string");
      }),
      { numRuns: 1000 },
    );
  });
  it("toggling direction moves the default target to the other side of spot", () => {
    let s = reduce(initialState(), { type: "spot", spot: 2000 });
    expect(s.target).toBeCloseTo(2300);
    s = reduce(s, { type: "toggleDir", spot: 2000 });
    expect(s.dir).toBe("down");
    expect(s.target).toBeCloseTo(1700);
  });
  it("a typed target is kept exactly (not snapped to a strike)", () => {
    const s = reduce(initialState(), { type: "target", value: 3123.45 });
    expect(s.target).toBe(3123.45);
  });
  it("expiries: keeps the chosen date if still listed, else picks the one nearest 45 days", () => {
    let s = reduce(initialState(), { type: "expiries", list: [{ key: "a", days: 8 }, { key: "b", days: 50 }, { key: "c", days: 170 }] });
    expect(s.expiryKey).toBe("b");
    s = reduce(s, { type: "expiry", key: "c" });
    s = reduce(s, { type: "expiries", list: [{ key: "c", days: 169 }, { key: "b", days: 49 }] });
    expect(s.expiryKey).toBe("c");
  });
  it("wrong-side hint names the spot price", () => {
    const s = { ...initialState(), target: 2000 };
    expect(sentence(s, 2500, "Nov 27", { quote: null, fail: "wrong-side", probability: null }).hint).toContain("$2,500");
  });
});

describe("format", () => {
  it("money/price/pct", () => {
    expect(money(1595.4)).toBe("$1,595");
    expect(money(-12.5)).toBe("−$12.50");
    expect(price(96841.2)).toBe("$96,841");
    expect(price(0.7123)).toBe("$0.712");
    expect(price(null)).toBe("…");
    expect(pct(0.204)).toBe("20%");
    expect(movePct(100, 115)).toEqual({ text: "↑15%", down: false });
  });
  it("expiry labels", () => {
    const now = Date.UTC(2026, 9, 8);
    expect(expiryLabel("20261127", Date.UTC(2026, 10, 27, 8), now)).toMatchObject({ short: "Nov 27", long: "Nov 27, 2026", kind: "monthly", days: 50 });
    expect(expiryLabel("20261225", Date.UTC(2026, 11, 25, 8), now).kind).toBe("quarterly");
    expect(expiryLabel("20261016", Date.UTC(2026, 9, 16, 8), now).kind).toBe("weekly");
    expect(expiryLabel("20270326", Date.UTC(2027, 2, 26, 8), now).short).toBe("Mar 26 2027");
  });
});
