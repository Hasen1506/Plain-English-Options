// Perp orders on Derive v3, through the same signing path as options
// (signOrder → private/order). Nothing here is perp-specific about signing: a
// perp is one more instrument with an asset address and sub id.
//
//   market  → order_type "market", time_in_force "ioc", limit = touch ± slippage (worst price)
//   limit   → "limit" + "gtc", or "post_only" (reject_post_only: maker or rejected)
//   close   → reduce-only market IOC for all or part of a position
//   flip    → close (reduce-only) then open the same size the other way; both signed first
//   TP / SL → reduce-only market trigger orders on the mark price
//   kill    → cancel_all (incl. trigger + algo orders), then close every position

import { PERP_SLIPPAGE, RESTING_ORDER_TTL_SEC, SESSION_SAFETY_SEC, TRIGGER_ORDER_TTL_SEC, TRIGGER_SLIPPAGE } from "../config.ts";
import { closeAmount, marketLimit, minSize, perpMaxFee, type PerpInstrument, type PerpQuote, type PerpTicker } from "../lib/perp.ts";
import { alignDown, alignUp, toE18 } from "../lib/units.ts";
import { sendOrder, signOrder, type Ctx, type OrderOutcome, type Rpc, type SignedOrder } from "./trader.ts";

/** A quote on a Derive instrument (its market carries the asset address and sub id the signature needs). */
export type DeriveQuote = PerpQuote & { inst: PerpInstrument };
export function isDeriveQuote(q: PerpQuote): q is DeriveQuote {
  const i = q.inst as Partial<PerpInstrument>;
  return typeof i.assetAddress === "string" && typeof i.subId === "string";
}

export interface PerpOpenResult {
  entry: OrderOutcome;
  triggers: OrderOutcome[]; // take-profit / stop-loss, sized to what filled
  message: string;
}

const noFill = (o: SignedOrder, error: string): OrderOutcome => ({
  instrument: o.instrument_name,
  direction: o.direction === "sell" ? "sell" : "buy",
  amount: Number(o.amount),
  orderId: null,
  status: "error",
  filled: 0,
  avgPrice: 0,
  fee: 0,
  fills: [],
  error,
});

/**
 * How long a resting order's signature may live. A one-tap key's signatures die
 * with the key, so a limit signed by it expires (and leaves the book) a little
 * before the key does.
 */
export function restingTtl(ctx: Ctx, wanted = RESTING_ORDER_TTL_SEC): number {
  const nowSec = Math.floor((ctx.now ?? Date.now)() / 1000);
  if (ctx.signer.expiresAt === undefined) return wanted;
  return Math.max(600, Math.min(wanted, ctx.signer.expiresAt - SESSION_SAFETY_SEC - nowSec));
}

/** Can this signer sign a TP/SL? Triggers must live ≥ 30 days, longer than any one-tap key. */
export const canSignTriggers = (ctx: Ctx): boolean => {
  const nowSec = Math.floor((ctx.now ?? Date.now)() / 1000);
  return ctx.signer.expiresAt === undefined || ctx.signer.expiresAt - nowSec > TRIGGER_ORDER_TTL_SEC + 3600;
};

/** Sign the entry order of a quote (no network). */
export function signPerpEntry(ctx: Ctx, q: DeriveQuote, label = "peo-perp"): Promise<SignedOrder> {
  return signOrder(
    { inst: q.inst, direction: q.side, amount: q.amount, limitPrice: q.limitPrice, maxFee: q.maxFee, tif: q.tif, orderType: q.orderType, label },
    ctx,
    q.orderType === "limit" ? restingTtl(ctx) : 600,
  );
}

/** A reduce-only take-profit or stop-loss for `amount` of a position opened on `side`. */
export function signTrigger(ctx: Ctx, inst: PerpInstrument, index: number, openedSide: "buy" | "sell", amount: string, type: "takeprofit" | "stoploss", triggerPrice: string): Promise<SignedOrder> {
  const exit = openedSide === "buy" ? "sell" : "buy";
  const tp = Number(triggerPrice);
  // fires as a market order; the signed limit is the worst price it may take after triggering
  const worst = exit === "sell" ? alignUp(Math.max(tp * (1 - TRIGGER_SLIPPAGE), Number(inst.tickSize)), inst.tickSize) : alignDown(tp * (1 + TRIGGER_SLIPPAGE), inst.tickSize);
  return signOrder(
    { inst, direction: exit, amount, limitPrice: worst, maxFee: perpMaxFee(inst, index, Math.max(tp, Number(worst)), Number(amount)), tif: "gtc", orderType: "market", reduceOnly: true, label: type === "takeprofit" ? "peo-tp" : "peo-sl", trigger: { type, price: triggerPrice } },
    ctx,
    TRIGGER_ORDER_TTL_SEC,
  );
}

/**
 * Open (or add to) a position. TP/SL are signed BEFORE the entry is sent (so a
 * wallet user approves everything up front) and placed only for what filled.
 * Triggers live 30+ days, so they are signed by `triggerCtx` (the wallet), never
 * by a one-tap key that expires sooner.
 */
export async function openPerp(ctx: Ctx, q: DeriveQuote, onStep?: (s: string) => void, triggerCtx: Ctx = ctx): Promise<PerpOpenResult> {
  const nTrig = (q.takeProfit ? 1 : 0) + (q.stopLoss ? 1 : 0);
  if (nTrig && !canSignTriggers(triggerCtx)) throw new Error("Take-profit and stop-loss orders last 30 days, longer than a one-tap key: they need your wallet's signature");
  const prompts = (ctx.signer.silent ? 0 : 1) + (triggerCtx.signer.silent ? 0 : nTrig);
  onStep?.(prompts ? `Sign in your wallet (${prompts} signature${prompts > 1 ? "s" : ""})` : "Signing with your one-tap key");
  const entryOrder = await signPerpEntry(ctx, q);
  const pre: { type: "takeprofit" | "stoploss"; price: string; order: SignedOrder }[] = [];
  for (const [type, price] of [["takeprofit", q.takeProfit], ["stoploss", q.stopLoss]] as const) {
    if (price) pre.push({ type, price, order: await signTrigger(triggerCtx, q.inst, q.entry, q.side, q.amount, type, price) });
  }
  onStep?.(`${q.side === "buy" ? "Buying" : "Selling"} ${q.amount} ${q.inst.name}`);
  const entry = await sendOrder(ctx.rpc, entryOrder);
  const triggers: OrderOutcome[] = [];
  if (entry.filled > 0 && pre.length) {
    onStep?.("Placing take-profit / stop-loss");
    const filled = alignDown(entry.filled, q.inst.amountStep);
    for (const p of pre) {
      // pre-signed for the full size; a partial fill needs a smaller one (one more signature)
      const order = toE18(filled) === toE18(q.amount) ? p.order : await signTrigger(triggerCtx, q.inst, q.entry, q.side, filled, p.type, p.price);
      triggers.push(await sendOrder(ctx.rpc, order));
    }
  }
  const resting = entry.status === "open" || entry.status === "untriggered";
  const message =
    entry.error !== null
      ? `Not placed: ${entry.error}`
      : entry.filled > 0
        ? `${entry.filled === entry.amount ? "Filled" : `Filled ${entry.filled} of ${entry.amount}`} at ${entry.avgPrice}.` + (triggers.some((t) => t.error) ? " A take-profit/stop-loss was rejected: " + triggers.filter((t) => t.error).map((t) => t.error).join("; ") : "")
        : resting
          ? "Your limit order is resting on the book. Cancel it from Portfolio."
          : `Nothing filled (${entry.status}).`;
  return { entry, triggers, message };
}

/** Reduce-only market close of `fraction` (0–1] of a signed position. */
export async function closePerp(ctx: Ctx, inst: PerpInstrument, t: PerpTicker, position: number, fraction = 1, label = "peo-close"): Promise<OrderOutcome> {
  const side = position > 0 ? "sell" : "buy";
  const amount = closeAmount(position, fraction, inst.amountStep);
  const lim = marketLimit(side, t, inst.tickSize, PERP_SLIPPAGE * 4) ?? closeFallback(side, t, inst);
  const o = await signOrder({ inst, direction: side, amount, limitPrice: lim, maxFee: perpMaxFee(inst, t.index, Number(lim), Number(amount)), tif: "ioc", orderType: "market", reduceOnly: true, label }, ctx);
  if (!(Number(amount) > 0)) return noFill(o, "Amount rounds to zero");
  return sendOrder(ctx.rpc, o);
}

/** No book on that side: bound by the exchange band so the close can still go out. */
function closeFallback(side: "buy" | "sell", t: PerpTicker, inst: PerpInstrument): string {
  const ref = t.mark > 0 ? t.mark : t.index;
  const px = side === "sell" ? Math.max(t.minPrice ?? ref * 0.95, Number(inst.tickSize)) : (t.maxPrice ?? ref * 1.05);
  return side === "sell" ? alignUp(px, inst.tickSize) : alignDown(px, inst.tickSize);
}

export interface FlipResult {
  close: OrderOutcome;
  open: OrderOutcome | null;
  message: string;
}

/** Turn a long into an equal short (or back). Both orders are signed before either is sent. */
export async function flipPerp(ctx: Ctx, inst: PerpInstrument, t: PerpTicker, position: number): Promise<FlipResult> {
  const closeSide = position > 0 ? "sell" : "buy";
  const amount = closeAmount(position, 1, inst.amountStep);
  // the new side is an opening order, so it must meet the minimum; never close without being able to reopen
  if (toE18(amount) < toE18(minSize(inst))) throw new Error(`Flip needs at least ${minSize(inst)} ${inst.currency} (the exchange minimum for a new position). Close it instead`);
  const lim = marketLimit(closeSide, t, inst.tickSize, PERP_SLIPPAGE * 4) ?? closeFallback(closeSide, t, inst);
  const fee = perpMaxFee(inst, t.index, Number(lim), Number(amount));
  const closeO = await signOrder({ inst, direction: closeSide, amount, limitPrice: lim, maxFee: fee, tif: "ioc", orderType: "market", reduceOnly: true, label: "peo-flip-close" }, ctx);
  const openO = await signOrder({ inst, direction: closeSide, amount, limitPrice: lim, maxFee: fee, tif: "ioc", orderType: "market", label: "peo-flip-open" }, ctx);
  const close = await sendOrder(ctx.rpc, closeO);
  if (Math.abs(close.filled - Number(amount)) > 1e-9) {
    return { close, open: null, message: `Only ${close.filled} of ${amount} closed, so the new ${position > 0 ? "short" : "long"} was not opened.` };
  }
  const open = await sendOrder(ctx.rpc, openO);
  return { close, open, message: open.filled > 0 ? `Flipped: now ${position > 0 ? "short" : "long"} ${open.filled}.` : `Closed, but the new side did not fill (${open.error ?? open.status}). You are flat.` };
}

export async function cancelTrigger(rpc: Rpc, subaccountId: number, orderId: string): Promise<void> {
  await rpc.call("private/cancel_trigger_order", { subaccount_id: subaccountId, order_id: orderId });
}

/** One call that cancels resting orders, take-profit/stop-loss triggers and algo orders. */
export async function cancelEverything(rpc: Rpc, subaccountId: number): Promise<void> {
  await rpc.call("private/cancel_all", { subaccount_id: subaccountId, cancel_trigger_orders: true, cancel_algo_orders: true });
}

export interface KillLeg {
  name: string;
  amount: number;
  close: (amount: number) => Promise<OrderOutcome>;
  kind: "perp" | "option";
}

/**
 * "Close all positions": cancel every order first (so nothing re-opens), then
 * close option shorts, option longs, and perps, each reduce-only.
 */
export async function closeAll(rpc: Rpc, subaccountId: number, legs: KillLeg[], onStep?: (s: string) => void): Promise<{ cancelled: boolean; results: { name: string; outcome: OrderOutcome }[] }> {
  let cancelled = true;
  onStep?.("Cancelling every order and trigger…");
  try {
    await cancelEverything(rpc, subaccountId);
  } catch {
    cancelled = false;
  }
  const rank = (l: KillLeg) => (l.kind === "option" ? (l.amount < 0 ? 0 : 1) : 2);
  const results: { name: string; outcome: OrderOutcome }[] = [];
  for (const l of [...legs].sort((a, b) => rank(a) - rank(b))) {
    onStep?.(`Closing ${l.name}…`);
    try {
      results.push({ name: l.name, outcome: await l.close(l.amount) });
    } catch (e) {
      results.push({ name: l.name, outcome: { instrument: l.name, direction: l.amount > 0 ? "sell" : "buy", amount: Math.abs(l.amount), orderId: null, status: "error", filled: 0, avgPrice: 0, fee: 0, fills: [], error: (e as Error).message } });
    }
  }
  return { cancelled, results };
}

export interface MarginCheck {
  valid: boolean;
  preIM: number | null;
  postIM: number | null;
  postMM: number | null;
}

/** Exchange-side margin check of a simulated position change (read-only, no signature). */
export async function perpMarginCheck(rpc: Rpc, subaccountId: number, instrument: string, signedAmount: string): Promise<MarginCheck> {
  const r = await rpc.call<Record<string, unknown>>("private/get_margin", { subaccount_id: subaccountId, simulated_position_changes: [{ instrument_name: instrument, amount: signedAmount }] });
  const f = (v: unknown) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  return { valid: r?.is_valid_trade === true, preIM: f(r?.pre_initial_margin), postIM: f(r?.post_initial_margin), postMM: f(r?.post_maintenance_margin) };
}

export interface TriggerOrder {
  orderId: string;
  instrument: string;
  direction: "buy" | "sell";
  amount: number;
  triggerType: string;
  triggerPrice: number;
  limitPrice: number;
  status: string;
}

export function parseTriggerOrders(raw: unknown): TriggerOrder[] {
  const list = (raw as { orders?: unknown[] } | null)?.orders;
  if (!Array.isArray(list)) return [];
  const out: TriggerOrder[] = [];
  for (const o of list) {
    if (typeof o !== "object" || o === null) continue;
    const r = o as Record<string, unknown>;
    if (typeof r.order_id !== "string" || typeof r.instrument_name !== "string") continue;
    out.push({
      orderId: r.order_id,
      instrument: r.instrument_name,
      direction: r.direction === "sell" ? "sell" : "buy",
      amount: Number(r.amount) || 0,
      triggerType: String(r.trigger_type ?? ""),
      triggerPrice: Number(r.trigger_price) || 0,
      limitPrice: Number(r.limit_price) || 0,
      status: String(r.order_status ?? "untriggered"),
    });
  }
  return out;
}
