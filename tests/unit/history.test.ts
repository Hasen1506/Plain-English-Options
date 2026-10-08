import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { closedSpreads, parseOrders, parseTrades, summariseLegs, type TradeRow } from "../../src/lib/history.ts";

const tr = (p: Partial<TradeRow> & { instrument: string; direction: "buy" | "sell"; price: number; amount: number }, i: number): TradeRow => ({ tradeId: `t${i}`, orderId: `o${i}`, fee: 0, timestamp: 1000 + i, realizedPnl: null, ...p });

describe("history parsing", () => {
  it("parses trade and order history frames, skipping junk, newest first", () => {
    const t = parseTrades({ trades: [{ instrument_name: "ETH-20261016-2600-C", direction: "buy", trade_price: "51.5", trade_amount: "1", trade_fee: "1.27", timestamp: 5, trade_id: "a", order_id: "x" }, { instrument_name: "X", trade_amount: "0" }, null, { instrument_name: "ETH-20261016-2700-C", direction: "sell", trade_price: "17.7", trade_amount: "1", trade_fee: "1.28", timestamp: 6, trade_id: "b" }] });
    expect(t.map((x) => x.tradeId)).toEqual(["b", "a"]);
    expect(t[1]).toMatchObject({ price: 51.5, amount: 1, fee: 1.27, direction: "buy" });
    const o = parseOrders({ orders: [{ order_id: "1", instrument_name: "I", direction: "sell", amount: "2", filled_amount: "1", limit_price: "3", average_price: "3", order_status: "cancelled", creation_timestamp: 9, label: "peo" }, { order_id: 5 }] });
    expect(o).toEqual([{ orderId: "1", instrument: "I", direction: "sell", amount: 2, filled: 1, limitPrice: 3, avgPrice: 3, status: "cancelled", timestamp: 9, label: "peo" }]);
    expect(parseTrades(null)).toEqual([]);
  });

  it("the first live testnet spread: open 2600/2700 at 51.5/17.7, close at 22.8/110.9 style numbers", () => {
    const trades = [
      tr({ instrument: "ETH-20261016-2500-C", direction: "buy", price: 114.9, amount: 0.1, fee: 0.577 }, 0),
      tr({ instrument: "ETH-20261016-2700-C", direction: "sell", price: 18.8, amount: 0.1, fee: 0.577 }, 1),
      tr({ instrument: "ETH-20261016-2700-C", direction: "buy", price: 22.8, amount: 0.1, fee: 0.577 }, 2),
      tr({ instrument: "ETH-20261016-2500-C", direction: "sell", price: 110.9, amount: 0.1, fee: 0.577 }, 3),
    ];
    const { spreads, open } = closedSpreads(trades);
    expect(open).toEqual([]);
    expect(spreads).toHaveLength(1);
    // (110.9 − 114.9) × 0.1 + (18.8 − 22.8) × 0.1 − 4 × 0.577
    expect(spreads[0]!.pnl).toBeCloseTo(-0.4 - 0.4 - 2.308, 9);
    expect(spreads[0]!.size).toBeCloseTo(0.1, 12);
    expect(spreads[0]!.long.instrument).toBe("ETH-20261016-2500-C");
  });

  it("legs that are still open are not counted as closed", () => {
    const { spreads, open } = closedSpreads([tr({ instrument: "A-20261016-1-C", direction: "buy", price: 1, amount: 1 }, 0), tr({ instrument: "A-20261016-2-C", direction: "sell", price: 0.5, amount: 1 }, 1)]);
    expect(spreads).toEqual([]);
    expect(open.map((l) => l.instrument).sort()).toEqual(["A-20261016-1-C", "A-20261016-2-C"]);
  });
});

describe("P&L math (properties)", () => {
  const legArb = fc.record({
    n: fc.integer({ min: 1, max: 10_000 }).map((x) => x / 100),
    open1: fc.integer({ min: 1, max: 100_000 }).map((x) => x / 10),
    open2: fc.integer({ min: 0, max: 100_000 }).map((x) => x / 10),
    close1: fc.integer({ min: 0, max: 100_000 }).map((x) => x / 10),
    close2: fc.integer({ min: 0, max: 100_000 }).map((x) => x / 10),
    fee: fc.integer({ min: 0, max: 1000 }).map((x) => x / 100),
    k: fc.integer({ min: 1, max: 9 }),
  });

  it("a closed spread's P&L = n × ((close long − open long) − (close short − open short)) − all fees", () => {
    fc.assert(
      fc.property(legArb, ({ n, open1, open2, close1, close2, fee, k }) => {
        const L = `ETH-2026101${k}-2500-C`, S = `ETH-2026101${k}-2700-C`;
        const trades = [
          tr({ instrument: L, direction: "buy", price: open1, amount: n, fee }, 0),
          tr({ instrument: S, direction: "sell", price: open2, amount: n, fee }, 1),
          tr({ instrument: S, direction: "buy", price: close2, amount: n, fee }, 2),
          tr({ instrument: L, direction: "sell", price: close1, amount: n, fee }, 3),
        ];
        const { spreads } = closedSpreads(trades);
        const want = n * (close1 - open1 - (close2 - open2)) - 4 * fee;
        return spreads.length === 1 && Math.abs(spreads[0]!.pnl - want) < 1e-6 * Math.max(1, Math.abs(want));
      }),
      { numRuns: 1500 },
    );
  });

  it("conservation: total P&L of closed legs equals spreads + unmatched closed legs, for any shuffled history", () => {
    const histArb = fc.array(
      fc.record({ inst: fc.constantFrom("ETH-20261016-2500-C", "ETH-20261016-2700-C", "BTC-20261016-90000-P", "ETH-20261023-2500-C"), side: fc.constantFrom<"buy" | "sell">("buy", "sell"), px: fc.integer({ min: 1, max: 5000 }), amt: fc.integer({ min: 1, max: 5 }), fee: fc.integer({ min: 0, max: 50 }) }),
      { maxLength: 40 },
    );
    fc.assert(
      fc.property(histArb, (h) => {
        const trades = h.map((x, i) => tr({ instrument: x.inst, direction: x.side, price: x.px / 10, amount: x.amt / 10, fee: x.fee / 100 }, i));
        const legs = summariseLegs(trades);
        const closedTotal = legs.filter((l) => Math.abs(l.net) < 1e-9).reduce((s, l) => s + l.pnl, 0);
        const r = closedSpreads(trades);
        const parts = r.spreads.reduce((s, x) => s + x.pnl, 0) + r.closedSingles.reduce((s, l) => s + l.pnl, 0);
        const allFees = trades.reduce((s, t) => s + t.fee, 0);
        const legFees = legs.reduce((s, l) => s + l.fees, 0);
        return Math.abs(closedTotal - parts) < 1e-6 && Math.abs(allFees - legFees) < 1e-9 && r.spreads.every((s) => s.long !== s.short);
      }),
      { numRuns: 1500 },
    );
  });
});
