// When may the user press Confirm? One pure function, so the rule is testable.

import { MAINNET_PHRASE, QUOTE_MAX_AGE_MS, type NetworkId } from "../config.ts";
import type { SpreadQuote } from "./spread.ts";
import type { PerpQuote } from "./perp.ts";
import { money } from "./format.ts";

export interface ConfirmInput {
  quote: SpreadQuote | null;
  quoteAgeMs: number | null; // age of the ticker set the quote came from
  connected: boolean; // signed in to Derive on this network
  balance: number | null; // subaccount_value of the selected subaccount
  subaccountRU: number | null;
  assetRU: number | null;
  agreed: boolean;
  network: NetworkId;
  typed: string; // mainnet confirmation phrase
  busy: boolean;
  /** Optional user limit on what one mainnet trade may cost (worst case). null = off (the default). */
  maxCost?: number | null;
}

export interface ConfirmState {
  enabled: boolean;
  label: string;
  reason: "ok" | "no-price" | "stale" | "mark-only" | "wallet" | "wrong-universe" | "balance" | "depth" | "cap" | "agree" | "phrase" | "busy";
}

export function confirmState(i: ConfirmInput): ConfirmState {
  const no = (reason: ConfirmState["reason"], label: string): ConfirmState => ({ enabled: false, reason, label });
  const q = i.quote;
  if (i.busy) return no("busy", "Placing your order…");
  if (!q) return no("no-price", "Waiting for a live price");
  if (i.quoteAgeMs === null || !(i.quoteAgeMs >= 0) || i.quoteAgeMs > QUOTE_MAX_AGE_MS) return no("stale", "Waiting for a live price");
  if (q.priced !== "book") return no("mark-only", "No live order book for one leg");
  if (!i.connected) return no("wallet", "Connect wallet to trade");
  if (i.assetRU === null || i.subaccountRU === null || i.subaccountRU !== i.assetRU) return no("wrong-universe", "Pick a subaccount for this asset");
  if (i.balance === null || !(i.balance >= q.worstLoss)) return no("balance", "Not enough collateral");
  if (!q.depthOk) return no("depth", "Not enough size on the book. Lower the amount");
  if (i.network === "mainnet" && i.maxCost != null && i.maxCost > 0 && q.worstLoss > i.maxCost) return no("cap", `Above your ${money(i.maxCost)} limit per trade`);
  if (!i.agreed) return no("agree", "Tick the box to continue");
  if (i.network === "mainnet" && i.typed.trim().toUpperCase() !== MAINNET_PHRASE) return no("phrase", `Type ${MAINNET_PHRASE} to confirm`);
  return { enabled: true, reason: "ok", label: (i.network === "mainnet" ? "Pay real money: " : "Confirm and pay ") + money(q.maxLoss) };
}

/** Parse the optional mainnet per-trade limit setting: empty / zero / junk = off. */
export function parseMaxCost(v: string | null | undefined): number | null {
  if (v == null) return null;
  const s = String(v).trim().replace(/[$,\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface PerpConfirmInput {
  quote: PerpQuote | null;
  quoteAgeMs: number | null;
  connected: boolean;
  /** An account that can trade this market is selected (Derive: a subaccount in its risk universe). */
  accountOk: boolean;
  /** Exchange margin check of the simulated trade (private/get_margin); null while it runs. */
  marginValid: boolean | null;
  agreed: boolean;
  network: NetworkId;
  typed: string;
  busy: boolean;
  /** Optional mainnet per-trade limit, applied to the money put in (margin). null = off. */
  maxCost?: number | null;
}

export interface PerpConfirmState {
  enabled: boolean;
  label: string;
  reason: "ok" | "no-price" | "stale" | "wallet" | "wrong-universe" | "problem" | "margin" | "cap" | "agree" | "phrase" | "busy";
}

export function perpConfirmState(i: PerpConfirmInput): PerpConfirmState {
  const no = (reason: PerpConfirmState["reason"], label: string): PerpConfirmState => ({ enabled: false, reason, label });
  const q = i.quote;
  if (i.busy) return no("busy", "Placing your order…");
  if (!q) return no("no-price", "Waiting for a live price");
  if (i.quoteAgeMs === null || !(i.quoteAgeMs >= 0) || i.quoteAgeMs > QUOTE_MAX_AGE_MS) return no("stale", "Waiting for a live price");
  if (!i.connected) return no("wallet", "Connect wallet to trade");
  if (!i.accountOk) return no("wrong-universe", `Pick a subaccount for ${q.inst.name}`);
  if (q.problems.length) return no("problem", q.problems[0]!);
  if (i.marginValid === false) return no("margin", "Derive says there is not enough margin");
  if (i.network === "mainnet" && i.maxCost != null && i.maxCost > 0 && q.putIn > i.maxCost) return no("cap", `Above your ${money(i.maxCost)} limit per trade`);
  if (!i.agreed) return no("agree", "Tick the box to continue");
  if (i.network === "mainnet" && i.typed.trim().toUpperCase() !== MAINNET_PHRASE) return no("phrase", `Type ${MAINNET_PHRASE} to confirm`);
  const what = `${q.dir === "long" ? "Go long" : "Go short"} ${q.amount} ${q.inst.currency}${q.orderType === "limit" ? " at " + q.limitPrice : ""}`;
  return { enabled: true, reason: "ok", label: (i.network === "mainnet" ? "Real money: " : "") + what };
}

/** Parse the leverage cap setting: 1 … uiMax, default when empty or junk. */
export function parseLeverageCap(v: string | null | undefined, uiMax: number, fallback: number): number {
  const n = Number(String(v ?? "").trim().replace(/[x×\s]/gi, ""));
  if (!Number.isFinite(n) || n <= 0 || String(v ?? "").trim() === "") return fallback;
  return Math.min(uiMax, Math.max(1, Math.round(n * 2) / 2));
}
