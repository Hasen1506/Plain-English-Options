// The sentence builder as a pure state machine: (state, action) → state,
// plus a view model that turns state + market data into the text on screen.

import type { Asset } from "../config.ts";
import type { Direction } from "./pricing.ts";
import type { SpreadQuote, SelectFail, QuoteFail } from "./spread.ts";
import { money, movePct, pct, price } from "./format.ts";

export type Pop = "amt" | "asset" | "tgt" | "date";

export interface BuilderState {
  amount: number; // profit the user wants
  asset: Asset;
  dir: Direction;
  target: number | null; // null until the first live price arrives
  expiryKey: string | null;
  open: Pop | null;
}

export type Action =
  | { type: "amount"; value: number }
  | { type: "asset"; asset: Asset; spot: number | null }
  | { type: "toggleDir"; spot: number | null }
  | { type: "target"; value: number }
  | { type: "expiry"; key: string }
  | { type: "expiries"; list: { key: string; days: number }[] }
  | { type: "spot"; spot: number }
  | { type: "open"; pop: Pop }
  | { type: "close" };

export const AMOUNT_MIN = 1;
export const AMOUNT_MAX = 1_000_000;
export const DEFAULT_MOVE = 0.15;
const DEFAULT_DAYS = 45;

export const initialState = (asset: Asset = "ETH"): BuilderState => ({
  amount: 1000,
  asset,
  dir: "up",
  target: null,
  expiryKey: null,
  open: null,
});

export const defaultTarget = (spot: number, dir: Direction): number => (dir === "up" ? spot * (1 + DEFAULT_MOVE) : spot * (1 - DEFAULT_MOVE));
/** Default target, or null when spot is unusable (≤ 0, NaN, or so large the target overflows). */
const autoTarget = (spot: number | null, dir: Direction): number | null => {
  if (spot === null || !(spot > 0)) return null;
  const t = defaultTarget(spot, dir);
  return Number.isFinite(t) && t > 0 ? t : null;
};

export function reduce(s: BuilderState, a: Action): BuilderState {
  switch (a.type) {
    case "amount":
      if (!Number.isFinite(a.value)) return s;
      return { ...s, amount: Math.min(AMOUNT_MAX, Math.max(AMOUNT_MIN, a.value)) };
    case "asset":
      if (a.asset === s.asset) return { ...s, open: null };
      return { ...s, asset: a.asset, target: autoTarget(a.spot, s.dir), expiryKey: null, open: null };
    case "toggleDir": {
      const dir: Direction = s.dir === "up" ? "down" : "up";
      return { ...s, dir, target: autoTarget(a.spot, dir) ?? s.target, open: null };
    }
    case "target":
      if (!(a.value > 0) || !Number.isFinite(a.value)) return s;
      return { ...s, target: a.value };
    case "expiry":
      return { ...s, expiryKey: a.key };
    case "expiries": {
      if (!a.list.length) return { ...s, expiryKey: null };
      if (s.expiryKey && a.list.some((e) => e.key === s.expiryKey)) return s;
      const best = a.list.reduce((b, e) => (Math.abs(e.days - DEFAULT_DAYS) < Math.abs(b.days - DEFAULT_DAYS) ? e : b));
      return { ...s, expiryKey: best.key };
    }
    case "spot":
      if (s.target !== null) return s;
      return { ...s, target: autoTarget(a.spot, s.dir) };
    case "open":
      return { ...s, open: s.open === a.pop ? null : a.pop };
    case "close":
      return s.open === null ? s : { ...s, open: null };
  }
}

export interface SentenceView {
  amount: string;
  asset: string;
  dirWord: string;
  target: string;
  move: string;
  moveDown: boolean;
  date: string;
  kind: string;
  cost: string;
  chance: string;
  hint: string | null;
  buy: string;
  buyEnabled: boolean;
  note: string | null; // "mark" / "min size" badges
}

export interface QuoteResult {
  quote: SpreadQuote | null;
  fail: SelectFail | QuoteFail | "no-data" | null;
  probability: number | null;
}

export function sentence(s: BuilderState, spot: number | null, dateShort: string | null, q: QuoteResult): SentenceView {
  const up = s.dir === "up";
  const mv = spot && s.target ? movePct(spot, s.target) : { text: "", down: false };
  const base = {
    amount: money(s.amount),
    asset: s.asset,
    dirWord: up ? "hits" : "drops to",
    target: price(s.target),
    move: mv.text,
    moveDown: mv.down,
    date: dateShort ?? "…",
    kind: up ? "Call spread" : "Put spread",
  };
  if (q.quote) {
    const note = q.quote.priced === "mark" ? "mark" : q.quote.belowMinimum ? "min size" : null;
    return {
      ...base,
      cost: "It costs " + money(q.quote.maxLoss),
      chance: q.probability === null ? "Chance unavailable" : pct(q.probability) + " chance it happens",
      hint: null,
      buy: money(q.quote.maxLoss),
      buyEnabled: true,
      note,
    };
  }
  const up2 = up;
  const hint =
    q.fail === "wrong-side"
      ? up2
        ? `Pick a target above ${price(spot)} for “hits”, or switch to “drops to”.`
        : `Pick a target below ${price(spot)} for “drops to”, or switch to “hits”.`
      : q.fail === "no-edge"
        ? "The book has no sensible price for this spread right now. Try another target or date."
        : q.fail === "no-short-strike" || q.fail === "no-long-strike"
          ? "No listed strikes that far for this date. Try a closer target or another date."
          : q.fail === "too-large"
            ? "That amount needs more contracts than the exchange allows. Try a smaller amount."
            : null;
  const waiting = q.fail === "no-data" || q.fail === "no-instruments" || q.fail === "no-price" || !spot;
  return {
    ...base,
    cost: waiting ? "It costs …" : "It costs —",
    chance: waiting ? `Waiting for a live ${s.asset} price` : "No quote",
    hint: waiting ? null : hint,
    buy: waiting ? "…" : "—",
    buyEnabled: false,
    note: null,
  };
}
