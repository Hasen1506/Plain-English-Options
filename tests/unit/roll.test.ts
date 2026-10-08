import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canRoll, easeOut, parseNumText, rollText } from "../../src/lib/roll.ts";
import { changeText, parseIndexChart, sparkPath, sparkSvg, indexChartParams } from "../../src/lib/spark.ts";
import rec from "../fixtures/index-chart-testnet.json" with { type: "json" };

describe("number roll", () => {
  it("parses display numbers with their formatting", () => {
    expect(parseNumText("$2,945")).toEqual({ pre: "$", value: 2945, decimals: 0, commas: true, post: "" });
    expect(parseNumText("It costs $606")).toMatchObject({ pre: "It costs $", value: 606 });
    expect(parseNumText("ADA $0.254")).toMatchObject({ pre: "ADA $", value: 0.254, decimals: 3 });
    expect(parseNumText("20% chance it happens")).toMatchObject({ value: 20, post: "% chance it happens" });
    expect(parseNumText("−$1,529")).toMatchObject({ pre: "−$", value: 1529 });
    expect(parseNumText("−5")).toMatchObject({ value: -5 });
    expect(parseNumText("…")).toBeNull();
  });
  it("lands exactly on the target and uses its format on the way", () => {
    expect(rollText("$2,945", "$3,100", 1)).toBe("$3,100");
    expect(rollText("$2,945", "$3,100", 0)).toBe("$2,945");
    expect(rollText("ETH $2,580", "BTC $82,815", 0.5)).toMatch(/^BTC \$\d{2},\d{3}$/);
    expect(rollText("$900", "$1,200", 0.5)).toBe("$1,050");
    expect(rollText("…", "$1,200", 0.5)).toBe("$1,200");
    expect(canRoll("…", "$5")).toBe(false);
    expect(canRoll("$5", "$5")).toBe(false);
  });
  it("is monotonic between the two values", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1e6 }), fc.integer({ min: 1, max: 1e6 }), fc.double({ min: 0, max: 0.99, noNaN: true }), fc.double({ min: 0, max: 0.99, noNaN: true }), (a, b, t1, t2) => {
        const [lo, hi] = t1 < t2 ? [t1, t2] : [t2, t1];
        const v = (t: number) => parseNumText(rollText("$" + a.toLocaleString("en-US"), "$" + b.toLocaleString("en-US"), easeOut(t)))!.value;
        return b >= a ? v(lo) <= v(hi) + 1 : v(lo) >= v(hi) - 1;
      }),
    );
  });
});

describe("sparklines", () => {
  it("parses recorded testnet index candles oldest first", () => {
    const eth = parseIndexChart((rec.series as Record<string, unknown>).ETH);
    expect(eth.length).toBe(24);
    expect(eth.every((p) => p > 100)).toBe(true);
  });
  it("drops junk and sorts by time", () => {
    expect(parseIndexChart([{ close_price: "2", timestamp: 2 }, { close_price: "x", timestamp: 3 }, { close_price: "1", timestamp: 1 }, null])).toEqual([1, 2]);
    expect(parseIndexChart({ error: "nope" })).toEqual([]);
  });
  it("draws nothing without data, a path inside the box with data", () => {
    expect(sparkPath([])).toBeNull();
    expect(sparkPath([5])).toBeNull();
    expect(sparkSvg([])).toBe("");
    const d = sparkPath([1, 3, 2], 60, 20)!;
    for (const [, x, y] of d.matchAll(/[ML]([\d.]+) ([\d.]+)/g)) {
      expect(+x!).toBeGreaterThanOrEqual(0);
      expect(+x!).toBeLessThanOrEqual(60);
      expect(+y!).toBeGreaterThanOrEqual(0);
      expect(+y!).toBeLessThanOrEqual(20);
    }
    expect(sparkSvg([1, 2])).toContain("#22a45a");
    expect(sparkSvg([2, 1])).toContain("#d0453a");
  });
  it("formats the 24h change without a sign on a flat 0.0", () => {
    expect(changeText(0.0123)).toBe("+1.2%");
    expect(changeText(-0.007)).toBe("-0.7%");
    expect(changeText(0.0001)).toBe("0.0%");
    expect(changeText(-0.0001)).toBe("0.0%");
  });
  it("asks for the last 24 h of hourly candles in seconds", () => {
    expect(indexChartParams("ETH", 1_791_451_828_000)).toEqual({ currency: "ETH", start_timestamp: 1_791_365_428, end_timestamp: 1_791_451_828, period: 3600 });
  });
});
