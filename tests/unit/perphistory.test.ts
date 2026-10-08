// Perp history and margin against what Derive itself reported during the live
// testnet run (tests/fixtures/perps-testnet-private.json, recorded by
// RECORD_FIXTURES=1 npm run test:live -- perps): our realised P&L per fill,
// fees, funding, and per-position margin requirements.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applyFill, imRequirement, mmRequirement, parsePerpInstruments, type CostBasis } from "../../src/lib/perp.ts";
import { fundingByInstrument, parseFunding, perpHistoryRows, perpLedger } from "../../src/lib/perpHistory.ts";
import { parseTrades } from "../../src/lib/history.ts";
import { parseSubaccount } from "../../src/lib/ticker.ts";

type Frame = { method: string; params: Record<string, unknown>; result: Record<string, unknown> };
const priv = JSON.parse(readFileSync(new URL("../fixtures/perps-testnet-private.json", import.meta.url), "utf8")) as { orders: Record<string, string>; frames: Frame[] };
const pub = JSON.parse(readFileSync(new URL("../fixtures/perps-testnet.json", import.meta.url), "utf8")) as { frames: Frame[] };
const eth = parsePerpInstruments(pub.frames.find((f) => f.method === "public/get_all_instruments")!.result).find((i) => i.name === "ETH-PERP")!;
const lastOf = (m: string) => priv.frames.filter((f) => f.method === m).at(-1)!.result;
const ours = new Set(Object.values(priv.orders));
const rawTrades = (lastOf("private/get_trade_history").trades as Record<string, string>[]).filter((t) => ours.has(t.order_id!));

describe("realised P&L vs Derive (live testnet fills)", () => {
  it("the run left 9 fills of our own orders, netting to flat", () => {
    expect(rawTrades.length).toBe(9);
    const ledger = perpLedger(parseTrades({ trades: rawTrades })).find((l) => l.instrument === "ETH-PERP")!;
    expect(Math.abs(ledger.size)).toBeLessThan(1e-12);
  });
  it("every fill: our average-cost realised P&L (ex fees) = Derive's realized_pnl_excl_fees", () => {
    let pos: CostBasis = { size: 0, entry: 0 };
    const sorted = [...rawTrades].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
    for (const t of sorted) {
      const r = applyFill(pos, t.direction as "buy" | "sell", Number(t.trade_amount), Number(t.trade_price));
      pos = r.pos;
      expect(Math.abs(r.realized - Number(t.realized_pnl_excl_fees)), `${t.label} ${t.trade_id}`).toBeLessThan(1e-6);
    }
  });
  it("total after fees = Σ realized_pnl the exchange reports", () => {
    const l = perpLedger(parseTrades({ trades: rawTrades })).find((x) => x.instrument === "ETH-PERP")!;
    const exch = rawTrades.reduce((s, t) => s + Number(t.realized_pnl), 0);
    expect(Math.abs(l.realized - l.fees - exch)).toBeLessThan(1e-6);
    expect(l.exchangeRealized).not.toBeNull();
    expect(Math.abs(l.exchangeRealized! - exch)).toBeLessThan(1e-9);
  });
});

describe("funding", () => {
  it("funding history parses; History adds it to the net", () => {
    const ev = parseFunding(lastOf("private/get_funding_history"));
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((e) => e.instrument.endsWith("-PERP"))).toBe(true);
    const total = fundingByInstrument(ev)["ETH-PERP"] ?? 0;
    const { rows, total: net } = perpHistoryRows(parseTrades({ trades: rawTrades }), ev);
    const r = rows.find((x) => x.instrument === "ETH-PERP")!;
    expect(r.net).toBeCloseTo(r.realized - r.fees + total, 9);
    expect(net).toBeCloseTo(rows.reduce((s, x) => s + x.net, 0), 9);
  });
  it("junk funding replies are empty, not errors", () => {
    expect(parseFunding(null)).toEqual([]);
    expect(parseFunding({ events: [{ instrument_name: 1 }, null] })).toEqual([]);
  });
});

describe("margin requirements vs Derive", () => {
  it("open position: our IM / MM fractions of index notional match the exchange's per-position margin (net of mark value)", () => {
    const withPos = priv.frames.filter((f) => f.method === "private/get_subaccount").map((f) => f.result).find((r) => (r.positions as unknown[]).length)!;
    const p = (withPos.positions as Record<string, string>[])[0]!;
    const size = Number(p.amount), index = Number(p.index_price), mv = Number(p.mark_value);
    expect(Math.abs(imRequirement(eth, size, index) - mv - -Number(p.initial_margin))).toBeLessThan(0.05);
    expect(Math.abs(mmRequirement(eth, size, index) - mv - -Number(p.maintenance_margin))).toBeLessThan(0.05);
    const s = parseSubaccount(withPos)!;
    expect(s.positions[0]!.instrumentType).toBe("perp");
    expect(s.maintenanceMargin).toBeGreaterThan(s.initialMargin);
  });
  it("private/get_margin: the simulated trade moves maintenance headroom by ≈ mm × size × price", () => {
    const g = priv.frames.find((f) => f.method === "private/get_margin")!;
    const n = Number((g.params.simulated_position_changes as { amount: string }[])[0]!.amount);
    const drop = Number(g.result.pre_maintenance_margin) - Number(g.result.post_maintenance_margin);
    const ticker = Number(pub.frames.find((f) => f.method === "public/get_ticker" && f.params.instrument_name === "ETH-PERP")!.result.I);
    expect(drop / mmRequirement(eth, n, 1)).toBeGreaterThan(ticker * 0.9); // implied price within 10% of the recorded index
    expect(drop / mmRequirement(eth, n, 1)).toBeLessThan(ticker * 1.1);
  });
});
