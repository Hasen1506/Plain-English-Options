// Order and trade history, and realised P&L per closed spread.
// A leg is closed when its traded amounts net to zero; its P&L is the cash it
// produced (sells − buys) minus every fee. Two closed legs of the same
// currency, expiry and type, one opened long and one opened short with the same
// total size, form a closed spread; its P&L is the sum of the two legs.
// Settlement at expiry is not a trade, so expired positions show as open here.

export interface TradeRow {
  tradeId: string;
  orderId: string;
  instrument: string;
  direction: "buy" | "sell";
  price: number;
  amount: number;
  fee: number;
  timestamp: number;
  realizedPnl: number | null;
}

export interface OrderRow {
  orderId: string;
  instrument: string;
  direction: "buy" | "sell";
  amount: number;
  filled: number;
  limitPrice: number;
  avgPrice: number;
  status: string;
  timestamp: number;
  label: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, d = 0) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
};

export function parseTrades(raw: unknown): TradeRow[] {
  const list = isObj(raw) && Array.isArray(raw.trades) ? raw.trades : Array.isArray(raw) ? raw : [];
  const out: TradeRow[] = [];
  for (const t of list) {
    if (!isObj(t) || typeof t.instrument_name !== "string") continue;
    const amount = num(t.trade_amount, NaN);
    if (!(amount > 0)) continue;
    out.push({
      tradeId: String(t.trade_id ?? ""),
      orderId: String(t.order_id ?? ""),
      instrument: t.instrument_name,
      direction: t.direction === "sell" ? "sell" : "buy",
      price: num(t.trade_price),
      amount,
      fee: num(t.trade_fee),
      timestamp: num(t.timestamp),
      realizedPnl: t.realized_pnl !== undefined && t.realized_pnl !== null ? num(t.realized_pnl) : null,
    });
  }
  return out.sort((a, b) => b.timestamp - a.timestamp || a.tradeId.localeCompare(b.tradeId));
}

export function parseOrders(raw: unknown): OrderRow[] {
  const list = isObj(raw) && Array.isArray(raw.orders) ? raw.orders : Array.isArray(raw) ? raw : [];
  const out: OrderRow[] = [];
  for (const o of list) {
    if (!isObj(o) || typeof o.order_id !== "string" || typeof o.instrument_name !== "string") continue;
    out.push({
      orderId: o.order_id,
      instrument: o.instrument_name,
      direction: o.direction === "sell" ? "sell" : "buy",
      amount: num(o.amount),
      filled: num(o.filled_amount),
      limitPrice: num(o.limit_price),
      avgPrice: num(o.average_price),
      status: typeof o.order_status === "string" ? o.order_status : "unknown",
      timestamp: num(o.creation_timestamp ?? o.last_update_timestamp ?? o.timestamp),
      label: typeof o.label === "string" ? o.label : "",
    });
  }
  return out.sort((a, b) => b.timestamp - a.timestamp);
}

export interface LegSummary {
  instrument: string;
  bought: number;
  sold: number;
  net: number; // bought − sold
  cash: number; // sell proceeds − buy cost, before fees
  fees: number;
  pnl: number; // cash − fees (meaningful once net = 0)
  firstSide: "buy" | "sell";
  openedAt: number;
  closedAt: number;
}

const EPS = 1e-9;

export function summariseLegs(trades: TradeRow[]): LegSummary[] {
  const m = new Map<string, LegSummary>();
  for (const t of [...trades].sort((a, b) => a.timestamp - b.timestamp || a.tradeId.localeCompare(b.tradeId))) {
    const s = m.get(t.instrument) ?? { instrument: t.instrument, bought: 0, sold: 0, net: 0, cash: 0, fees: 0, pnl: 0, firstSide: t.direction, openedAt: t.timestamp, closedAt: t.timestamp };
    if (t.direction === "buy") {
      s.bought += t.amount;
      s.cash -= t.price * t.amount;
    } else {
      s.sold += t.amount;
      s.cash += t.price * t.amount;
    }
    s.fees += t.fee;
    s.net = s.bought - s.sold;
    s.pnl = s.cash - s.fees;
    s.closedAt = t.timestamp;
    m.set(t.instrument, s);
  }
  return [...m.values()];
}

export interface ClosedSpread {
  long: LegSummary;
  short: LegSummary;
  size: number;
  pnl: number;
  fees: number;
  openedAt: number;
  closedAt: number;
}

const family = (name: string) => name.replace(/-[\d_.]+-([CP])$/, "-$1");

export function closedSpreads(trades: TradeRow[]): { spreads: ClosedSpread[]; closedSingles: LegSummary[]; open: LegSummary[] } {
  const legs = summariseLegs(trades);
  const closed = legs.filter((l) => Math.abs(l.net) < EPS);
  const open = legs.filter((l) => Math.abs(l.net) >= EPS);
  const longs = closed.filter((l) => l.firstSide === "buy").sort((a, b) => a.openedAt - b.openedAt);
  const shorts = closed.filter((l) => l.firstSide === "sell").sort((a, b) => a.openedAt - b.openedAt);
  const spreads: ClosedSpread[] = [];
  const used = new Set<LegSummary>();
  for (const L of longs) {
    const S = shorts.find((s) => !used.has(s) && family(s.instrument) === family(L.instrument) && Math.abs(s.sold - L.bought) < EPS);
    if (!S) continue;
    used.add(S);
    used.add(L);
    spreads.push({ long: L, short: S, size: L.bought, pnl: L.pnl + S.pnl, fees: L.fees + S.fees, openedAt: Math.min(L.openedAt, S.openedAt), closedAt: Math.max(L.closedAt, S.closedAt) });
  }
  return { spreads: spreads.sort((a, b) => b.closedAt - a.closedAt), closedSingles: closed.filter((l) => !used.has(l)), open };
}
