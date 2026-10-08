// Parsers for Derive v3 frames. They never throw: malformed input yields null
// (or is skipped), so a bad frame can never take the app down.

export interface Ticker {
  ts: number; // exchange timestamp, ms
  ask: number; // 0 = no ask
  askSize: number;
  bid: number; // 0 = no bid
  bidSize: number;
  mark: number;
  index: number;
  iv: number | null; // mark implied vol (fraction)
  forward: number | null;
  delta: number | null;
  minPrice: number | null; // exchange limit-price band
  maxPrice: number | null;
  change24h: number | null; // fraction, e.g. -0.046 = -4.6%
}

export interface Instrument {
  name: string;
  currency: string;
  type: "C" | "P";
  strike: number;
  expiry: number; // unix seconds
  expiryKey: string; // YYYYMMDD
  isActive: boolean;
  deactivation: number; // unix seconds
  tickSize: string;
  minAmount: string;
  maxAmount: string;
  amountStep: string;
  takerFeeRate: number;
  baseFee: number;
  markFeeCap: number;
  assetAddress: string;
  subId: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Finite number from a string/number field; `fallback` when missing or bad. */
function num(v: unknown, fallback: number): number;
function num(v: unknown, fallback: null): number | null;
function num(v: unknown, fallback: number | null): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

const pos = (v: number | null): number | null => (v !== null && v > 0 ? v : null);

/** Parse one slim v3 ticker (public/get_ticker result or a get_tickers entry). */
export function parseTicker(raw: unknown): Ticker | null {
  if (!isObj(raw)) return null;
  const mark = num(raw.M, 0);
  const index = num(raw.I, 0);
  if (!(mark >= 0) || !(index > 0)) return null;
  const op = isObj(raw.option_pricing) ? raw.option_pricing : null;
  const stats = isObj(raw.stats) ? raw.stats : null;
  return {
    ts: num(raw.t, 0),
    ask: Math.max(0, num(raw.a, 0)),
    askSize: Math.max(0, num(raw.A, 0)),
    bid: Math.max(0, num(raw.b, 0)),
    bidSize: Math.max(0, num(raw.B, 0)),
    mark,
    index,
    iv: op ? pos(num(op.i, null)) : null,
    forward: op ? pos(num(op.f, null)) : null,
    delta: op ? num(op.d, null) : null,
    minPrice: pos(num(raw.minp, null)),
    maxPrice: pos(num(raw.maxp, null)),
    change24h: stats ? num(stats.p, null) : null,
  };
}

/** Inverse of parseTicker (used by the mock server and round-trip tests). */
export function serializeTicker(t: Ticker): Record<string, unknown> {
  const s = (v: number | null) => (v === null ? null : String(v));
  const out: Record<string, unknown> = {
    t: t.ts,
    a: String(t.ask),
    A: String(t.askSize),
    b: String(t.bid),
    B: String(t.bidSize),
    M: String(t.mark),
    I: String(t.index),
    option_pricing: t.iv === null && t.forward === null && t.delta === null ? null : { i: s(t.iv), f: s(t.forward), d: s(t.delta) },
    stats: t.change24h === null ? null : { p: String(t.change24h) },
    minp: s(t.minPrice),
    maxp: s(t.maxPrice),
  };
  return out;
}

/** public/get_tickers result → map of instrument name → ticker (bad entries skipped). */
export function parseTickers(raw: unknown): Record<string, Ticker> {
  const out: Record<string, Ticker> = {};
  const tk = isObj(raw) && isObj(raw.tickers) ? raw.tickers : null;
  if (!tk) return out;
  for (const [name, v] of Object.entries(tk)) {
    const t = parseTicker(v);
    if (t) out[name] = t;
  }
  return out;
}

const NAME_RE = /^([A-Z0-9_]+)-(\d{8})-(\d+(?:_\d+)?(?:\.\d+)?)-([CP])$/;

export function parseInstrument(raw: unknown): Instrument | null {
  if (!isObj(raw) || raw.instrument_type !== "option" || typeof raw.instrument_name !== "string") return null;
  const m = NAME_RE.exec(raw.instrument_name);
  const od = isObj(raw.option_details) ? raw.option_details : null;
  if (!m || !od) return null;
  const strike = num(od.strike, NaN);
  const expiry = num(od.expiry, NaN);
  const type = od.option_type;
  const str = (v: unknown) => (typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? v : null);
  const tickSize = str(raw.tick_size), minAmount = str(raw.minimum_amount), amountStep = str(raw.amount_step);
  const maxAmount = str(raw.maximum_amount) ?? "1000000";
  if (!(strike > 0) || !(expiry > 0) || (type !== "C" && type !== "P") || !tickSize || !minAmount || !amountStep) return null;
  if (Number(tickSize) <= 0 || Number(amountStep) <= 0) return null;
  if (typeof raw.base_asset_address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(raw.base_asset_address)) return null;
  const subId = typeof raw.base_asset_sub_id === "string" && /^\d+$/.test(raw.base_asset_sub_id) ? raw.base_asset_sub_id : null;
  if (!subId) return null;
  return {
    name: raw.instrument_name,
    currency: m[1]!,
    type,
    strike,
    expiry,
    expiryKey: m[2]!,
    isActive: raw.is_active === true,
    deactivation: num(raw.scheduled_deactivation, expiry),
    tickSize,
    minAmount,
    maxAmount,
    amountStep,
    takerFeeRate: Math.max(0, num(raw.taker_fee_rate, 0)),
    baseFee: Math.max(0, num(raw.base_fee, 0)),
    markFeeCap: Math.max(0, num(raw.mark_price_fee_rate_cap, 0.125)),
    assetAddress: raw.base_asset_address,
    subId,
  };
}

export function parseInstruments(raw: unknown): Instrument[] {
  const list = isObj(raw) && Array.isArray(raw.instruments) ? raw.instruments : Array.isArray(raw) ? raw : [];
  const out: Instrument[] = [];
  for (const r of list) {
    const i = parseInstrument(r);
    if (i) out.push(i);
  }
  return out;
}

/** Currency → risk universe id, from public/get_all_currencies. Also returns 24h change from spot fields. */
export interface CurrencyInfo {
  currency: string;
  riskUniverse: number | null;
  spot: number | null;
  change24h: number | null;
}

export function parseCurrencies(raw: unknown): Record<string, CurrencyInfo> {
  const out: Record<string, CurrencyInfo> = {};
  if (!Array.isArray(raw)) return out;
  for (const c of raw) {
    if (!isObj(c) || typeof c.currency !== "string") continue;
    const mgr = Array.isArray(c.managers) ? c.managers.find(isObj) : undefined;
    const ru = mgr ? num(mgr.risk_universe_id, null) : null;
    const spot = pos(num(c.spot_price, null));
    const s24 = pos(num(c.spot_price_24h, null));
    out[c.currency] = {
      currency: c.currency,
      riskUniverse: ru,
      spot,
      change24h: spot !== null && s24 !== null ? spot / s24 - 1 : null,
    };
  }
  return out;
}

export interface Position {
  instrument: string;
  amount: number;
  averagePrice: number;
  markPrice: number;
  unrealizedPnl: number;
  totalFees: number;
}

export interface OpenOrder {
  orderId: string;
  instrument: string;
  direction: "buy" | "sell";
  amount: number;
  filled: number;
  limitPrice: number;
  status: string;
}

export interface SubaccountInfo {
  id: number;
  riskUniverse: number | null;
  value: number;
  initialMargin: number;
  positions: Position[];
  openOrders: OpenOrder[];
}

export function parsePosition(p: unknown): Position | null {
  if (!isObj(p) || typeof p.instrument_name !== "string") return null;
  const amount = num(p.amount, NaN);
  if (!Number.isFinite(amount)) return null;
  return {
    instrument: p.instrument_name,
    amount,
    averagePrice: num(p.average_price, 0),
    markPrice: num(p.mark_price, 0),
    unrealizedPnl: num(p.unrealized_pnl, 0),
    totalFees: num(p.total_fees, 0),
  };
}

export function parseOrder(o: unknown): OpenOrder | null {
  if (!isObj(o) || typeof o.order_id !== "string" || typeof o.instrument_name !== "string") return null;
  return {
    orderId: o.order_id,
    instrument: o.instrument_name,
    direction: o.direction === "sell" ? "sell" : "buy",
    amount: num(o.amount, 0),
    filled: num(o.filled_amount, 0),
    limitPrice: num(o.limit_price, 0),
    status: typeof o.order_status === "string" ? o.order_status : "unknown",
  };
}

export function parseSubaccount(raw: unknown): SubaccountInfo | null {
  if (!isObj(raw)) return null;
  const id = num(raw.subaccount_id, NaN);
  const value = num(raw.subaccount_value, NaN);
  if (!Number.isInteger(id) || !Number.isFinite(value)) return null;
  const list = <T>(v: unknown, f: (x: unknown) => T | null): T[] => (Array.isArray(v) ? v.map(f).filter((x): x is T => x !== null) : []);
  return {
    id,
    riskUniverse: num(raw.risk_universe_id, null),
    value,
    initialMargin: num(raw.initial_margin, 0),
    positions: list(raw.positions, parsePosition).filter((p) => p.amount !== 0),
    openOrders: list(raw.open_orders, parseOrder),
  };
}
