// Pure builders for Hyperliquid order actions (wire format of the Python SDK's
// order_request_to_order_wire / order_wires_to_order_action) and the mapping
// of exchange replies to the app's OrderOutcome. No network here.

import type { PerpQuote } from "../../lib/perp.ts";
import type { OrderOutcome } from "../../net/trader.ts";
import { HL_TRIGGER_SLIPPAGE } from "./config.ts";
import { hlName, parseStatus, type HlAsset } from "./parse.ts";
import { meetsMinimum, roundPrice, roundSize, toWire, validPrice, validSize } from "./rules.ts";

export type Tif = "Gtc" | "Ioc" | "Alo";
export type OrderWire = {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { limit: { tif: Tif } } | { trigger: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" } };
  c?: string;
};
export type Grouping = "na" | "normalTpsl" | "positionTpsl";

export function wire(asset: HlAsset, isBuy: boolean, px: string, sz: string, reduceOnly: boolean, t: OrderWire["t"]): OrderWire {
  if (!validPrice(px, asset.szDecimals)) throw new Error(`price ${px} is not a valid ${asset.coin} price on Hyperliquid`);
  if (!validSize(sz, asset.szDecimals)) throw new Error(`size ${sz} has more than ${asset.szDecimals} decimals`);
  if (t && "trigger" in t && !validPrice(t.trigger.triggerPx, asset.szDecimals)) throw new Error(`trigger ${t.trigger.triggerPx} is not a valid price`);
  return { a: asset.index, b: isBuy, p: toWire(px), s: toWire(sz), r: reduceOnly, t };
}

export const orderAction = (orders: OrderWire[], grouping: Grouping = "na") => ({ type: "order", orders, grouping });
export const cancelAction = (cancels: { a: number; o: number }[]) => ({ type: "cancel", cancels });
export const leverageAction = (asset: number, isCross: boolean, leverage: number) => ({ type: "updateLeverage", asset, isCross, leverage });

/** Hyperliquid leverage is an integer between 1 and the asset maximum. */
export const hlLeverage = (lev: number, max: number): number => Math.max(1, Math.min(Math.floor(max), Math.floor(lev + 1e-9)));

/**
 * The order(s) for a quote: entry + optional TP/SL children (grouping normalTpsl:
 * the children only activate once the entry fills, and are reduce-only market triggers).
 * Prices are re-snapped to Hyperliquid's rules, never in the trader's disfavour:
 * buy limits round down, sell limits round up (a market order's protection price
 * therefore never ends up looser than the one shown).
 */
export function entryOrders(asset: HlAsset, q: Pick<PerpQuote, "side" | "amount" | "limitPrice" | "tif" | "takeProfit" | "stopLoss">): { wires: OrderWire[]; grouping: Grouping } {
  const isBuy = q.side === "buy";
  const px = roundPrice(Number(q.limitPrice), asset.szDecimals, isBuy ? "down" : "up");
  const sz = roundSize(Number(q.amount), asset.szDecimals);
  if (!(Number(sz) > 0)) throw new Error("size rounds to zero");
  if (!meetsMinimum(sz, px)) throw new Error(`Hyperliquid's minimum order is $10 (this one is $${(Number(sz) * Number(px)).toFixed(2)})`);
  const tif: Tif = q.tif === "ioc" ? "Ioc" : q.tif === "post_only" ? "Alo" : "Gtc";
  const wires = [wire(asset, isBuy, px, sz, false, { limit: { tif } })];
  const child = (trigger: string, kind: "tp" | "sl") => {
    const tp = roundPrice(Number(trigger), asset.szDecimals, "down");
    // the trigger fires a market order; its worst price is HL_TRIGGER_SLIPPAGE past the trigger
    const worst = roundPrice(Number(tp) * (isBuy ? 1 - HL_TRIGGER_SLIPPAGE : 1 + HL_TRIGGER_SLIPPAGE), asset.szDecimals, isBuy ? "down" : "up");
    return wire(asset, !isBuy, worst, sz, true, { trigger: { isMarket: true, triggerPx: tp, tpsl: kind } });
  };
  if (q.takeProfit) wires.push(child(q.takeProfit, "tp"));
  if (q.stopLoss) wires.push(child(q.stopLoss, "sl"));
  return { wires, grouping: wires.length > 1 ? "normalTpsl" : "na" };
}

/** Reduce-only IOC that closes `size` of a position at most `slip` through the touch. */
export function closeOrder(asset: HlAsset, position: number, size: string, touch: number, slip: number): OrderWire {
  const isBuy = position < 0; // closing a short buys
  if (!(touch > 0)) throw new Error(`no ${isBuy ? "ask" : "bid"} on the ${asset.coin} book`);
  const px = roundPrice(touch * (isBuy ? 1 + slip : 1 - slip), asset.szDecimals, isBuy ? "down" : "up");
  return wire(asset, isBuy, px, roundSize(Number(size), asset.szDecimals), true, { limit: { tif: "Ioc" } });
}

/** Exchange reply (statuses[i]) → OrderOutcome. */
export function outcome(asset: HlAsset, w: OrderWire, status: unknown): OrderOutcome {
  const s = parseStatus(status);
  const amount = Number(w.s);
  const base = { instrument: hlName(asset.coin), direction: (w.b ? "buy" : "sell") as "buy" | "sell", amount, fills: [], fee: 0 };
  if (s.kind === "filled") return { ...base, orderId: s.oid === null ? null : String(s.oid), status: s.totalSz + 1e-12 >= amount ? "filled" : "partial", filled: s.totalSz, avgPrice: s.avgPx, error: null };
  if (s.kind === "resting") return { ...base, orderId: s.oid === null ? null : String(s.oid), status: "open", filled: 0, avgPrice: 0, error: null };
  if (s.kind === "error") return { ...base, orderId: null, status: "rejected", filled: 0, avgPrice: 0, error: s.error };
  return { ...base, orderId: null, status: s.error ?? "unknown", filled: 0, avgPrice: 0, error: null };
}

/** An IOC that did not fill at all comes back as an error ("Order could not immediately match…"): report it as cancelled. */
export function iocNoFill(o: OrderOutcome): OrderOutcome {
  return o.error && /could not immediately match/i.test(o.error) ? { ...o, status: "cancelled", error: "No liquidity inside your price protection; nothing was traded" } : o;
}
