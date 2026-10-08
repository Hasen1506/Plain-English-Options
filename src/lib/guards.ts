// When may the user press Confirm? One pure function, so the rule is testable.

import { MAINNET_PHRASE, QUOTE_MAX_AGE_MS, type NetworkId } from "../config.ts";
import type { SpreadQuote } from "./spread.ts";
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
}

export interface ConfirmState {
  enabled: boolean;
  label: string;
  reason: "ok" | "no-price" | "stale" | "mark-only" | "wallet" | "wrong-universe" | "balance" | "depth" | "agree" | "phrase" | "busy";
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
  if (!i.agreed) return no("agree", "Tick the box to continue");
  if (i.network === "mainnet" && i.typed.trim().toUpperCase() !== MAINNET_PHRASE) return no("phrase", `Type ${MAINNET_PHRASE} to confirm`);
  return { enabled: true, reason: "ok", label: (i.network === "mainnet" ? "Pay real money: " : "Confirm and pay ") + money(q.maxLoss) };
}
