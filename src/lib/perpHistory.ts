// Perp trade history: realised P&L per perp (average cost, the method Derive
// reports), fees, and funding paid or received (private/get_funding_history).

import { applyFill, isPerpName, type CostBasis } from "./perp.ts";
import type { TradeRow } from "./history.ts";

export interface PerpLedger {
  instrument: string;
  trades: number;
  volume: number; // base units traded
  realized: number; // excluding fees
  fees: number;
  size: number; // open size left by these trades (signed)
  entry: number; // average entry of what is left
  exchangeRealized: number | null; // sum of the exchange's realized_pnl (incl. fees) when every trade carries it
  firstAt: number;
  lastAt: number;
}

/** Walk trades oldest → newest through an average-cost position per perp. */
export function perpLedger(trades: TradeRow[]): PerpLedger[] {
  const m = new Map<string, PerpLedger & { pos: CostBasis; exAll: boolean }>();
  for (const t of [...trades].filter((x) => isPerpName(x.instrument)).sort((a, b) => a.timestamp - b.timestamp || a.tradeId.localeCompare(b.tradeId))) {
    const l = m.get(t.instrument) ?? { instrument: t.instrument, trades: 0, volume: 0, realized: 0, fees: 0, size: 0, entry: 0, exchangeRealized: 0, firstAt: t.timestamp, lastAt: t.timestamp, pos: { size: 0, entry: 0 }, exAll: true };
    const r = applyFill(l.pos, t.direction, t.amount, t.price);
    l.pos = r.pos;
    l.realized += r.realized;
    l.fees += t.fee;
    l.trades++;
    l.volume += t.amount;
    l.lastAt = t.timestamp;
    if (t.realizedPnl === null) l.exAll = false;
    else l.exchangeRealized = (l.exchangeRealized ?? 0) + t.realizedPnl;
    m.set(t.instrument, l);
  }
  return [...m.values()].map(({ pos, exAll, ...l }) => ({ ...l, size: pos.size, entry: pos.entry, exchangeRealized: exAll ? l.exchangeRealized : null })).sort((a, b) => b.lastAt - a.lastAt);
}

export interface FundingEvent {
  instrument: string;
  funding: number; // + received, − paid
  pnl: number; // perp settlement P&L of the same event
  timestamp: number;
}

export function parseFunding(raw: unknown): FundingEvent[] {
  const list = (raw as { events?: unknown[] } | null)?.events;
  if (!Array.isArray(list)) return [];
  const out: FundingEvent[] = [];
  for (const e of list) {
    if (typeof e !== "object" || e === null) continue;
    const r = e as Record<string, unknown>;
    const f = Number(r.funding), ts = Number(r.timestamp);
    if (typeof r.instrument_name !== "string" || !Number.isFinite(f) || !Number.isFinite(ts)) continue;
    out.push({ instrument: r.instrument_name, funding: f, pnl: Number.isFinite(Number(r.pnl)) ? Number(r.pnl) : 0, timestamp: ts });
  }
  return out.sort((a, b) => b.timestamp - a.timestamp);
}

export function fundingByInstrument(events: FundingEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) out[e.instrument] = (out[e.instrument] ?? 0) + e.funding;
  return out;
}

export interface PerpHistoryRow extends PerpLedger {
  funding: number;
  net: number; // realised − fees + funding
}

export function perpHistoryRows(trades: TradeRow[], funding: FundingEvent[]): { rows: PerpHistoryRow[]; total: number } {
  const f = fundingByInstrument(funding);
  const rows = perpLedger(trades).map((l) => ({ ...l, funding: f[l.instrument] ?? 0, net: l.realized - l.fees + (f[l.instrument] ?? 0) }));
  for (const [inst, v] of Object.entries(f)) if (!rows.some((r) => r.instrument === inst)) rows.push({ instrument: inst, trades: 0, volume: 0, realized: 0, fees: 0, size: 0, entry: 0, exchangeRealized: null, firstAt: 0, lastAt: 0, funding: v, net: v });
  return { rows, total: rows.reduce((s, r) => s + r.net, 0) };
}
