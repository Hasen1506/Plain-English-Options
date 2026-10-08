// A deterministic Veranta (Base) for e2e tests, answering the app's HttpVerantaApi
// (src/venues/veranta/api.ts): POST /vr/<net>/<sid>/<method> {args, trader, session}
// → {ok, result} | {ok:false, error}. Side channel: GET /vr/<net>/<sid>/mock/state.
//
// Market data is the recorded pair catalogue + prices (tests/fixtures/veranta/<net>.json).
// The rules are Veranta's, as seen on the live testnet run of 2026-10-08
// (work/scratch/veranta/live-all-run1.json) and in veranta-sdk 0.3.1:
//   - no order book: market orders fill at the oracle price ± the pair spread
//   - the open fee comes out of the collateral (40 USDC at 5× → 39.91 margin), the close
//     fee out of what is paid back; maker/taker by open-interest skew (rules.openFeeRate)
//   - minimum position: collateral × leverage ≥ minLevPosUSDC; leverage within the pair's range
//   - USDC moves by transferFrom: the allowance must cover the collateral and is used up
//   - every position carries a take-profit (the pair's 900% max gain when none is given)
//   - orders are signed by the session key; only the registered, unexpired key may trade
//   - mainnet is refused (the app never trades it)

import { readFileSync } from "node:fs";
import { openFeeRate, type VHistoryRow, type VPair, type VRawLimit, type VRawPosition } from "../../src/venues/veranta/rules.ts";

type Net = "testnet" | "mainnet";
const fixtures: Record<Net, { pairs: VPair[]; prices: Record<string, number> }> = {
  testnet: JSON.parse(readFileSync(new URL("../fixtures/veranta/testnet.json", import.meta.url), "utf8")),
  mainnet: JSON.parse(readFileSync(new URL("../fixtures/veranta/mainnet.json", import.meta.url), "utf8")),
};
/** Recorded testnet prices plus a few more so the list has rows (the catalogue is recorded, these are not). */
const EXTRA_PRICES: Record<number, number> = {};

interface Pos {
  index: number;
  pairIndex: number;
  buy: boolean;
  collateral: number;
  leverage: number;
  openPrice: number;
  tp: number;
  sl: number;
}
interface Lim {
  index: number;
  pairIndex: number;
  buy: boolean;
  collateral: number;
  leverage: number;
  price: number;
  tp: number;
  sl: number;
}
export interface VrState {
  net: Net;
  trader: string | null;
  session: string | null;
  sessionExpiry: number;
  revoked: string[];
  balance: number;
  allowance: number;
  positions: Pos[];
  limits: Lim[];
  history: VHistoryRow[];
  log: string[];
  nextId: number;
  /** move the oracle (tests): pairIndex → multiplier */
  drift: Record<number, number>;
}

const states = new Map<string, VrState>();
const now = () => Math.floor(Date.now() / 1000);
const hex = (n: number, len = 40) => "0x" + n.toString(16).padStart(len, "0");

function state(net: Net, sid: string): VrState {
  const k = `${net}|${sid}`;
  let s = states.get(k);
  if (!s) {
    s = { net, trader: null, session: null, sessionExpiry: 0, revoked: [], balance: 0, allowance: 0, positions: [], limits: [], history: [], log: [], nextId: 1, drift: {} };
    states.set(k, s);
  }
  return s;
}

const pairOf = (s: VrState, sym: string) => {
  const [from, to] = sym.split("/");
  const p = fixtures[s.net].pairs.find((x) => x.from === from && x.to === to);
  if (!p) throw new Error(`unknown pair ${sym}`);
  return p;
};
function oracle(s: VrState, i: number): number {
  const px = fixtures[s.net].prices[String(i)] ?? EXTRA_PRICES[i];
  if (!px) throw new Error(`no price for pair ${i}`);
  return px * (s.drift[i] ?? 1);
}
const fee = (p: VPair, kind: "open" | "close") => {
  const a = p.additionalPairParams2 ?? {};
  return kind === "open" ? { maker: (a.openMakerFeeP ?? 0) / 100, taker: (a.openTakerFeeP ?? p.openFeeP ?? 0) / 100 } : { maker: (a.closeMakerFeeP ?? 0) / 100, taker: (a.closeTakerFeeP ?? p.closeFeeP ?? 0) / 100 };
};
const num = (v: unknown, what: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`bad ${what}`);
  return n;
};

function receipt(s: VrState, what: string, orderId?: number) {
  const id = s.nextId++;
  s.log.push(what);
  return { route: "mock", txHash: hex(id, 64), orderId: orderId ?? null };
}

function needSession(s: VrState, session: string | null) {
  if (!s.trader || !session || session !== s.session) throw new Error("delegate not authorised");
  if (s.sessionExpiry <= now()) throw new Error("delegate expired");
}

/** Pull collateral from the wallet like USDC.transferFrom: allowance and balance must both cover it. */
function pull(s: VrState, c: number) {
  if (s.allowance + 1e-9 < c) throw new Error(`ERC20: insufficient allowance (${s.allowance} < ${c})`);
  if (s.balance + 1e-9 < c) throw new Error("ERC20: transfer amount exceeds balance");
  s.allowance = Math.max(0, +(s.allowance - c).toFixed(6));
  s.balance = +(s.balance - c).toFixed(6);
}

function checkSize(p: VPair, coll: number, lev: number) {
  const min = p.leverages?.minLeverage ?? 1, max = p.leverages?.maxLeverage ?? 1;
  if (lev < min || lev > max) throw new Error(`leverage must be ${min}–${max}`);
  if (!(coll > 0)) throw new Error("collateral must be positive");
  if (coll * lev + 1e-9 < (p.minLevPosUSDC ?? 0)) throw new Error(`BELOW_MIN_POS: position below ${p.minLevPosUSDC} USDC`);
}

function oi(s: VrState, pairIndex: number) {
  const p = fixtures[s.net].pairs.find((x) => x.index === pairIndex)!;
  return { L: p.coinOI?.long ?? 0, S: p.coinOI?.short ?? 0 };
}

function open(s: VrState, p: VPair, buy: boolean, coll: number, lev: number, price: number, tp?: number, sl?: number, type = "MARKET_OPEN") {
  const coins = (coll * lev) / price;
  const o = oi(s, p.index);
  const f = fee(p, "open");
  const openFee = coll * lev * openFeeRate({ isLong: buy, size: coins, oiLong: o.L, oiShort: o.S, maker: f.maker, taker: f.taker });
  const margin = +(coll - openFee).toFixed(6);
  const index = [0, 1, 2, 3, 4].find((i) => !s.positions.some((x) => x.pairIndex === p.index && x.index === i))!;
  const maxGainTp = buy ? price * (1 + 9 / lev) : Math.max(price * (1 - 9 / lev), price * 0.0001);
  const pos: Pos = { index, pairIndex: p.index, buy, collateral: margin, leverage: lev, openPrice: price, tp: tp && tp > 0 ? tp : maxGainTp, sl: sl && sl > 0 ? sl : 0 };
  if (buy ? pos.sl >= price || pos.tp <= price : (pos.sl > 0 && pos.sl <= price) || pos.tp >= price) throw new Error("WRONG_TP_SL");
  s.positions.push(pos);
  const orderId = s.nextId;
  s.history.push({ timestamp: now(), type, open: true, market: `${p.from}/${p.to}`, side: buy ? "long" : "short", positionSize: coll * lev, openPrice: price, closePrice: null, openFee, closeFee: null, borrowFee: null, funding: null, netPnl: null, orderId });
  return orderId;
}

const raw = (x: number, scale: number) => String(Math.round(x * scale));
const rawPos = (p: Pos): VRawPosition => ({ pairIndex: p.pairIndex, index: p.index, buy: p.buy, collateral: raw(p.collateral, 1e6), leverage: raw(p.leverage, 1e10), openPrice: raw(p.openPrice, 1e10), tp: raw(p.tp, 1e10), sl: raw(p.sl, 1e10), liquidationPrice: "0", rolloverFee: "0", unrealisedFundingFee: "0" });
const rawLim = (l: Lim): VRawLimit => ({ pairIndex: l.pairIndex, index: l.index, buy: l.buy, collateral: raw(l.collateral, 1e6), leverage: raw(l.leverage, 1e10), price: raw(l.price, 1e10) });

const methods: Record<string, (s: VrState, args: unknown[], session: string | null) => unknown> = {
  pairs: (s) => fixtures[s.net].pairs,
  price: (s, [i]) => oracle(s, num(i, "pair index")),
  startPractice(s, [ttl]) {
    if (s.net !== "testnet") throw new Error("Veranta mainnet is not available in this app yet");
    const k = s.nextId++;
    s.trader = hex(0xa11ce000 + k);
    s.session = hex(0x5e55000 + k);
    s.sessionExpiry = now() + num(ttl, "ttl");
    s.balance = 1000;
    s.allowance = 0;
    s.log.push("faucet 1000", "registerDelegate");
    return { trader: s.trader, session: s.session, sessionExpiry: s.sessionExpiry, funded: s.balance };
  },
  usdc: (s) => ({ balance: s.balance, allowance: s.allowance }),
  approveExact(s, [amount]) {
    if (!s.trader) throw new Error("no trader");
    s.allowance = num(amount, "amount");
    return receipt(s, `approve ${amount}`);
  },
  positions: (s) => ({ positions: s.positions.map(rawPos), limits: s.limits.map(rawLim) }),
  marketOpen(s, [sym, side, a], session) {
    needSession(s, session);
    const o = a as { collateral: string; leverage: string; takeProfit?: string; stopLoss?: string; slippagePercent: string };
    const p = pairOf(s, String(sym));
    const coll = num(o.collateral, "collateral"), lev = num(o.leverage, "leverage");
    checkSize(p, coll, lev);
    const buy = side === "long";
    const px = oracle(s, p.index) * (1 + (buy ? 1 : -1) * ((p.spreadP ?? 0) / 100));
    pull(s, coll);
    const id = open(s, p, buy, coll, lev, px, o.takeProfit ? Number(o.takeProfit) : undefined, o.stopLoss ? Number(o.stopLoss) : undefined);
    return receipt(s, `marketOpen ${sym} ${side} ${coll}×${lev}`, id);
  },
  limitOpen(s, [sym, side, a], session) {
    needSession(s, session);
    const o = a as { collateral: string; leverage: string; price: string; takeProfit?: string; stopLoss?: string };
    const p = pairOf(s, String(sym));
    const coll = num(o.collateral, "collateral"), lev = num(o.leverage, "leverage"), price = num(o.price, "price");
    checkSize(p, coll, lev);
    pull(s, coll);
    const index = [0, 1, 2, 3, 4].find((i) => !s.limits.some((x) => x.pairIndex === p.index && x.index === i))!;
    s.limits.push({ index, pairIndex: p.index, buy: side === "long", collateral: coll, leverage: lev, price, tp: Number(o.takeProfit ?? 0), sl: Number(o.stopLoss ?? 0) });
    return receipt(s, `limitOpen ${sym} ${side} ${coll}×${lev} @ ${price}`, s.nextId);
  },
  marketClose(s, [sym, idx, collToClose], session) {
    needSession(s, session);
    const p = pairOf(s, String(sym));
    const pos = s.positions.find((x) => x.pairIndex === p.index && x.index === num(idx, "trade index"));
    if (!pos) throw new Error("NO_TRADE");
    const c = Math.min(pos.collateral, num(collToClose, "collateral"));
    const rest = +(pos.collateral - c).toFixed(6);
    if (rest > 1e-6 && rest * pos.leverage < (p.minLevPosUSDC ?? 0)) throw new Error("BELOW_MIN_POS");
    const px = oracle(s, p.index) * (1 + (pos.buy ? -1 : 1) * ((p.spreadP ?? 0) / 100));
    const coins = (c * pos.leverage) / pos.openPrice;
    const gross = (pos.buy ? 1 : -1) * coins * (px - pos.openPrice);
    const f = fee(p, "close");
    const closeFee = coins * px * f.taker;
    const back = Math.max(0, c + gross - closeFee);
    s.balance = +(s.balance + back).toFixed(6);
    if (rest <= 1e-6) s.positions = s.positions.filter((x) => x !== pos);
    else pos.collateral = rest;
    const orderId = s.nextId;
    s.history.push({ timestamp: now(), type: "MARKET_CLOSE", open: false, market: `${p.from}/${p.to}`, side: pos.buy ? "long" : "short", positionSize: c * pos.leverage, openPrice: pos.openPrice, closePrice: px, openFee: null, closeFee, borrowFee: 0, funding: 0, netPnl: gross - closeFee, orderId });
    return receipt(s, `marketClose ${sym} #${idx} ${c}`, orderId);
  },
  cancelLimit(s, [sym, idx], session) {
    needSession(s, session);
    const p = pairOf(s, String(sym));
    const l = s.limits.find((x) => x.pairIndex === p.index && x.index === num(idx, "order index"));
    if (!l) throw new Error("NO_LIMIT");
    s.limits = s.limits.filter((x) => x !== l);
    s.balance = +(s.balance + l.collateral).toFixed(6);
    return receipt(s, `cancelLimit ${sym} #${idx}`);
  },
  updateTpSl(s, [sym, idx, a], session) {
    needSession(s, session);
    const p = pairOf(s, String(sym));
    const pos = s.positions.find((x) => x.pairIndex === p.index && x.index === num(idx, "trade index"));
    if (!pos) throw new Error("NO_TRADE");
    const o = a as { takeProfit?: string; stopLoss?: string };
    if (o.stopLoss !== undefined) pos.sl = Number(o.stopLoss);
    if (o.takeProfit !== undefined) pos.tp = Number(o.takeProfit) > 0 ? Number(o.takeProfit) : pos.buy ? pos.openPrice * (1 + 9 / pos.leverage) : pos.openPrice * 0.0001;
    return receipt(s, `updateTpSl ${sym} #${idx}`);
  },
  history: (s) => [...s.history].reverse(), // newest first, like the history API
  endPractice(s, _a, session) {
    if (!s.session || session !== s.session) throw new Error("no session");
    s.revoked.push(s.session);
    s.session = null;
    return receipt(s, "revokeDelegate");
  },
};

/** Routes under /vr: [net, sid, ...method]. */
export function verantaRoute(path: string[], body: unknown, method: string): unknown {
  const [net, sid, ...rest] = path as [Net, string, ...string[]];
  if (net !== "testnet" && net !== "mainnet") throw new Error("bad net");
  const s = state(net, sid);
  const m = rest.join("/");
  if (m === "mock/state" && method === "GET") return s;
  if (m === "mock/drift") {
    const b = body as { pairIndex: number; factor: number };
    s.drift[b.pairIndex] = b.factor;
    return { ok: true };
  }
  const f = methods[m];
  if (!f) return { ok: false, error: `no method ${m}` };
  const b = (body ?? {}) as { args?: unknown[]; session?: string | null };
  try {
    return { ok: true, result: f(s, b.args ?? [], b.session ?? null) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
