// Hyperliquid info-endpoint responses → the app's venue-neutral shapes.
// Pure, never throw on bad data. Conventions checked on recorded mainnet frames
// (tests/fixtures/hyperliquid/mainnet.json, 2026-10-08):
//   * assetCtx.funding = funding rate PER HOUR (fraction); positive: longs pay shorts
//   * userFunding delta.usdc < 0 when the account paid; position.cumFunding.* > 0 when it paid
//   * maintenance margin = half the initial margin at max leverage (tier 0 of the margin table)
//   * fills: side "B" = buy, "A" = sell; fee and closedPnl in USDC
//   * one account per address; cross margin unless the coin's leverage is isolated

import type { PerpMarket, PerpTicker } from "../../lib/perp.ts";
import type { OpenOrder, Position } from "../../lib/ticker.ts";
import type { TradeRow } from "../../lib/history.ts";
import type { FundingEvent } from "../../lib/perpHistory.ts";
import type { VenueAccount, VenueTrigger } from "../types.ts";
import { lotSize, MIN_ORDER_USD, priceStep } from "./rules.ts";

export interface HlAsset {
  index: number; // asset id used in orders
  coin: string; // "ETH"
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
}

/** A PerpMarket plus what Hyperliquid orders need. */
export interface HlMarket extends PerpMarket {
  asset: HlAsset;
}

/** Default (tier 0, no staking/volume discount) perp fees, docs "Fees" page: 0.045% taker, 0.015% maker. */
export const HL_TAKER = 0.00045;
export const HL_MAKER = 0.00015;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Our market name for a coin: "ETH" → "ETH-PERP" (same naming as Derive, so the picker can match venues). */
export const hlName = (coin: string) => `${coin.toUpperCase()}-PERP`;

export function parseMeta(raw: unknown, fees = { taker: HL_TAKER, maker: HL_MAKER }): { markets: HlMarket[]; tickers: Record<string, PerpTicker> } {
  const markets: HlMarket[] = [];
  const tickers: Record<string, PerpTicker> = {};
  if (!Array.isArray(raw) || !isObj(raw[0]) || !Array.isArray(raw[0].universe)) return { markets, tickers };
  const ctxs = Array.isArray(raw[1]) ? raw[1] : [];
  raw[0].universe.forEach((u: unknown, index: number) => {
    if (!isObj(u) || typeof u.name !== "string" || u.isDelisted === true) return;
    if (!/^[A-Za-z0-9]+$/.test(u.name)) return; // HIP-3 / builder-deployed names (dex:COIN) are out of scope
    const sz = num(u.szDecimals), lev = num(u.maxLeverage);
    if (sz === null || !Number.isInteger(sz) || sz < 0 || sz > 6 || lev === null || !(lev >= 1)) return;
    const ctx = isObj(ctxs[index]) ? ctxs[index] : null;
    const mark = ctx ? num(ctx.markPx) : null;
    const asset: HlAsset = { index, coin: u.name, szDecimals: sz, maxLeverage: lev, onlyIsolated: u.onlyIsolated === true };
    const name = hlName(u.name);
    const ref = mark && mark > 0 ? mark : 1;
    markets.push({
      name,
      currency: u.name.toUpperCase(),
      isActive: !!mark && mark > 0,
      tickSize: priceStep(ref, sz),
      minAmount: lotSize(sz),
      minNotional: MIN_ORDER_USD, // $10 per order (docs); quotePerp sizes up to it and says so
      maxAmount: "1000000000",
      amountStep: lotSize(sz),
      takerFeeRate: fees.taker,
      makerFeeRate: fees.maker,
      baseFee: 0,
      imReq: 1 / lev,
      mmReq: 1 / (2 * lev),
      maxLeverage: lev,
      maxRatePerHour: null,
      minRatePerHour: null,
      asset,
    });
    if (ctx && mark && mark > 0) {
      const oracle = num(ctx.oraclePx) ?? mark;
      const prev = num(ctx.prevDayPx);
      const impact = Array.isArray(ctx.impactPxs) ? ctx.impactPxs.map(num) : [];
      const mid = num(ctx.midPx);
      const oi = num(ctx.openInterest);
      const vol = num(ctx.dayNtlVlm);
      tickers[name] = {
        ts: 0,
        bid: impact[0] ?? mid ?? 0,
        ask: impact[1] ?? mid ?? 0,
        bidSize: 0,
        askSize: 0,
        mark,
        index: oracle,
        iv: null,
        forward: null,
        delta: null,
        minPrice: null,
        maxPrice: null,
        change24h: prev && prev > 0 ? mark / prev - 1 : null,
        fundingRate: num(ctx.funding),
        openInterest: oi !== null && oi >= 0 ? oi : null,
        volume24h: vol !== null && vol >= 0 ? vol : null,
      };
    }
  });
  markets.sort((a, b) => rank(a.currency) - rank(b.currency) || a.name.localeCompare(b.name));
  return { markets, tickers };
}
const rank = (c: string) => (c === "ETH" ? 0 : c === "BTC" ? 1 : 2);

/** Top of book from l2Book; overrides the impact-price estimate with the real touch and sizes. */
export function applyBook(t: PerpTicker, raw: unknown): PerpTicker {
  if (!isObj(raw) || !Array.isArray(raw.levels)) return t;
  const [bids, asks] = raw.levels as unknown[][];
  const top = (side: unknown[] | undefined) => (Array.isArray(side) && isObj(side[0]) ? { px: num(side[0].px), sz: num(side[0].sz) } : null);
  const b = top(bids), a = top(asks);
  const time = num(raw.time);
  return { ...t, bid: b?.px ?? t.bid, bidSize: b?.sz ?? 0, ask: a?.px ?? t.ask, askSize: a?.sz ?? 0, ts: time ?? t.ts };
}

export interface HlAccountState {
  account: VenueAccount;
  /** Leverage setting per coin as the exchange holds it. */
  leverage: Record<string, { type: "cross" | "isolated"; value: number }>;
  withdrawable: number;
}

/** clearinghouseState → one VenueAccount (id 0: Hyperliquid has one perp account per address). */
export function parseClearinghouse(raw: unknown, marks: Record<string, number> = {}): HlAccountState | null {
  if (!isObj(raw) || !isObj(raw.marginSummary)) return null;
  const ms = raw.marginSummary;
  const value = num(ms.accountValue) ?? 0;
  const used = num(ms.totalMarginUsed) ?? 0;
  const mmUsed = num(raw.crossMaintenanceMarginUsed) ?? 0;
  const positions: Position[] = [];
  const leverage: HlAccountState["leverage"] = {};
  for (const ap of Array.isArray(raw.assetPositions) ? raw.assetPositions : []) {
    const p = isObj(ap) && isObj(ap.position) ? ap.position : null;
    if (!p || typeof p.coin !== "string") continue;
    const szi = num(p.szi) ?? 0;
    const lev = isObj(p.leverage) ? p.leverage : null;
    if (lev) leverage[p.coin] = { type: lev.type === "isolated" ? "isolated" : "cross", value: num(lev.value) ?? 1 };
    if (szi === 0) continue;
    const entry = num(p.entryPx) ?? 0;
    const pv = num(p.positionValue);
    const cf = isObj(p.cumFunding) ? p.cumFunding : {};
    const name = hlName(p.coin);
    positions.push({
      instrument: name,
      amount: szi,
      averagePrice: entry,
      markPrice: marks[name] ?? (pv !== null && szi !== 0 ? Math.abs(pv / szi) : entry),
      unrealizedPnl: num(p.unrealizedPnl) ?? 0,
      totalFees: 0,
      instrumentType: "perp",
      liquidationPrice: num(p.liquidationPx),
      cumulativeFunding: -(num(cf.sinceOpen) ?? 0), // exchange: + = paid; app: + = received
      pendingFunding: 0,
      leverage: lev ? (num(lev.value) ?? null) : null,
      realizedPnl: 0,
    });
  }
  return {
    account: {
      id: 0,
      value,
      initialMargin: value - used,
      maintenanceMargin: value - mmUsed,
      underLiquidation: false,
      positions,
      openOrders: [],
    },
    leverage,
    withdrawable: num(raw.withdrawable) ?? 0,
  };
}

export interface HlOrder {
  oid: number;
  coin: string;
  side: "buy" | "sell";
  sz: number;
  limitPx: number;
  isTrigger: boolean;
  triggerPx: number;
  orderType: string;
  reduceOnly: boolean;
  tif: string | null;
}

export function parseOpenOrders(raw: unknown): HlOrder[] {
  if (!Array.isArray(raw)) return [];
  const out: HlOrder[] = [];
  for (const o of raw) {
    if (!isObj(o) || typeof o.coin !== "string" || typeof o.oid !== "number") continue;
    out.push({
      oid: o.oid,
      coin: o.coin,
      side: o.side === "B" ? "buy" : "sell",
      sz: num(o.sz) ?? 0,
      limitPx: num(o.limitPx) ?? 0,
      isTrigger: o.isTrigger === true,
      triggerPx: num(o.triggerPx) ?? 0,
      orderType: typeof o.orderType === "string" ? o.orderType : "",
      reduceOnly: o.reduceOnly === true,
      tif: typeof o.tif === "string" ? o.tif : null,
    });
  }
  return out;
}

export const restingOrders = (os: HlOrder[]): OpenOrder[] =>
  os.filter((o) => !o.isTrigger).map((o) => ({ orderId: String(o.oid), instrument: hlName(o.coin), direction: o.side, amount: o.sz, filled: 0, limitPrice: o.limitPx, status: "open" }));

export const triggerOrders = (os: HlOrder[]): VenueTrigger[] =>
  os
    .filter((o) => o.isTrigger)
    .map((o) => ({
      orderId: String(o.oid),
      instrument: hlName(o.coin),
      direction: o.side,
      amount: o.sz,
      triggerType: /take profit/i.test(o.orderType) ? "takeprofit" : /stop/i.test(o.orderType) ? "stoploss" : o.orderType,
      triggerPrice: o.triggerPx,
      limitPrice: o.limitPx,
      status: "untriggered",
    }));

export function parseFills(raw: unknown): TradeRow[] {
  if (!Array.isArray(raw)) return [];
  const out: TradeRow[] = [];
  for (const f of raw) {
    if (!isObj(f) || typeof f.coin !== "string" || !/^[A-Za-z0-9]+$/.test(f.coin)) continue; // spot fills are "@123" / "PURR/USDC"
    const px = num(f.px), sz = num(f.sz);
    if (px === null || sz === null || !(sz > 0)) continue;
    out.push({
      tradeId: String(f.tid ?? ""),
      orderId: String(f.oid ?? ""),
      instrument: hlName(f.coin),
      direction: f.side === "B" ? "buy" : "sell",
      price: px,
      amount: sz,
      fee: num(f.fee) ?? 0,
      timestamp: num(f.time) ?? 0,
      realizedPnl: num(f.closedPnl),
    });
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

export function parseUserFunding(raw: unknown): FundingEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: FundingEvent[] = [];
  for (const e of raw) {
    const d = isObj(e) && isObj(e.delta) ? e.delta : null;
    if (!d || d.type !== "funding" || typeof d.coin !== "string") continue;
    const usdc = num(d.usdc);
    if (usdc === null) continue;
    out.push({ instrument: hlName(d.coin), funding: usdc, pnl: 0, timestamp: num((e as Record<string, unknown>).time) ?? 0 });
  }
  return out;
}

/** userFees → the account's own perp rates (volume tier, staking and referral discounts applied by the exchange). */
export function parseUserFees(raw: unknown): { taker: number; maker: number } | null {
  if (!isObj(raw)) return null;
  const t = num(raw.userCrossRate), m = num(raw.userAddRate);
  return t !== null && m !== null && t >= 0 && t < 0.01 && m < 0.01 ? { taker: t, maker: m } : null;
}

export interface HlOrderStatus {
  kind: "filled" | "resting" | "error" | "unknown";
  oid: number | null;
  totalSz: number;
  avgPx: number;
  error: string | null;
}

/** One status of an order action reply: {resting:{oid}} | {filled:{totalSz,avgPx,oid}} | {error:"…"} | "waitingForFill" … */
export function parseStatus(s: unknown): HlOrderStatus {
  if (isObj(s) && isObj(s.filled)) return { kind: "filled", oid: num(s.filled.oid), totalSz: num(s.filled.totalSz) ?? 0, avgPx: num(s.filled.avgPx) ?? 0, error: null };
  if (isObj(s) && isObj(s.resting)) return { kind: "resting", oid: num(s.resting.oid), totalSz: 0, avgPx: 0, error: null };
  if (isObj(s) && typeof s.error === "string") return { kind: "error", oid: null, totalSz: 0, avgPx: 0, error: s.error };
  return { kind: "unknown", oid: null, totalSz: 0, avgPx: 0, error: typeof s === "string" ? s : null };
}

/** The statuses array of an /exchange reply, or a thrown error with the exchange's own words. */
export function exchangeStatuses(reply: unknown): unknown[] {
  if (!isObj(reply)) throw new Error("Hyperliquid did not answer");
  if (reply.status !== "ok") throw new Error(typeof reply.response === "string" ? reply.response : "Hyperliquid rejected the request");
  const r = isObj(reply.response) ? reply.response : null;
  const d = r && isObj(r.data) ? r.data : null;
  return d && Array.isArray(d.statuses) ? d.statuses : [];
}
