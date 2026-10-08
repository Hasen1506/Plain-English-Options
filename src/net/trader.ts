// Placing, unwinding, closing and cancelling orders on Derive v3.
//
// Leg-risk protection: testnet RFQs get no maker quotes (checked 2026-10-08),
// so a spread is two fill-or-kill limit orders. All three actions that might be
// needed (long leg, short leg, unwind of the long leg) are signed BEFORE the
// first order is sent, so if the short leg fails the unwind goes out at once,
// without waiting for the user to approve another wallet prompt.

import type { Network } from "../config.ts";
import type { Instrument, Ticker, Tradable } from "../lib/ticker.ts";
import { maxFeePerUnit, protectiveLimit, type SpreadQuote } from "../lib/spread.ts";
import { alignDown, fromE18, toE18 } from "../lib/units.ts";
import { encodeTradeData, makeNonce, type ActionFields } from "./signing.ts";
import type { ActionSigner } from "./signer.ts";

export interface Rpc {
  call<T = unknown>(method: string, params?: object): Promise<T>;
}

export type Tif = "gtc" | "ioc" | "fok" | "post_only";

export interface OrderRequest {
  inst: Tradable;
  direction: "buy" | "sell";
  amount: string;
  limitPrice: string;
  maxFee: string;
  tif: Tif;
  reduceOnly?: boolean;
  label?: string;
  /** "market": crosses now, never rests (limit_price is still signed as the worst price). Default "limit". */
  orderType?: "limit" | "market";
  /** Stop-loss / take-profit: dormant until the mark crosses `price`. Not part of the signed data. */
  trigger?: { type: "stoploss" | "takeprofit"; price: string };
}

export interface Ctx {
  rpc: Rpc;
  signer: ActionSigner;
  net: Network;
  subaccountId: number;
  now?: () => number;
}

export type SignedOrder = Record<string, unknown> & { instrument_name: string; amount: string; direction: string };

export async function signOrder(req: OrderRequest, ctx: Ctx, expirySec = 600): Promise<SignedOrder> {
  const now = (ctx.now ?? Date.now)();
  const nonce = makeNonce(now);
  const expiry = Math.floor(now / 1000) + expirySec;
  const fields: ActionFields = {
    subaccountId: ctx.subaccountId,
    nonce,
    module: ctx.net.tradeModule,
    data: encodeTradeData({
      assetAddress: req.inst.assetAddress,
      subId: req.inst.subId,
      limitPrice: req.limitPrice,
      amount: req.amount,
      maxFee: req.maxFee,
      recipientId: ctx.subaccountId,
      isBid: req.direction === "buy",
    }),
    expiry,
    owner: ctx.signer.owner,
    signer: ctx.signer.signer,
  };
  const signature = await ctx.signer.signAction(fields);
  // wire decimals re-rendered from the signed e18 words so the exchange rebuilds identical bytes
  return {
    subaccount_id: ctx.subaccountId,
    instrument_name: req.inst.name,
    direction: req.direction,
    amount: fromE18(toE18(req.amount)),
    limit_price: fromE18(toE18(req.limitPrice)),
    max_fee: fromE18(toE18(req.maxFee)),
    nonce,
    signer: ctx.signer.signer,
    signature,
    signature_expiry_sec: expiry,
    order_type: req.orderType ?? "limit",
    time_in_force: req.tif,
    reduce_only: req.reduceOnly ?? false,
    mmp: false,
    label: req.label ?? "peo",
    ...(req.tif === "post_only" ? { reject_post_only: true } : {}),
    ...(req.trigger ? { trigger_type: req.trigger.type, trigger_price: fromE18(toE18(req.trigger.price)), trigger_price_type: "mark" } : {}),
  };
}

export interface Fill {
  tradeId: string;
  price: number;
  amount: number;
  fee: number;
}

export interface OrderOutcome {
  instrument: string;
  direction: "buy" | "sell";
  amount: number;
  orderId: string | null;
  status: string; // filled | cancelled | rejected | open | error
  filled: number;
  avgPrice: number;
  fee: number;
  fills: Fill[];
  error: string | null;
}

const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(x) ? x : 0;
};

export function parseOrderResult(raw: unknown, sent: SignedOrder): OrderOutcome {
  const r = (raw ?? {}) as { order?: Record<string, unknown>; trades?: Record<string, unknown>[] };
  const o = r.order ?? {};
  const fills: Fill[] = (Array.isArray(r.trades) ? r.trades : []).map((t) => ({
    tradeId: String(t.trade_id ?? ""),
    price: n(t.trade_price),
    amount: n(t.trade_amount),
    fee: n(t.trade_fee),
  }));
  const filledFromTrades = fills.reduce((s, f) => s + f.amount, 0);
  return {
    instrument: sent.instrument_name,
    direction: sent.direction === "sell" ? "sell" : "buy",
    amount: n(sent.amount),
    orderId: typeof o.order_id === "string" ? o.order_id : null,
    status: typeof o.order_status === "string" ? o.order_status : "unknown",
    filled: o.filled_amount !== undefined ? n(o.filled_amount) : filledFromTrades,
    avgPrice: n(o.average_price),
    fee: fills.reduce((s, f) => s + f.fee, 0) || n(o.order_fee),
    fills,
    error: null,
  };
}

export async function sendOrder(rpc: Rpc, order: SignedOrder): Promise<OrderOutcome> {
  try {
    return parseOrderResult(await rpc.call("private/order", order), order);
  } catch (e) {
    return {
      instrument: order.instrument_name,
      direction: order.direction === "sell" ? "sell" : "buy",
      amount: n(order.amount),
      orderId: null,
      status: "error",
      filled: 0,
      avgPrice: 0,
      fee: 0,
      fills: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export interface SpreadResult {
  status: "filled" | "not-filled" | "unwound" | "exposed";
  long: OrderOutcome;
  short: OrderOutcome | null;
  unwind: OrderOutcome | null;
  fees: number;
  netDebit: number; // what the position actually cost, excluding fees
  message: string;
}

const eq = (a: number, b: number) => Math.abs(a - b) < 1e-9;

export async function placeSpread(ctx: Ctx, q: SpreadQuote, onStep?: (s: string) => void): Promise<SpreadResult> {
  const L = q.legs.long, S = q.legs.short;
  const idx = L.ticker.index || S.ticker.index;
  onStep?.(ctx.signer.silent ? "Signing with your one-tap key" : "Sign the orders in your wallet (3 signatures)");
  const longOrder = await signOrder(
    { inst: L.instrument, direction: "buy", amount: q.amount, limitPrice: q.longLimit, maxFee: maxFeePerUnit(L.instrument, idx, Number(q.longLimit), q.n), tif: "fok" },
    ctx,
  );
  const shortOrder = await signOrder(
    { inst: S.instrument, direction: "sell", amount: q.amount, limitPrice: q.shortLimit, maxFee: maxFeePerUnit(S.instrument, idx, Number(q.shortLimit), q.n), tif: "fok" },
    ctx,
  );
  const unwindPx = protectiveLimit("sell", L.ticker, L.instrument);
  const unwindOrder = await signOrder(
    { inst: L.instrument, direction: "sell", amount: q.amount, limitPrice: unwindPx, maxFee: maxFeePerUnit(L.instrument, idx, Number(unwindPx), q.n), tif: "ioc", label: "peo-unwind" },
    ctx,
  );

  onStep?.("Buying " + L.instrument.name);
  const long = await sendOrder(ctx.rpc, longOrder);
  if (long.filled <= 0) {
    return { status: "not-filled", long, short: null, unwind: null, fees: long.fee, netDebit: 0, message: long.error ?? "The first leg did not fill, so nothing was bought." };
  }
  if (!eq(long.filled, q.n)) {
    // fill-or-kill should make this impossible; treat a partial like a failed second leg
    const unwind = await unwindLong(ctx, L.instrument, L.ticker, long.filled, idx);
    return finish(long, null, unwind, long.filled);
  }

  onStep?.("Selling " + S.instrument.name);
  const short = await sendOrder(ctx.rpc, shortOrder);
  if (eq(short.filled, q.n)) {
    const netDebit = long.avgPrice * long.filled - short.avgPrice * short.filled;
    return { status: "filled", long, short, unwind: null, fees: long.fee + short.fee, netDebit, message: "Both legs filled." };
  }
  const residual = long.filled - short.filled;
  onStep?.("Second leg failed. Unwinding the first leg");
  const unwind = eq(residual, q.n) ? await sendOrder(ctx.rpc, unwindOrder) : await unwindLong(ctx, L.instrument, L.ticker, residual, idx);
  return finish(long, short, unwind, residual);
}

async function unwindLong(ctx: Ctx, inst: Instrument, t: Ticker, amount: number, idx: number): Promise<OrderOutcome> {
  const px = protectiveLimit("sell", t, inst);
  const o = await signOrder(
    { inst, direction: "sell", amount: alignDown(amount, inst.amountStep), limitPrice: px, maxFee: maxFeePerUnit(inst, idx, Number(px), amount), tif: "ioc", label: "peo-unwind" },
    ctx,
  );
  return sendOrder(ctx.rpc, o);
}

function finish(long: OrderOutcome, short: OrderOutcome | null, unwind: OrderOutcome, residual: number): SpreadResult {
  const fees = long.fee + (short?.fee ?? 0) + unwind.fee;
  const netDebit = long.avgPrice * long.filled - (short ? short.avgPrice * short.filled : 0) - unwind.avgPrice * unwind.filled;
  const left = residual - unwind.filled;
  if (left <= 1e-9) {
    return { status: "unwound", long, short, unwind, fees, netDebit, message: `The second leg did not fill (${short?.error ?? short?.status ?? "partial"}). The first leg was sold back straight away.` };
  }
  return {
    status: "exposed",
    long,
    short,
    unwind,
    fees,
    netDebit,
    message: `The second leg did not fill and only ${unwind.filled} of ${residual} contracts could be sold back. ${left} ${long.instrument} is still open: close it from Portfolio.`,
  };
}

/** Close one position with a reduce-only IOC order that crosses the book. */
export async function closePosition(ctx: Ctx, inst: Instrument, t: Ticker, amount: number): Promise<OrderOutcome> {
  const side = amount > 0 ? "sell" : "buy";
  const px = protectiveLimit(side, t, inst);
  const o = await signOrder(
    { inst, direction: side, amount: alignDown(Math.abs(amount), inst.amountStep), limitPrice: px, maxFee: maxFeePerUnit(inst, t.index, Number(px), Math.abs(amount)), tif: "ioc", reduceOnly: true, label: "peo-close" },
    ctx,
  );
  return sendOrder(ctx.rpc, o);
}

/** Close a spread: buy back the short leg first so no naked short is ever left. */
export async function closeSpread(
  ctx: Ctx,
  legs: { inst: Instrument; ticker: Ticker; amount: number }[],
): Promise<OrderOutcome[]> {
  const ordered = [...legs].sort((a, b) => a.amount - b.amount); // negative (short) first
  const out: OrderOutcome[] = [];
  for (const l of ordered) {
    const r = await closePosition(ctx, l.inst, l.ticker, l.amount);
    out.push(r);
    if (l.amount < 0 && r.filled + 1e-9 < Math.abs(l.amount)) break; // short not closed: keep the long as cover
  }
  return out;
}

export async function cancelOrder(rpc: Rpc, subaccountId: number, orderId: string, instrument: string): Promise<void> {
  await rpc.call("private/cancel", { subaccount_id: subaccountId, order_id: orderId, instrument_name: instrument });
}

export interface PreTrade {
  valid: boolean;
  reason: string | null;
  estFee: number | null;
  estCost: number | null;
}

/** Exchange-side dry run (no signature): margin check and fee estimate for the two legs. */
export async function preTradeCheck(rpc: Rpc, subaccountId: number, q: SpreadQuote): Promise<PreTrade> {
  const r = await rpc.call<Record<string, unknown>>("private/rfq_get_best_quote", {
    subaccount_id: subaccountId,
    direction: "buy",
    legs: [
      { instrument_name: q.legs.long.instrument.name, direction: "buy", amount: q.amount },
      { instrument_name: q.legs.short.instrument.name, direction: "sell", amount: q.amount },
    ].sort((a, b) => a.instrument_name.localeCompare(b.instrument_name)),
  });
  return {
    valid: r?.is_valid === true,
    reason: typeof r?.invalid_reason === "string" ? r.invalid_reason : null,
    estFee: r?.estimated_fee != null ? n(r.estimated_fee) : null,
    estCost: r?.estimated_total_cost != null ? n(r.estimated_total_cost) : null,
  };
}
