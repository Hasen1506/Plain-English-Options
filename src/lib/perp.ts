// Perpetual futures on Derive v3: parsers and the maths behind the plain-English
// order builder ("I think ETH goes UP, risking $100 at 5×"). Pure functions:
// no network, no DOM, never throw on bad exchange data (they return null).
//
// Conventions (checked against live v3 testnet + mainnet frames, 2026-10-08):
//   * instrument.perp_details.srm_perp_margin_requirements: im_perp_req / mm_perp_req
//     are fractions of notional (ETH 0.066 / 0.05 → 15.15× max), max_leverage = 1 / im.
//   * ticker field `f` = current funding rate PER HOUR (fraction). Positive: longs pay shorts.
//   * stats.oi = open interest in base units; stats.p = 24h change as a fraction.
//   * Subaccount `maintenance_margin` / `initial_margin` are NET margin (value − requirement):
//     positive = headroom. Liquidation starts when maintenance headroom reaches 0.
//   * Subaccounts are CROSS margin: every position and the whole collateral back each other.

import { alignDown, alignUp, fromE18, toE18 } from "./units.ts";
import { parseTicker, type Ticker } from "./ticker.ts";

/**
 * A perpetual market as any venue describes it. Everything the order builder,
 * sizing, fee and liquidation maths need, and nothing venue-specific: adapters
 * (src/venues) map their own instrument format onto this.
 */
export interface PerpMarket {
  name: string; // ETH-PERP (venue's own symbol)
  currency: string; // ETH
  isActive: boolean;
  tickSize: string;
  minAmount: string;
  maxAmount: string;
  amountStep: string;
  takerFeeRate: number;
  makerFeeRate: number;
  baseFee: number; // per order, USD
  imReq: number; // initial margin, fraction of notional
  mmReq: number; // maintenance margin, fraction of notional
  maxLeverage: number;
  maxRatePerHour: number | null;
  minRatePerHour: number | null;
}

/** Derive v3's perp instrument: a PerpMarket plus what its order signature needs. */
export interface PerpInstrument extends PerpMarket {
  assetAddress: string;
  subId: string;
}

export interface PerpTicker extends Ticker {
  fundingRate: number | null; // per hour, fraction
  openInterest: number | null; // base units
  volume24h: number | null; // USD
}

export type PerpDir = "long" | "short";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fin = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const decStr = (v: unknown) => (typeof v === "string" && /^\d+(\.\d+)?$/.test(v) && Number(v) > 0 ? v : null);

export const isPerpName = (name: string): boolean => /^[A-Z0-9_]+-PERP$/.test(name);

export function parsePerpInstrument(raw: unknown): PerpInstrument | null {
  if (!isObj(raw) || raw.instrument_type !== "perp" || typeof raw.instrument_name !== "string" || !isPerpName(raw.instrument_name)) return null;
  const pd = isObj(raw.perp_details) ? raw.perp_details : null;
  const mr = pd && isObj(pd.srm_perp_margin_requirements) ? pd.srm_perp_margin_requirements : null;
  const tickSize = decStr(raw.tick_size), minAmount = decStr(raw.minimum_amount), amountStep = decStr(raw.amount_step);
  const maxAmount = decStr(raw.maximum_amount) ?? "1000000";
  if (!tickSize || !minAmount || !amountStep || !mr) return null;
  if (typeof raw.base_asset_address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(raw.base_asset_address)) return null;
  const subId = typeof raw.base_asset_sub_id === "string" && /^\d+$/.test(raw.base_asset_sub_id) ? raw.base_asset_sub_id : null;
  const im = fin(mr.im_perp_req), mm = fin(mr.mm_perp_req);
  if (!subId || im === null || mm === null || !(im > 0 && im <= 1) || !(mm > 0 && mm <= im)) return null;
  const lev = fin(mr.max_leverage);
  return {
    name: raw.instrument_name,
    currency: raw.instrument_name.slice(0, -5),
    isActive: raw.is_active === true,
    tickSize,
    minAmount,
    maxAmount,
    amountStep,
    takerFeeRate: Math.max(0, fin(raw.taker_fee_rate) ?? 0),
    makerFeeRate: Math.max(0, fin(raw.maker_fee_rate) ?? 0),
    baseFee: Math.max(0, fin(raw.base_fee) ?? 0),
    assetAddress: raw.base_asset_address,
    subId,
    imReq: im,
    mmReq: mm,
    maxLeverage: lev !== null && lev > 0 ? lev : 1 / im,
    maxRatePerHour: fin(pd!.max_rate_per_hour),
    minRatePerHour: fin(pd!.min_rate_per_hour),
  };
}

export function parsePerpInstruments(raw: unknown): PerpInstrument[] {
  const list = isObj(raw) && Array.isArray(raw.instruments) ? raw.instruments : Array.isArray(raw) ? raw : [];
  const out: PerpInstrument[] = [];
  for (const r of list) {
    const p = parsePerpInstrument(r);
    if (p) out.push(p);
  }
  return out.sort((a, b) => perpRank(a.currency) - perpRank(b.currency) || a.name.localeCompare(b.name));
}

/** ETH and BTC first, then the rest alphabetically. */
const perpRank = (c: string) => (c === "ETH" ? 0 : c === "BTC" ? 1 : 2);

export function parsePerpTicker(raw: unknown): PerpTicker | null {
  const t = parseTicker(raw);
  if (!t || !isObj(raw)) return null;
  const st = isObj(raw.stats) ? raw.stats : null;
  const oi = st ? fin(st.oi) : null;
  const v = st ? fin(st.v) : null;
  return { ...t, fundingRate: fin(raw.f), openInterest: oi !== null && oi >= 0 ? oi : null, volume24h: v !== null && v >= 0 ? v : null };
}

export function parsePerpTickers(raw: unknown): Record<string, PerpTicker> {
  const out: Record<string, PerpTicker> = {};
  const tk = isObj(raw) && isObj(raw.tickers) ? raw.tickers : null;
  if (!tk) return out;
  for (const [name, v] of Object.entries(tk)) {
    if (!isPerpName(name)) continue;
    const t = parsePerpTicker(v);
    if (t) out[name] = t;
  }
  return out;
}

// ---------- funding ----------

export const HOURS_PER_YEAR = 24 * 365;
export const fundingApr = (ratePerHour: number): number => ratePerHour * HOURS_PER_YEAR;
/** USD the position RECEIVES per hour at this rate (negative = it pays). Longs pay when the rate is positive. */
export const fundingPerHour = (size: number, indexPrice: number, ratePerHour: number): number => -size * indexPrice * ratePerHour;

// ---------- P&L ----------

/** Unrealised P&L of a signed position marked at `mark`. */
export const unrealizedPnl = (size: number, entry: number, mark: number): number => size * (mark - entry);

export interface CostBasis {
  size: number; // signed
  entry: number; // average entry of the open size (0 when flat)
}

/**
 * Apply one fill to an average-cost position. Returns the new position and the
 * P&L realised by the part of the fill that reduced it (fees excluded). A fill
 * larger than the position flips it: the remainder opens at the fill price.
 */
export function applyFill(pos: CostBasis, side: "buy" | "sell", amount: number, price: number): { pos: CostBasis; realized: number } {
  if (!(amount > 0)) return { pos, realized: 0 };
  const d = side === "buy" ? amount : -amount;
  const s = pos.size;
  if (s === 0 || Math.sign(s) === Math.sign(d)) {
    const size = s + d;
    return { pos: { size, entry: (Math.abs(s) * pos.entry + amount * price) / Math.abs(size) }, realized: 0 };
  }
  const closed = Math.min(Math.abs(s), amount);
  const realized = closed * (price - pos.entry) * Math.sign(s);
  const size = snap(s + d);
  if (size === 0) return { pos: { size: 0, entry: 0 }, realized };
  if (Math.sign(size) === Math.sign(s)) return { pos: { size, entry: pos.entry }, realized };
  return { pos: { size, entry: price }, realized }; // flipped
}

/** Remove float dust so 0.3 − 0.1 − 0.2 is exactly flat. */
const snap = (x: number) => (Math.abs(x) < 1e-9 ? 0 : Math.round(x * 1e9) / 1e9);

// ---------- margin and liquidation (cross margin, standard manager) ----------

/** Initial / maintenance requirement of a signed size at a price. */
export const imRequirement = (inst: Pick<PerpInstrument, "imReq">, size: number, price: number) => inst.imReq * Math.abs(size) * price;
export const mmRequirement = (inst: Pick<PerpInstrument, "mmReq">, size: number, price: number) => inst.mmReq * Math.abs(size) * price;

/**
 * Price at which the subaccount's maintenance headroom hits zero, if only this
 * perp's price moves. `headroom` is the net maintenance margin with the full
 * signed `size` already held, valued at `price` (the exchange's own figure from
 * private/get_margin or get_subaccount). Headroom changes by (size − mm·|size|)
 * per dollar the price moves, so the root is linear. null = no liquidation price
 * (long that survives to zero, or a flat position).
 */
export function liquidationPrice(o: { size: number; price: number; headroom: number; mmReq: number }): number | null {
  const { size, price, headroom, mmReq } = o;
  if (!Number.isFinite(size) || size === 0 || !(price > 0) || !Number.isFinite(headroom)) return null;
  if (headroom <= 0) return price; // already at or past maintenance
  const slope = size - mmReq * Math.abs(size);
  if (slope === 0) return null;
  const p = price - headroom / slope;
  return p > 0 ? p : null;
}

/** Signed % move from `price` to the liquidation price. */
export const moveTo = (price: number, target: number | null): number | null => (target === null || !(price > 0) ? null : target / price - 1);

// ---------- fees ----------

export const perpFee = (inst: Pick<PerpInstrument, "takerFeeRate" | "makerFeeRate" | "baseFee">, amount: number, price: number, maker = false): number =>
  amount > 0 ? amount * price * (maker ? inst.makerFeeRate : inst.takerFeeRate) + inst.baseFee : 0;

// ---------- sizing and prices ----------

export function minSize(inst: Pick<PerpInstrument, "minAmount" | "amountStep">): string {
  return alignUp(Number(inst.minAmount), inst.amountStep);
}

/**
 * Contracts for "risking $risk at lev×": notional = risk × lev, size = notional ÷ price,
 * floored to the amount step so the margin used never exceeds what was asked.
 * Below the exchange minimum the minimum is returned and flagged.
 */
export function sizePerp(risk: number, leverage: number, price: number, inst: Pick<PerpInstrument, "minAmount" | "maxAmount" | "amountStep">): { amount: string; belowMinimum: boolean; tooLarge: boolean } | null {
  if (!(risk > 0) || !(leverage > 0) || !(price > 0) || ![risk, leverage, price].every(Number.isFinite)) return null;
  const raw = (risk * leverage) / price;
  if (!Number.isFinite(raw)) return null;
  const min = minSize(inst);
  if (raw > Number(inst.maxAmount) * 10) return { amount: alignDown(Number(inst.maxAmount), inst.amountStep), belowMinimum: false, tooLarge: true };
  const a = alignDown(raw, inst.amountStep);
  if (toE18(a) < toE18(min)) return { amount: min, belowMinimum: true, tooLarge: false };
  if (toE18(a) > toE18(inst.maxAmount)) return { amount: alignDown(Number(inst.maxAmount), inst.amountStep), belowMinimum: false, tooLarge: true };
  return { amount: fromE18(toE18(a)), belowMinimum: false, tooLarge: false };
}

/** Clamp a price into the exchange band and onto the tick, rounding against the trader (buy ↓, sell ↑) unless `cross`. */
function bandTick(px: number, side: "buy" | "sell", t: Pick<Ticker, "minPrice" | "maxPrice">, tick: string, cross: boolean): string {
  let p = px;
  if (t.maxPrice !== null) p = Math.min(p, t.maxPrice);
  if (t.minPrice !== null) p = Math.max(p, t.minPrice);
  p = Math.max(p, Number(tick));
  // a crossing limit rounds outward (buy up / sell down) only if that stays inside the band
  if (cross) {
    const out = side === "buy" ? alignUp(p, tick) : alignDown(p, tick);
    const inBand = (t.maxPrice === null || Number(out) <= t.maxPrice) && (t.minPrice === null || Number(out) >= t.minPrice) && Number(out) > 0;
    if (inBand) return out;
  }
  return side === "buy" ? alignDown(p, tick) : alignUp(p, tick);
}

/**
 * Worst price a market (IOC) order may fill at: `slip` through the touch,
 * inside the exchange band, on the tick. null when that side of the book is empty.
 */
export function marketLimit(side: "buy" | "sell", t: Pick<Ticker, "ask" | "bid" | "minPrice" | "maxPrice">, tick: string, slip: number): string | null {
  const ref = side === "buy" ? t.ask : t.bid;
  if (!(ref > 0)) return null;
  return bandTick(side === "buy" ? ref * (1 + slip) : ref * (1 - slip), side, t, tick, true);
}

/** A user's limit price snapped to the tick (never worse than typed) and checked against the band. */
export function snapLimit(side: "buy" | "sell", px: number, t: Pick<Ticker, "minPrice" | "maxPrice">, tick: string): { price: string; inBand: boolean } | null {
  if (!(px > 0) || !Number.isFinite(px)) return null;
  const p = side === "buy" ? alignDown(px, tick) : alignUp(px, tick);
  if (!(Number(p) > 0)) return null;
  const inBand = (t.maxPrice === null || Number(p) <= t.maxPrice) && (t.minPrice === null || Number(p) >= t.minPrice);
  return { price: p, inBand };
}

/** Max fee per unit to sign: 2× headroom over taker rate × max(index, price) + base fee ÷ amount (same rule as options). */
export function perpMaxFee(inst: Pick<PerpInstrument, "takerFeeRate" | "baseFee">, index: number, price: number, amount: number): string {
  const v = 2 * (2 * Math.max(index, price) * inst.takerFeeRate + inst.baseFee / Math.max(amount, 1e-9));
  return alignUp(v, "0.000001");
}

// ---------- the order builder ----------

export type PerpOrderType = "market" | "limit";

export interface PerpInput {
  inst: PerpMarket;
  ticker: PerpTicker;
  dir: PerpDir;
  risk: number; // USD of margin put in
  leverage: number;
  orderType: PerpOrderType;
  limitPrice?: number | null;
  postOnly?: boolean;
  takeProfit?: number | null;
  stopLoss?: number | null;
  slippage: number;
  /** Net maintenance margin of the subaccount now (exchange figure); null = not signed in. */
  headroomMM?: number | null;
  /** Net initial margin now; the trade's initial requirement must fit inside it. */
  headroomIM?: number | null;
  /** Signed size already held in this perp (its requirement is already inside the headroom). */
  existing?: number;
  leverageCap: number;
}

export interface PerpQuote {
  inst: PerpMarket;
  dir: PerpDir;
  side: "buy" | "sell";
  amount: string;
  n: number;
  entry: number; // expected fill (touch for market, limit for limit)
  limitPrice: string; // signed limit
  orderType: PerpOrderType;
  tif: "ioc" | "gtc" | "post_only";
  notional: number;
  leverage: number; // as chosen (the position is notional ÷ putIn)
  putIn: number; // margin the user commits: notional ÷ leverage (more than asked only at the exchange minimum)
  marginUsed: number; // initial requirement of this trade
  estFee: number;
  worstFee: number;
  maxFee: string;
  liqPrice: number | null; // cross-margin estimate (null without account data)
  liqMove: number | null;
  /** Price where the user's own $risk would be gone: a 1/leverage move. */
  riskPrice: number;
  fundingRate: number | null;
  fundingApr: number | null;
  fundingHourly: number | null; // USD received per hour (negative = paid)
  takeProfit: string | null;
  stopLoss: string | null;
  gainAtTp: number | null;
  lossAtSl: number | null;
  belowMinimum: boolean;
  depthOk: boolean;
  postOnlyWouldCross: boolean;
  reducesExisting: boolean;
  problems: string[]; // block Confirm
  warnings: string[];
}

export type PerpFail = "no-price" | "no-book" | "bad-amount" | "bad-limit" | "too-large" | "inactive";

export function quotePerp(i: PerpInput): { ok: true; quote: PerpQuote } | { ok: false; reason: PerpFail } {
  const { inst, ticker: t } = i;
  if (!inst.isActive) return { ok: false, reason: "inactive" };
  const side = i.dir === "long" ? "buy" : "sell";
  const touch = side === "buy" ? t.ask : t.bid;
  const ref = t.mark > 0 ? t.mark : t.index;
  if (!(ref > 0)) return { ok: false, reason: "no-price" };
  let entry: number, limitPrice: string, tif: PerpQuote["tif"];
  const problems: string[] = [], warnings: string[] = [];
  let postOnlyWouldCross = false;
  if (i.orderType === "market") {
    const lim = marketLimit(side, t, inst.tickSize, i.slippage);
    if (!lim || !(touch > 0)) return { ok: false, reason: "no-book" };
    entry = touch;
    limitPrice = lim;
    tif = "ioc";
  } else {
    const s = snapLimit(side, i.limitPrice ?? NaN, t, inst.tickSize);
    if (!s) return { ok: false, reason: "bad-limit" };
    entry = Number(s.price);
    limitPrice = s.price;
    tif = i.postOnly ? "post_only" : "gtc";
    if (!s.inBand) problems.push(`Limit price must be between ${t.minPrice ?? "?"} and ${t.maxPrice ?? "?"} right now`);
    const crosses = touch > 0 && (side === "buy" ? entry >= touch : entry <= touch);
    if (crosses && i.postOnly) {
      postOnlyWouldCross = true;
      problems.push(`Post-only ${side} must be ${side === "buy" ? "below the ask" : "above the bid"} (${touch}) or it would be rejected`);
    } else if (crosses) warnings.push("This limit crosses the book, so it fills now as a taker");
  }
  const sized = sizePerp(i.risk, i.leverage, entry, inst);
  if (!sized) return { ok: false, reason: "bad-amount" };
  if (sized.tooLarge) return { ok: false, reason: "too-large" };
  const n = Number(sized.amount);
  const notional = n * entry;
  const leverage = i.leverage;
  const putIn = notional / leverage;
  const maker = i.orderType === "limit" && !(touch > 0 && (side === "buy" ? entry >= touch : entry <= touch));
  const estFee = perpFee(inst, n, entry, maker);
  const worstPx = Number(limitPrice);
  const worstFee = perpFee(inst, n, Math.max(worstPx, entry), false);
  const maxFee = perpMaxFee(inst, t.index, Math.max(worstPx, entry), n);
  const marginUsed = imRequirement(inst, n, ref);
  const signed = side === "buy" ? n : -n;
  const existing = i.existing ?? 0;
  const reducesExisting = existing !== 0 && Math.sign(existing) !== Math.sign(signed);
  const capLev = Math.min(i.leverageCap, inst.maxLeverage);
  if (i.leverage > capLev + 1e-9) problems.push(`Leverage is capped at ${trimLev(capLev)}× (${i.leverageCap < inst.maxLeverage ? "your setting" : "exchange maximum"})`);
  if (sized.belowMinimum) warnings.push(`Smallest order is ${sized.amount} ${inst.currency}, so this puts in ${money2(putIn)} at ${trimLev(leverage)}×, not ${money2(i.risk)}`);
  const depthOk = i.orderType === "limit" || n <= (side === "buy" ? t.askSize : t.bidSize);
  if (!depthOk) warnings.push("Bigger than the best price level: part may fill worse, never past the protection price");
  // cross-margin liquidation estimate: headroom after the trade at the expected entry
  let liqPrice: number | null = null;
  if (i.headroomMM != null && Number.isFinite(i.headroomMM)) {
    const total = existing + signed;
    const slip = (entry - ref) * signed; // paying through mark costs equity now
    const extraMM = mmRequirement(inst, total, ref) - mmRequirement(inst, existing, ref);
    const after = i.headroomMM - extraMM - slip - estFee;
    liqPrice = liquidationPrice({ size: total, price: ref, headroom: after, mmReq: inst.mmReq });
    if (after <= 0) problems.push("This would put the subaccount below maintenance margin");
  }
  if (i.headroomIM != null && Number.isFinite(i.headroomIM) && !reducesExisting) {
    const needIM = imRequirement(inst, existing + signed, ref) - imRequirement(inst, existing, ref) + estFee;
    if (needIM > i.headroomIM) problems.push(`Not enough free margin: needs ${money2(needIM)}, ${money2(Math.max(0, i.headroomIM))} available`);
  }
  const riskPrice = side === "buy" ? entry * (1 - 1 / Math.max(leverage, 1e-9)) : entry * (1 + 1 / Math.max(leverage, 1e-9));
  // take-profit / stop-loss: trigger prices on the mark, snapped to tick
  const tick = inst.tickSize;
  let takeProfit: string | null = null, stopLoss: string | null = null, gainAtTp: number | null = null, lossAtSl: number | null = null;
  if (i.takeProfit != null && i.takeProfit > 0) {
    takeProfit = alignDown(i.takeProfit, tick);
    if (side === "buy" ? Number(takeProfit) <= entry : Number(takeProfit) >= entry) problems.push(`Take-profit must be ${side === "buy" ? "above" : "below"} the entry price`);
    gainAtTp = signed * (Number(takeProfit) - entry);
  }
  if (i.stopLoss != null && i.stopLoss > 0) {
    stopLoss = alignDown(i.stopLoss, tick);
    if (side === "buy" ? Number(stopLoss) >= entry : Number(stopLoss) <= entry) problems.push(`Stop-loss must be ${side === "buy" ? "below" : "above"} the entry price`);
    lossAtSl = -signed * (Number(stopLoss) - entry);
    if (liqPrice !== null && (side === "buy" ? Number(stopLoss) <= liqPrice : Number(stopLoss) >= liqPrice)) warnings.push("Stop-loss is past the liquidation price, so it would never trigger first");
  }
  const fr = t.fundingRate;
  return {
    ok: true,
    quote: {
      inst,
      dir: i.dir,
      side,
      amount: sized.amount,
      n,
      entry,
      limitPrice,
      orderType: i.orderType,
      tif,
      notional,
      leverage,
      putIn,
      marginUsed,
      estFee,
      worstFee,
      maxFee,
      liqPrice,
      liqMove: moveTo(entry, liqPrice),
      riskPrice,
      fundingRate: fr,
      fundingApr: fr === null ? null : fundingApr(fr),
      fundingHourly: fr === null ? null : fundingPerHour(signed, t.index, fr),
      takeProfit,
      stopLoss,
      gainAtTp,
      lossAtSl,
      belowMinimum: sized.belowMinimum,
      depthOk,
      postOnlyWouldCross,
      reducesExisting,
      problems,
      warnings,
    },
  };
}

const trimLev = (x: number) => String(Math.floor(x * 100) / 100);
const money2 = (v: number) => (v < 0 ? "−$" : "$") + Math.abs(v).toFixed(2);

/** The sentence under the builder: what can go wrong, in plain words. */
export function maxLossWords(q: PerpQuote, asset: string, subValue: number | null): string {
  const pctMove = Math.abs(q.riskPrice / q.entry - 1) * 100;
  const way = q.dir === "long" ? "falls" : "rises";
  const own = `If ${asset} ${way} ${pctMove.toFixed(1)}% to ${px(q.riskPrice)}, you have lost the ${money2(q.putIn)} you put in.`;
  if (q.liqPrice === null) return own + (subValue === null ? " Connect a wallet to see where Derive would liquidate." : " Your subaccount has enough collateral that this position alone would not be liquidated.");
  const liqPct = Math.abs((q.liqMove ?? 0) * 100);
  const beyond = q.dir === "long" ? q.liqPrice < q.riskPrice : q.liqPrice > q.riskPrice;
  return (
    own +
    ` Your whole subaccount${subValue !== null ? ` (${money2(subValue)})` : ""} backs this trade, so Derive liquidates near ${px(q.liqPrice)} (${liqPct.toFixed(1)}% away)` +
    (beyond ? "; losses can run past what you put in until then." : ".") +
    (q.stopLoss ? ` Your stop-loss at ${px(Number(q.stopLoss))} closes it first, losing about ${money2(Math.max(0, q.lossAtSl ?? 0) + q.estFee)}.` : " Add a stop-loss to cap it.")
  );
}

const px = (v: number) => "$" + (v >= 100 ? Math.round(v).toLocaleString("en-US") : v >= 1 ? v.toFixed(2) : v.toPrecision(3));

/** Reduce-only close size for a fraction of a position, aligned down to the step (never more than held). */
export function closeAmount(position: number, fraction: number, step: string): string {
  const f = Math.min(1, Math.max(0, fraction));
  const a = Math.abs(position) * f;
  return f >= 1 ? alignDown(Math.abs(position), step) : alignDown(a, step);
}
