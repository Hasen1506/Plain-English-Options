// Pure Veranta maths and parsers (no SDK import, unit-tested and compared with
// the SDK's own compute module in tests/diff/veranta-reference.test.ts).
//
// Veranta prices every trade at the oracle price plus a spread; there is no order
// book. A position is collateral × leverage of USDC; the app shows it in coins
// (notional ÷ open price) so the shared Perps screens work unchanged.

import type { PerpMarket, PerpTicker } from "../../lib/perp.ts";
import type { OpenOrder, Position } from "../../lib/ticker.ts";
import type { TradeRow } from "../../lib/history.ts";
import type { FundingEvent } from "../../lib/perpHistory.ts";
import { VERANTA_LIQ_THRESHOLD } from "./config.ts";

/** The slice of the SDK's PairInfo the app reads (raw API JSON). */
export interface VPair {
  index: number;
  from: string;
  to: string;
  isPairListed?: boolean;
  leverages?: { minLeverage?: number; maxLeverage?: number };
  spreadP?: number; // percent
  minLevPosUSDC?: number;
  openFeeP?: number; // percent
  closeFeeP?: number;
  coinOI?: { long?: number; short?: number };
  feed?: { attributes?: { isOpen?: boolean; assetType?: string } };
  additionalPairParams2?: { openMakerFeeP?: number; closeMakerFeeP?: number; openTakerFeeP?: number; closeTakerFeeP?: number; closeOnlyMode?: boolean };
}

export interface VerantaMarket extends PerpMarket {
  pairIndex: number;
  symbol: string; // "ETH/USD", the SDK's pair ref
  minLeverage: number;
  spread: number; // fraction
  closeTakerFeeRate: number;
  closeMakerFeeRate: number;
  oiLong: number; // coins
  oiShort: number;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** "ETH/USD" → "ETH-PERP". Upside pairs and pairs not quoted in USD are left out (null). */
export function verantaName(p: { from: string; to: string }): string | null {
  if (p.to !== "USD" || /_UPSIDE$/.test(p.from) || !/^[A-Z0-9]+$/.test(p.from)) return null;
  return `${p.from}-PERP`;
}

/** A tick fine enough for any price the oracle shows: 6 significant digits. */
export function tickFor(price: number): string {
  if (!(price > 0)) return "0.01";
  const exp = Math.floor(Math.log10(price)) - 5;
  return exp >= 0 ? "1" : (10 ** exp).toFixed(-exp);
}

export function marketsFrom(pairs: VPair[], prices: Record<number, number>, now: number): { markets: VerantaMarket[]; tickers: Record<string, PerpTicker> } {
  const markets: VerantaMarket[] = [];
  const tickers: Record<string, PerpTicker> = {};
  for (const p of pairs) {
    const name = verantaName(p);
    if (!name || p.isPairListed === false) continue;
    const px = num(prices[p.index]);
    const a2 = p.additionalPairParams2 ?? {};
    const taker = (num(a2.openTakerFeeP) ?? num(p.openFeeP) ?? 0) / 100;
    const maker = (num(a2.openMakerFeeP) ?? taker * 100) / 100;
    const maxLev = num(p.leverages?.maxLeverage) ?? 1;
    const minLev = num(p.leverages?.minLeverage) ?? 1;
    const spread = (num(p.spreadP) ?? 0) / 100;
    const isOpen = p.feed?.attributes?.isOpen !== false && !a2.closeOnlyMode;
    const m: VerantaMarket = {
      name,
      currency: p.from,
      isActive: isOpen,
      tickSize: tickFor(px ?? 0),
      minAmount: "0.000001",
      maxAmount: "1000000000",
      amountStep: "0.000001",
      takerFeeRate: taker,
      makerFeeRate: maker,
      baseFee: 0,
      imReq: 1 / maxLev,
      mmReq: (1 - VERANTA_LIQ_THRESHOLD) / maxLev,
      maxLeverage: maxLev,
      maxRatePerHour: null,
      minRatePerHour: null,
      minNotional: num(p.minLevPosUSDC) ?? 0,
      pairIndex: p.index,
      symbol: `${p.from}/${p.to}`,
      minLeverage: minLev,
      spread,
      closeTakerFeeRate: (num(a2.closeTakerFeeP) ?? num(p.closeFeeP) ?? taker * 100) / 100,
      closeMakerFeeRate: (num(a2.closeMakerFeeP) ?? maker * 100) / 100,
      oiLong: num(p.coinOI?.long) ?? 0,
      oiShort: num(p.coinOI?.short) ?? 0,
    };
    markets.push(m);
    if (px && px > 0) {
      // no book: you pay the oracle price plus the pair's spread
      tickers[name] = { ts: now, mark: px, index: px, bid: px * (1 - spread), ask: px * (1 + spread), bidSize: 1e12, askSize: 1e12, iv: null, forward: null, delta: null, minPrice: null, maxPrice: null, change24h: null, fundingRate: null, openInterest: m.oiLong + m.oiShort || null, volume24h: null };
    }
  }
  markets.sort((a, b) => a.pairIndex - b.pairIndex);
  return { markets, tickers };
}

/**
 * Veranta's open fee: the maker rate when the trade moves open interest toward
 * balance, the taker rate when it adds to the heavier side, a blend when it crosses
 * the middle. Written from the rule, compared with the SDK's makerOrTakerFeeP.
 */
export function openFeeRate(o: { isLong: boolean; size: number; oiLong: number; oiShort: number; maker: number; taker: number }): number {
  const L0 = o.oiLong, S0 = o.oiShort, s = o.size;
  if (L0 + S0 <= 0 || !(s > 0)) return o.taker;
  const L1 = o.isLong ? L0 + s : L0, S1 = o.isLong ? S0 : S0 + s;
  const before = L0 / (L0 + S0), after = L1 / (L1 + S1);
  const heavyLong = before > 0.5, heavyShort = before < 0.5;
  if (!heavyLong && !heavyShort) return o.taker;
  const grows = heavyLong ? after > before : after < before;
  if (grows) return o.taker;
  const stillSameSide = heavyLong ? after >= 0.5 : after <= 0.5;
  if (stillSameSide) return o.maker;
  const gap = Math.abs(L0 - S0); // the part that rebalances pays maker, the rest taker
  return (o.maker * gap + o.taker * (s - gap)) / s;
}

/** Isolated liquidation: the price where the loss eats 85% of the collateral left after the open fee. */
export function verantaLiqPrice(o: { entry: number; collateral: number; leverage: number; isLong: boolean; accruedFees?: number; threshold?: number }): number | null {
  const size = o.collateral * o.leverage;
  if (!(size > 0) || !(o.entry > 0)) return null;
  const room = o.collateral * (o.threshold ?? VERANTA_LIQ_THRESHOLD) - (o.accruedFees ?? 0);
  const move = (o.entry * room) / size;
  const p = o.isLong ? o.entry - move : o.entry + move;
  return p > 0 ? p : null;
}

/** USDC with 6 decimals, rounded DOWN so the app never commits more than shown. */
export function usdc6(x: number): string {
  if (!(x > 0)) return "0";
  const u = Math.floor(x * 1e6 + 1e-6);
  return (u / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

/** The SDK's raw position (core API) – the fields the app reads. */
export interface VRawPosition {
  pairIndex: number;
  index: number;
  buy: boolean;
  collateral: string; // 1e6
  leverage: string; // 1e10
  openPrice: string; // 1e10
  tp?: string;
  sl?: string;
  liquidationPrice?: string;
  rolloverFee?: string;
  unrealisedFundingFee?: string;
}
export interface VRawLimit {
  pairIndex: number;
  index: number;
  buy: boolean;
  collateral?: string;
  price?: string;
  leverage?: string;
}

export interface VPosition extends Position {
  tradeIndex: number;
  pairIndex: number;
  collateral: number;
  isLong: boolean;
  tp: number | null;
  sl: number | null;
}

const e10 = (s: unknown) => (num(s) ?? 0) / 1e10;
const e6 = (s: unknown) => (num(s) ?? 0) / 1e6;

export function positionsFrom(raw: VRawPosition[], byIndex: Map<number, VerantaMarket>, marks: Record<string, number>): VPosition[] {
  const out: VPosition[] = [];
  for (const r of raw) {
    const m = byIndex.get(r.pairIndex);
    if (!m) continue;
    const collateral = e6(r.collateral), lev = e10(r.leverage), open = e10(r.openPrice);
    if (!(collateral > 0 && lev > 0 && open > 0)) continue;
    const coins = (collateral * lev) / open;
    const signed = r.buy ? coins : -coins;
    const mark = marks[m.name] ?? open;
    const funding = e6(r.unrealisedFundingFee) + e6(r.rolloverFee); // positive = owed by the trader
    const tp = e10(r.tp), sl = e10(r.sl), liq = e10(r.liquidationPrice);
    out.push({
      instrument: m.name,
      amount: signed,
      averagePrice: open,
      markPrice: mark,
      unrealizedPnl: signed * (mark - open),
      totalFees: 0,
      instrumentType: "perp",
      liquidationPrice: liq > 0 ? liq : verantaLiqPrice({ entry: open, collateral, leverage: lev, isLong: r.buy, accruedFees: funding }),
      cumulativeFunding: 0,
      pendingFunding: -funding,
      leverage: lev,
      realizedPnl: 0,
      tradeIndex: r.index,
      pairIndex: r.pairIndex,
      collateral,
      isLong: r.buy,
      tp: tp > 0 ? tp : null,
      sl: sl > 0 ? sl : null,
    });
  }
  return out;
}

export function limitsFrom(raw: VRawLimit[], byIndex: Map<number, VerantaMarket>): (OpenOrder & { tradeIndex: number; pairIndex: number; collateral: number })[] {
  return raw.flatMap((r) => {
    const m = byIndex.get(r.pairIndex);
    const price = e10(r.price), coll = e6(r.collateral), lev = e10(r.leverage);
    if (!m || !(price > 0)) return [];
    return [{ orderId: `${r.pairIndex}:${r.index}`, instrument: m.name, direction: r.buy ? ("buy" as const) : ("sell" as const), amount: coll > 0 && lev > 0 ? (coll * lev) / price : 0, filled: 0, limitPrice: price, status: "open", tradeIndex: r.index, pairIndex: r.pairIndex, collateral: coll }];
  });
}

/** Trade history rows (history API, human units) → shared TradeRow / FundingEvent. */
export interface VHistoryRow {
  timestamp: number; // seconds
  type: string; // MARKET_OPEN | MARKET_CLOSE | LIMIT_OPEN | TP | SL | LIQUIDATION …
  open: boolean;
  market: string; // "ETH/USD"
  side: "long" | "short";
  positionSize: number; // USDC notional of this event
  openPrice: number;
  closePrice: number | null;
  openFee: number | null;
  closeFee: number | null;
  borrowFee: number | null;
  funding: number | null; // positive = paid by the trader
  netPnl: number | null;
  orderId: number | null;
  txHash?: string;
}

export function historyFrom(rows: VHistoryRow[]): { trades: TradeRow[]; funding: FundingEvent[] } {
  const trades: TradeRow[] = [];
  const funding: FundingEvent[] = [];
  for (const r of rows) {
    const name = verantaName({ from: r.market.split("/")[0] ?? "", to: r.market.split("/")[1] ?? "" });
    if (!name || !(r.positionSize > 0) || !(r.openPrice > 0)) continue;
    const coins = r.positionSize / r.openPrice;
    const opening = r.open;
    const price = opening ? r.openPrice : (r.closePrice ?? 0);
    if (!(price > 0)) continue;
    const buy = (r.side === "long") === opening;
    trades.push({
      tradeId: `${r.orderId ?? ""}:${r.timestamp}:${r.type}`,
      orderId: String(r.orderId ?? ""),
      instrument: name,
      direction: buy ? "buy" : "sell",
      price,
      amount: coins,
      fee: (opening ? r.openFee : r.closeFee) ?? 0,
      timestamp: r.timestamp * 1000,
      realizedPnl: opening ? null : r.netPnl,
    });
    const paid = (r.funding ?? 0) + (r.borrowFee ?? 0);
    if (!opening && paid !== 0) funding.push({ instrument: name, funding: -paid, pnl: 0, timestamp: r.timestamp * 1000 });
  }
  trades.sort((a, b) => a.timestamp - b.timestamp);
  return { trades, funding };
}
