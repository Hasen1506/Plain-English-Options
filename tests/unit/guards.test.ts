import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { confirmState, parseMaxCost, type ConfirmInput } from "../../src/lib/guards.ts";
import { MAINNET_PHRASE, QUOTE_MAX_AGE_MS } from "../../src/config.ts";
import type { SpreadQuote } from "../../src/lib/spread.ts";

const quoteArb = fc.record({
  maxLoss: fc.double({ min: 0.01, max: 1e6, noNaN: true }),
  worstLoss: fc.double({ min: 0.01, max: 1.1e6, noNaN: true }),
  priced: fc.constantFrom("book" as const, "mark" as const),
  depthOk: fc.boolean(),
});

const inputArb = fc.record({
  quote: fc.option(quoteArb),
  quoteAgeMs: fc.option(fc.double({ min: -1000, max: 3 * QUOTE_MAX_AGE_MS, noNaN: true })),
  connected: fc.boolean(),
  balance: fc.option(fc.double({ min: -100, max: 2e6, noNaN: true })),
  subaccountRU: fc.option(fc.integer({ min: 0, max: 4 })),
  assetRU: fc.option(fc.integer({ min: 0, max: 4 })),
  agreed: fc.boolean(),
  network: fc.constantFrom("testnet" as const, "mainnet" as const),
  typed: fc.oneof(fc.constant(MAINNET_PHRASE), fc.constant("real money "), fc.string()),
  busy: fc.boolean(),
  maxCost: fc.option(fc.double({ min: 0, max: 2e6, noNaN: true })),
});

const cast = (i: unknown) => i as ConfirmInput & { quote: SpreadQuote | null };

describe("confirm guard (property)", () => {
  it("is never enabled without a live price, with balance < max loss, or in the wrong risk universe", () => {
    fc.assert(
      fc.property(inputArb, (raw) => {
        const i = cast(raw);
        const c = confirmState(i);
        if (!c.enabled) return true;
        const q = i.quote!;
        expect(q).not.toBeNull();
        expect(q.priced).toBe("book");
        expect(i.quoteAgeMs).not.toBeNull();
        expect(i.quoteAgeMs!).toBeLessThanOrEqual(QUOTE_MAX_AGE_MS);
        expect(i.balance!).toBeGreaterThanOrEqual(q.worstLoss);
        expect(i.subaccountRU).not.toBeNull();
        expect(i.subaccountRU).toBe(i.assetRU);
        expect(i.connected && i.agreed && !i.busy && q.depthOk).toBe(true);
        if (i.network === "mainnet") expect(i.typed.trim().toUpperCase()).toBe(MAINNET_PHRASE);
        return true;
      }),
      { numRuns: 10000 },
    );
  });
  it("is enabled when everything is in order", () => {
    const base = { quote: { maxLoss: 100, worstLoss: 102, priced: "book", depthOk: true }, quoteAgeMs: 1000, connected: true, balance: 2000, subaccountRU: 1, assetRU: 1, agreed: true, network: "testnet", typed: "", busy: false };
    expect(confirmState(cast(base))).toMatchObject({ enabled: true, label: "Confirm and pay $100" });
    expect(confirmState(cast({ ...base, network: "mainnet" })).reason).toBe("phrase");
    expect(confirmState(cast({ ...base, network: "mainnet", typed: "real money" }))).toMatchObject({ enabled: true, label: "Pay real money: $100" });
    expect(confirmState(cast({ ...base, balance: 101 })).reason).toBe("balance"); // covers the cost but not the slippage cap
    expect(confirmState(cast({ ...base, subaccountRU: 0 })).reason).toBe("wrong-universe");
    expect(confirmState(cast({ ...base, quoteAgeMs: QUOTE_MAX_AGE_MS + 1 })).reason).toBe("stale");
  });
});

describe("optional mainnet per-trade limit", () => {
  it("is off by default: with no limit set, the cap never blocks", () => {
    fc.assert(fc.property(inputArb, (i) => confirmState(cast({ ...i, maxCost: undefined })).reason !== "cap" && confirmState(cast({ ...i, maxCost: null })).reason !== "cap"), { numRuns: 2000 });
  });

  it("when set, a mainnet trade whose worst case exceeds it is never enabled; testnet ignores it", () => {
    fc.assert(
      fc.property(inputArb, (i) => {
        const c = confirmState(cast(i));
        const over = i.network === "mainnet" && i.maxCost != null && i.maxCost > 0 && !!i.quote && i.quote.worstLoss > i.maxCost;
        return !(over && c.enabled) && !(i.network === "testnet" && c.reason === "cap");
      }),
      { numRuns: 3000 },
    );
  });

  it("parses the setting: empty, zero and junk mean off", () => {
    expect(parseMaxCost(null)).toBeNull();
    expect(parseMaxCost("")).toBeNull();
    expect(parseMaxCost("0")).toBeNull();
    expect(parseMaxCost("abc")).toBeNull();
    expect(parseMaxCost("$1,250")).toBe(1250);
    expect(parseMaxCost(" 75.5 ")).toBe(75.5);
  });
});
