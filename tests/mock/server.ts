// Deterministic mock of the Derive v3 WebSocket API for e2e tests.
// Public methods replay frames recorded from testnet (tests/fixtures).
// Private methods run a tiny exchange: login and order signatures are verified
// with the same EIP-712 code the app uses, then orders fill against the
// recorded book. Behaviour is chosen per connection with ?scenario=…:
//   default   · 2,000 USDC in RU1 subaccount 87139, plus an RU0 subaccount
//   poor      · only 5 USDC in 87139
//   leg2fail  · every fill-or-kill SELL is killed (tests the unwind)
//   wrongru   · the wallet only has the RU0 subaccount
//   openorder · 87139 starts with one resting order
//   noaccount · the wallet has no Derive account until a deposit arrives
//   perppos   · 87139 starts with an ETH-PERP long, a stop-loss trigger and an option
// Perps (tests/mock/perps.ts): recorded perp markets per network, market/IOC,
// GTC, post-only, reduce-only, trigger orders (30–90 day signatures, as live),
// a standard-manager margin model, get_margin, funding history.
// State is shared per ?sid=… so the mock wallet (Playwright side) can report
// on-chain deposits through the side channel method mock/deposit.
//
//   node --experimental-strip-types tests/mock/server.ts [port]

import { readFileSync } from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";
import { getAddress, recoverAddress, verifyMessage } from "ethers";
import { NETWORKS, SET_SESSION_KEY_MODULE, WITHDRAW_MODULE } from "../../src/config.ts";
import { digest, encodeTradeData } from "../../src/net/signing.ts";
import { encodeSessionKeyData } from "../../src/net/sessionKey.ts";
import { encodeWithdrawData, toUnits } from "../../src/net/onchain.ts";
import riskUniverses from "../fixtures/testnet-risk-universes.json" with { type: "json" };
import mainnetPublic from "../fixtures/mainnet-public.json" with { type: "json" };

const mainnetUniverses = (mainnetPublic as { frames: { method: string; result: unknown }[] }).frames.find((f) => f.method === "public/get_risk_universes")!.result;
type NetId = "testnet" | "mainnet";
import { parseInstruments, parseTickers, type Instrument, type Ticker } from "../../src/lib/ticker.ts";
import { PERPS, isPerp, perpPublic, perpReqs, type PerpPos } from "./perps.ts";
import { applyFill, liquidationPrice, perpFee } from "../../src/lib/perp.ts";
import { isAligned } from "../../src/lib/units.ts";

type Frame = { method: string; params: Record<string, unknown>; result: unknown };
const pub = JSON.parse(readFileSync(new URL("../fixtures/testnet-public.json", import.meta.url), "utf8")) as { recordedAt: number; frames: Frame[] };
const RECORDED_AT = pub.recordedAt;

const instruments = new Map<string, { raw: Record<string, unknown>; inst: Instrument }>();
const tickers = new Map<string, Ticker>();
const rawTickers = new Map<string, unknown>();
for (const f of pub.frames) {
  if (f.method === "public/get_all_instruments") {
    const raws = (f.result as { instruments: Record<string, unknown>[] }).instruments;
    const parsed = parseInstruments(f.result);
    raws.forEach((r) => {
      const i = parsed.find((p) => p.name === r.instrument_name);
      if (i) instruments.set(i.name, { raw: r, inst: i });
    });
  }
  if (f.method === "public/get_tickers") {
    const t = parseTickers(f.result);
    for (const [k, v] of Object.entries(t)) tickers.set(k, v);
    for (const [k, v] of Object.entries((f.result as { tickers: Record<string, unknown> }).tickers)) rawTickers.set(k, v);
  }
}

function publicAnswer(method: string, p: Record<string, unknown>): unknown {
  if (method === "public/get_time") return RECORDED_AT;
  const same = (f: Frame, keys: string[]) => keys.every((k) => String(f.params[k]) === String(p[k]));
  if (method === "public/get_all_currencies") return pub.frames.find((f) => f.method === method)!.result;
  if (method === "public/get_all_instruments") {
    const f = pub.frames.find((x) => x.method === method && same(x, ["currency"]));
    return f ? f.result : { instruments: [], pagination: { num_pages: 1, count: 0 } };
  }
  if (method === "public/get_tickers") {
    if (!p.expiry_date) throw { code: -32602, message: "Invalid params", data: "Expiry date is required for options" };
    const f = pub.frames.find((x) => x.method === method && same(x, ["currency", "expiry_date"]));
    return f ? f.result : { tickers: {} };
  }
  if (method === "public/get_ticker") {
    const f = pub.frames.find((x) => x.method === method && same(x, ["instrument_name"]));
    if (f) return f.result;
    const t = rawTickers.get(String(p.instrument_name));
    if (t) return t;
    throw { code: -32602, message: "Invalid params", data: "Instrument not found" };
  }
  if (method === "public/get_instrument") {
    const i = instruments.get(String(p.instrument_name));
    if (i) return i.raw;
    throw { code: -32602, message: "Invalid params", data: "Instrument not found" };
  }
  throw { code: -32601, message: "Method not found", data: method };
}

interface Pos {
  amount: number;
  avg: number;
}
interface Sub {
  id: number;
  ru: number;
  cash: number;
  positions: Map<string, Pos>;
  orders: Record<string, unknown>[];
  trades: Record<string, unknown>[];
  history: Record<string, unknown>[];
  perps: Map<string, PerpPos>;
  triggers: Record<string, unknown>[];
  perpTraded: Set<string>;
}

function makeState(scenario: string): Map<number, Sub> {
  const subs = new Map<number, Sub>();
  const mk = (id: number, ru: number, cash: number) => subs.set(id, newSub(id, ru, cash));
  if (scenario === "noaccount") return subs;
  if (scenario !== "wrongru") mk(87139, 1, scenario === "poor" ? 5 : 2000);
  mk(87138, 0, 0);
  if (scenario === "perppos") {
    const s = subs.get(87139)!;
    const m = PERPS.testnet.tk.get("ETH-PERP")!.mark;
    s.perps.set("ETH-PERP", { amount: 0.5, avg: Math.round(m * 0.98 * 100) / 100, funding: -0.42 });
    s.perpTraded.add("ETH-PERP");
    s.triggers.push({ order_id: "trig-1", instrument_name: "ETH-PERP", direction: "sell", amount: "0.5", limit_price: String(Math.round(m * 0.85)), trigger_type: "stoploss", trigger_price: String(Math.round(m * 0.88)), trigger_price_type: "mark", order_status: "untriggered", order_type: "market", time_in_force: "gtc" });
    s.positions.set("ETH-20261127-2500-C", { amount: 1, avg: 100 });
  }
  if (scenario === "openorder") {
    subs.get(87139)!.orders.push({ order_id: "resting-1", instrument_name: "ETH-20261127-2500-C", direction: "buy", amount: "1", filled_amount: "0", limit_price: "100", order_status: "open", time_in_force: "gtc" });
  }
  return subs;
}

function newSub(id: number, ru: number, cash: number): Sub {
  return { id, ru, cash, positions: new Map(), orders: [], trades: [], history: [], perps: new Map(), triggers: [], perpTraded: new Set() };
}
const optValue = (s: Sub) => [...s.positions.entries()].reduce((v, [n, p]) => v + p.amount * (tickers.get(n)?.mark ?? 0), 0);
const subValue = (s: Sub, net: NetId = "testnet") => s.cash + optValue(s) + perpReqs(net, s.perps).upnl;
/** Net margins: options are fully cash-paid in the mock, perps carry im/mm fractions of notional. */
function margins(s: Sub, net: NetId, perps = s.perps) {
  const r = perpReqs(net, perps);
  const base = s.cash + r.upnl;
  return { im: base - r.im, mm: base - r.mm };
}
function perpJson(s: Sub, net: NetId) {
  const mm = margins(s, net).mm;
  return [...s.perps.entries()]
    .filter(([, p]) => p.amount !== 0)
    .map(([n, p]) => {
      const t = PERPS[net].tk.get(n), i = PERPS[net].inst.get(n)?.inst;
      const mark = t?.mark ?? p.avg;
      const liq = i ? liquidationPrice({ size: p.amount, price: mark, headroom: mm, mmReq: i.mmReq }) : null;
      return { instrument_name: n, instrument_type: "perp", amount: String(p.amount), average_price: String(p.avg), mark_price: String(mark), unrealized_pnl: String(p.amount * (mark - p.avg)), total_fees: "0", liquidation_price: liq === null ? null : String(liq), cumulative_funding: String(p.funding), pending_funding: "-0.01", leverage: String((Math.abs(p.amount) * mark) / Math.max(1e-9, subValue(s, net))), realized_pnl: "0" };
    });
}
function subJson(s: Sub, net: NetId = "testnet") {
  const mg = margins(s, net);
  return {
    subaccount_id: s.id,
    risk_universe_id: s.ru,
    manager_id: s.ru, // SM manager ids equal their universe ids (1–4) on Derive v3
    margin_type: "SM",
    subaccount_value: String(subValue(s, net)),
    collaterals_value: String(s.cash),
    initial_margin: String(mg.im),
    maintenance_margin: String(mg.mm),
    is_under_liquidation: false,
    positions: [
      ...[...s.positions.entries()]
        .filter(([, p]) => p.amount !== 0)
        .map(([n, p]) => ({ instrument_name: n, instrument_type: "option", amount: String(p.amount), average_price: String(p.avg), mark_price: String(tickers.get(n)?.mark ?? 0), unrealized_pnl: String(p.amount * ((tickers.get(n)?.mark ?? 0) - p.avg)), total_fees: "0" })),
      ...perpJson(s, net),
    ],
    open_orders: s.orders,
    collaterals: [{ asset_name: "USDC", amount: String(s.cash) }],
  };
}

let orderSeq = 0;
let clock = 0; // strictly increasing timestamps so history sorts deterministically
const ts = () => RECORDED_AT + ++clock;

interface SessionKeyRec {
  expiry: number;
  scopes: string[];
  subaccountIds: number[];
  label: string;
}

/** Who may sign an order for `owner`: the owner, or an unexpired session key with an order scope on this subaccount. */
function authorised(ctx: Conn, signer: string, subId: number, product: "option" | "perp" = "option"): boolean {
  if (!ctx.wallet) return false;
  if (getAddress(signer) === ctx.wallet) return true;
  const k = ctx.st.keys.get(getAddress(signer));
  if (!k || k.expiry * 1000 <= RECORDED_AT) return false;
  if (!k.scopes.some((x) => [`trade:orderbook:${product}`, "trade:orderbook:all", "trade:all", "admin"].includes(x))) return false;
  return !k.subaccountIds.length || k.subaccountIds.includes(subId);
}

function orderDigest(p: Record<string, unknown>, owner: string, netId: NetId = "testnet"): { d: string; it: { inst: Instrument } } {
  const it = (instruments.get(String(p.instrument_name)) ?? PERPS[netId].inst.get(String(p.instrument_name))) as { inst: Instrument } | undefined;
  if (!it) throw { code: 11000, message: "Instrument not found" };
  const data = encodeTradeData({
    assetAddress: it.inst.assetAddress,
    subId: it.inst.subId,
    limitPrice: String(p.limit_price),
    amount: String(p.amount),
    maxFee: String(p.max_fee),
    recipientId: Number(p.subaccount_id),
    isBid: p.direction === "buy",
  });
  return { d: digest({ subaccountId: Number(p.subaccount_id), nonce: String(p.nonce), module: NETWORKS[netId].tradeModule, data, expiry: Number(p.signature_expiry_sec), owner, signer: String(p.signer) }, NETWORKS[netId]), it };
}

function placeOrder(s: Sub, p: Record<string, unknown>, ctx: Conn) {
  if (isPerp(String(p.instrument_name))) return placePerp(s, p, ctx);
  const owner = ctx.wallet!, scenario = ctx.scenario;
  const name = String(p.instrument_name);
  // the signature must cover exactly the order on the wire (what Derive checks)
  const { d, it } = orderDigest(p, owner, ctx.net);
  let rec = "";
  try {
    rec = recoverAddress(d, String(p.signature));
  } catch {
    /* bad signature bytes */
  }
  if (rec !== getAddress(String(p.signer)) || !authorised(ctx, rec, s.id)) throw { code: 14014, message: "Invalid signature" };
  ctx.st.orderSigners.push(rec);
  if (Number(p.signature_expiry_sec) * 1000 < RECORDED_AT) throw { code: 14015, message: "Signature expired" };
  const t = tickers.get(name)!;
  const amt = Number(p.amount), lim = Number(p.limit_price), buy = p.direction === "buy";
  const bookPx = buy ? t.ask : t.bid, size = buy ? t.askSize : t.bidSize;
  const crosses = bookPx > 0 && (buy ? lim >= bookPx : lim <= bookPx);
  let fill = crosses ? Math.min(amt, size) : 0;
  const tif = String(p.time_in_force);
  if (tif === "fok" && fill < amt) fill = 0;
  if (scenario === "leg2fail" && tif === "fok" && !buy) fill = 0;
  if (p.reduce_only) {
    const cur = s.positions.get(name)?.amount ?? 0;
    fill = Math.min(fill, buy ? Math.max(0, -cur) : Math.max(0, cur));
  }
  fill = Math.round(fill * 100) / 100;
  const fee = fill > 0 ? fill * Math.min(it.inst.takerFeeRate * t.index, it.inst.markFeeCap * bookPx) + it.inst.baseFee : 0;
  if (fill > 0 && buy && fill * bookPx + fee > subValue(s, ctx.net)) throw { code: 11000, message: "Insufficient buying power" };
  const id = `mock-${++orderSeq}`;
  const trades = [];
  if (fill > 0) {
    s.cash += (buy ? -1 : 1) * fill * bookPx - fee;
    const pos = s.positions.get(name) ?? { amount: 0, avg: 0 };
    const na = pos.amount + (buy ? fill : -fill);
    pos.avg = na !== 0 && Math.sign(na) === Math.sign(pos.amount || na) && Math.abs(na) > Math.abs(pos.amount) ? (pos.avg * Math.abs(pos.amount) + bookPx * fill) / Math.abs(na) : pos.avg || bookPx;
    pos.amount = Math.round(na * 100) / 100;
    s.positions.set(name, pos);
    const tr = { trade_id: `t-${orderSeq}`, order_id: id, instrument_name: name, direction: p.direction, trade_price: String(bookPx), trade_amount: String(fill), trade_fee: String(fee), timestamp: ts(), liquidity_role: "taker" };
    trades.push(tr);
    s.trades.unshift(tr);
  }
  const status = fill === amt ? "filled" : tif === "gtc" ? "open" : "cancelled";
  const order = { order_id: id, instrument_name: name, direction: p.direction, amount: String(amt), filled_amount: String(fill), average_price: String(fill ? bookPx : 0), limit_price: String(lim), order_status: status, time_in_force: tif, order_fee: String(fee), creation_timestamp: ts(), label: p.label ?? "" };
  if (status === "open") s.orders.push(order);
  s.history.unshift(order);
  return { order, trades };
}

const err = (code: number, message: string) => ({ code, message });

function placePerp(s: Sub, p: Record<string, unknown>, ctx: Conn) {
  const net = ctx.net, name = String(p.instrument_name);
  const rec0 = PERPS[net].inst.get(name);
  if (!rec0) throw err(11000, "Instrument not found");
  const it = rec0.inst, t = PERPS[net].tk.get(name)!;
  const { d } = orderDigest(p, ctx.wallet!, net);
  let rec = "";
  try {
    rec = recoverAddress(d, String(p.signature));
  } catch {
    /* bad signature bytes */
  }
  if (rec !== getAddress(String(p.signer)) || !authorised(ctx, rec, s.id, "perp")) throw err(14014, "Invalid signature");
  ctx.st.orderSigners.push(rec);
  const exp = Number(p.signature_expiry_sec) - Math.floor(RECORDED_AT / 1000);
  if (exp < 0) throw err(14015, "Signature expired");
  const amtS = String(p.amount), limS = String(p.limit_price);
  // live testnet filled a 0.05 reduce-only close under ETH-PERP's 0.1 minimum (2026-10-08): the minimum binds opening orders only
  if (!isAligned(amtS, it.amountStep) || (!p.reduce_only && Number(amtS) < Number(it.minAmount))) throw err(11013, `Invalid amount: step ${it.amountStep}, minimum ${it.minAmount}`);
  if (!isAligned(limS, it.tickSize)) throw err(11014, `Limit price must be a multiple of the tick ${it.tickSize}`);
  const tif = String(p.time_in_force), type = String(p.order_type ?? "limit");
  const id = `mock-${++orderSeq}`;
  const base = { order_id: id, subaccount_id: s.id, instrument_name: name, direction: p.direction, amount: amtS, limit_price: limS, order_type: type, time_in_force: tif, label: p.label ?? "", creation_timestamp: ts(), signature_expiry_sec: p.signature_expiry_sec, signer: p.signer };
  if (p.trigger_type) {
    // live rule (testnet, 2026-10-08): trigger signatures must expire 30–90 days out
    if (exp < 2_592_000 - 120 || exp > 7_776_000 + 120) throw err(11023, "Invalid signature expiry: Order signature expiry must be between 2592000 and 7776000 sec from now");
    const o = { ...base, filled_amount: "0", average_price: "0", order_status: "untriggered", trigger_type: p.trigger_type, trigger_price: p.trigger_price, trigger_price_type: p.trigger_price_type ?? "mark", reduce_only: !!p.reduce_only };
    s.triggers.push(o);
    s.history.unshift(o);
    return { order: o, trades: [] };
  }
  if (t.maxPrice !== null && Number(limS) > t.maxPrice + 1e-9) throw err(11015, `Limit price above the band (${t.maxPrice})`);
  if (t.minPrice !== null && Number(limS) < t.minPrice - 1e-9) throw err(11015, `Limit price below the band (${t.minPrice})`);
  const resting = type === "limit" && (tif === "gtc" || tif === "post_only");
  if (p.reduce_only && resting) throw err(11016, "Reduce-only is only supported for market, IOC and FOK orders");
  const amt = Number(amtS), lim = Number(limS), buy = p.direction === "buy";
  const book = buy ? t.ask : t.bid, size = buy ? t.askSize : t.bidSize;
  const crosses = book > 0 && (buy ? lim >= book : lim <= book);
  if (tif === "post_only" && crosses) throw err(11017, "Post-only order would cross the book");
  let fill = crosses ? Math.min(amt, size) : 0;
  if (tif === "fok" && fill < amt) fill = 0;
  const cur = s.perps.get(name) ?? { amount: 0, avg: 0, funding: 0 };
  if (p.reduce_only) fill = Math.min(fill, buy ? Math.max(0, -cur.amount) : Math.max(0, cur.amount));
  fill = Number(fill.toFixed(9));
  const fee = perpFee(it, fill, book, false);
  if (fill > 0) {
    const after = new Map(s.perps);
    const next = applyFill({ size: cur.amount, entry: cur.avg }, buy ? "buy" : "sell", fill, book);
    after.set(name, { amount: next.pos.size, avg: next.pos.entry, funding: cur.funding });
    const increases = Math.abs(next.pos.size) > Math.abs(cur.amount) + 1e-12;
    if (increases && margins({ ...s, cash: s.cash - fee + next.realized }, net, after).im < 0) throw err(11000, "Insufficient margin");
    s.perps = after;
    s.cash += next.realized - fee;
    s.perpTraded.add(name);
    const tr = { trade_id: `t-${orderSeq}`, order_id: id, subaccount_id: s.id, instrument_name: name, direction: p.direction, trade_price: String(book), trade_amount: String(fill), trade_fee: String(fee), realized_pnl: String(next.realized - fee), realized_pnl_excl_fees: String(next.realized), timestamp: ts(), liquidity_role: "taker" };
    s.trades.unshift(tr);
    const status = fill >= amt - 1e-12 ? "filled" : resting ? "open" : "cancelled";
    const order = { ...base, filled_amount: String(fill), average_price: String(book), order_status: status, order_fee: String(fee) };
    if (status === "open") s.orders.push(order);
    s.history.unshift(order);
    return { order, trades: [tr] };
  }
  const order = { ...base, filled_amount: "0", average_price: "0", order_status: resting ? "open" : "cancelled", order_fee: "0" };
  if (resting) s.orders.push(order);
  s.history.unshift(order);
  return { order, trades: [] };
}

function verifyAction(ctx: Conn, p: Record<string, unknown>, subaccountId: number, module: string, data: string): string {
  const d = digest({ subaccountId, nonce: String(p.nonce), module, data, expiry: Number(p.signature_expiry_sec), owner: ctx.wallet!, signer: String(p.signer) }, NETWORKS[ctx.net]);
  let rec = "";
  try {
    rec = recoverAddress(d, String(p.signature));
  } catch {
    /* bad bytes */
  }
  if (rec !== getAddress(String(p.signer))) throw { code: 14014, message: "Invalid signature" };
  const n = BigInt(String(p.nonce));
  if (n <= ctx.st.lastNonce) throw { code: 14024, message: "Nonce must increase" };
  ctx.st.lastNonce = n;
  return rec;
}

function privateAnswer(method: string, p: Record<string, unknown>, ctx: Conn): unknown {
  if (!ctx.wallet) throw { code: 14000, message: "Not logged in" };
  const subOf = (id: unknown) => {
    const s = ctx.subs.get(Number(id));
    if (!s) throw { code: 14001, message: "Subaccount not found" };
    return s;
  };
  switch (method) {
    case "private/get_subaccounts":
      return { wallet: ctx.wallet, subaccount_ids: [...ctx.subs.keys()].sort() };
    case "private/get_subaccount":
      return subJson(subOf(p.subaccount_id), ctx.net);
    case "private/get_margin": {
      const s = subOf(p.subaccount_id);
      const pre = margins(s, ctx.net);
      const after = new Map(s.perps);
      for (const c of (p.simulated_position_changes as { instrument_name: string; amount: string }[]) ?? []) {
        const cur = after.get(c.instrument_name) ?? { amount: 0, avg: PERPS[ctx.net].tk.get(c.instrument_name)?.mark ?? 0, funding: 0 };
        after.set(c.instrument_name, { ...cur, amount: cur.amount + Number(c.amount) });
      }
      const post = margins(s, ctx.net, after);
      return { subaccount_id: s.id, pre_initial_margin: String(pre.im), pre_maintenance_margin: String(pre.mm), post_initial_margin: String(post.im), post_maintenance_margin: String(post.mm), is_valid_trade: post.im >= 0 };
    }
    case "private/get_trigger_orders":
      return { subaccount_id: p.subaccount_id, orders: subOf(p.subaccount_id).triggers };
    case "private/cancel_trigger_order": {
      const s = subOf(p.subaccount_id);
      const i = s.triggers.findIndex((o) => o.order_id === p.order_id);
      if (i < 0) throw err(11006, "Order not found");
      const [o] = s.triggers.splice(i, 1);
      return { ...o, order_status: "cancelled" };
    }
    case "private/get_funding_history": {
      const s = subOf(p.subaccount_id);
      return { events: [...s.perpTraded].map((n, k) => ({ subaccount_id: s.id, instrument_name: n, funding: "-0.0123", pnl: "0", timestamp: RECORDED_AT - 3_600_000 * (k + 1), batch_status: "Settled", batch_uuid: "mock" })), pagination: { num_pages: 1, count: s.perpTraded.size } };
    }
    case "private/get_open_orders":
      return { subaccount_id: p.subaccount_id, orders: subOf(p.subaccount_id).orders };
    case "private/get_trade_history":
      return { subaccount_id: p.subaccount_id, trades: subOf(p.subaccount_id).trades };
    case "private/cancel": {
      const s = subOf(p.subaccount_id);
      const i = s.orders.findIndex((o) => o.order_id === p.order_id);
      if (i < 0) throw { code: 11006, message: "Order not found" };
      const [o] = s.orders.splice(i, 1);
      return { ...o, order_status: "cancelled" };
    }
    case "private/rfq_get_best_quote": {
      const s = subOf(p.subaccount_id);
      const legs = p.legs as { instrument_name: string; direction: string; amount: string }[];
      let cost = 0, fee = 0;
      for (const l of legs) {
        const t = tickers.get(l.instrument_name), it = instruments.get(l.instrument_name);
        if (!t || !it) throw { code: 11000, message: "Instrument not found" };
        const px = l.direction === "buy" ? t.ask : t.bid;
        cost += (l.direction === "buy" ? 1 : -1) * Number(l.amount) * px;
        fee += Number(l.amount) * Math.min(it.inst.takerFeeRate * t.index, it.inst.markFeeCap * px) + it.inst.baseFee;
      }
      const ok = s.ru === 1 && cost + fee <= subValue(s, ctx.net);
      return { is_valid: ok, invalid_reason: ok ? null : s.ru !== 1 ? "Wrong risk universe" : "Insufficient margin", estimated_fee: String(fee), estimated_total_cost: String(cost), best_quote: null };
    }
    case "private/order":
      return placeOrder(subOf(p.subaccount_id), p, ctx);
    case "private/order_debug": {
      subOf(p.subaccount_id);
      const { d } = orderDigest(p, ctx.wallet, ctx.net);
      let rec: string | null = null;
      try {
        rec = recoverAddress(d, String(p.signature));
      } catch {
        rec = null;
      }
      ctx.st.debugCalls++;
      return { typed_data_hash: d, domain_separator: NETWORKS[ctx.net].domainSeparator, action_typehash: "", expected_signer: String(p.signer).toLowerCase(), recovered_signer: rec, module: NETWORKS[ctx.net].tradeModule, owner: ctx.wallet, encoded_data: "", encoded_data_hashed: "", action_hash: "", input_data: {} };
    }
    case "private/cancel_all": {
      const s = subOf(p.subaccount_id);
      for (const o of s.orders) s.history.unshift({ ...o, order_status: "cancelled", creation_timestamp: ts() });
      s.orders = [];
      if (p.cancel_trigger_orders) s.triggers = [];
      return "ok";
    }
    case "private/get_order_history":
      return { orders: subOf(p.subaccount_id).history, pagination: { num_pages: 1, count: subOf(p.subaccount_id).history.length } };
    case "private/set_session_key": {
      if (getAddress(String(p.wallet)) !== ctx.wallet) throw { code: 14001, message: "Wrong wallet" };
      const data = encodeSessionKeyData({ sessionKey: String(p.public_session_key), expirySec: Number(p.expiry_sec), protocolScopes: p.protocol_scopes as string[], subaccountIds: (p.subaccount_ids as number[]) ?? [] });
      const rec = verifyAction(ctx, p, 0, SET_SESSION_KEY_MODULE, data);
      if (rec !== ctx.wallet) throw { code: 14014, message: "Only the owner may set this key" };
      if (Number(p.expiry_sec) * 1000 < RECORDED_AT + 300_000) throw { code: 14039, message: "Session key expiry must be at least 5 minutes in the future" };
      ctx.st.keys.set(getAddress(String(p.public_session_key)), { expiry: Number(p.expiry_sec), scopes: p.protocol_scopes as string[], subaccountIds: (p.subaccount_ids as number[]) ?? [], label: String(p.label ?? "") });
      ctx.st.keyCalls.push({ key: getAddress(String(p.public_session_key)), expiry: Number(p.expiry_sec) });
      return { public_session_key: p.public_session_key, expiry_sec: p.expiry_sec, protocol_scopes: p.protocol_scopes, subaccount_ids: p.subaccount_ids, label: p.label, offchain_scopes: p.offchain_scopes, ip_whitelist: [] };
    }
    case "private/session_keys":
      return { public_session_keys: [...ctx.st.keys.entries()].map(([k, v]) => ({ public_session_key: k, expiry_sec: v.expiry, protocol_scopes: v.scopes, subaccount_ids: v.subaccountIds, label: v.label, offchain_scopes: [], ip_whitelist: [], registered_sec: 0 })) };
    case "private/withdraw": {
      const s = subOf(p.subaccount_id);
      const units = toUnits(String(p.amount_in_underlying), 6);
      const data = encodeWithdrawData("0x57B03E14d409ADC7fAb6CFc44b5886CAD2D5f02b", String(p.max_fee_usd), String(p.recipient ?? ctx.wallet), units);
      const rec = verifyAction(ctx, p, s.id, WITHDRAW_MODULE, data);
      if (rec !== ctx.wallet) throw { code: 14014, message: "Withdrawals need the owner" };
      const amt = Number(p.amount_in_underlying);
      if (amt > s.cash) throw { code: 11000, message: "Insufficient balance" };
      s.cash -= amt;
      return { operation_id: 1000 + ++orderSeq, op_uuid: "mock-withdraw-" + orderSeq };
    }
    case "mock/state":
      return { orderSigners: ctx.st.orderSigners, keyCalls: ctx.st.keyCalls, debugCalls: ctx.st.debugCalls };
  }
  throw { code: -32601, message: "Method not found", data: method };
}

interface Shared {
  subs: Map<number, Sub>;
  keys: Map<string, SessionKeyRec>;
  keyCalls: { key: string; expiry: number }[];
  orderSigners: string[];
  debugCalls: number;
  lastNonce: bigint;
  pending: Record<string, unknown>[];
  nextSub: number;
}
interface Conn {
  wallet: string | null;
  net: NetId;
  scenario: string;
  subs: Map<number, Sub>;
  st: Shared;
}

const shared = new Map<string, Shared>();
function stateFor(sid: string, scenario: string): Shared {
  let st = shared.get(sid);
  if (!st) {
    st = { subs: makeState(scenario), keys: new Map(), keyCalls: [], orderSigners: [], debugCalls: 0, lastNonce: 0n, pending: [], nextSub: 90001 };
    shared.set(sid, st);
  }
  return st;
}

/** Side channel used by the mock wallet when it "mines" an ActionManager deposit. */
function mockDeposit(st: Shared, p: Record<string, unknown>) {
  const amount = Number(p.amount);
  if (p.subaccountId) {
    const s = st.subs.get(Number(p.subaccountId));
    if (!s) throw { code: 14001, message: "Subaccount not found" };
    s.cash += amount;
  } else {
    const mgr = Number(p.managerId);
    const ru = (riskUniverses as { risk_universe_id: number; managers: { manager_id: number }[] }[]).find((u) => u.managers.some((m) => m.manager_id === mgr))!.risk_universe_id;
    if (!st.subs.size) {
      st.subs.set(st.nextSub, newSub(st.nextSub, 0, 0)); // fallback subaccount
      st.nextSub++;
    }
    const id = st.nextSub++;
    st.subs.set(id, newSub(id, ru, amount));
  }
  st.pending.push({ action_type: p.subaccountId ? "deposit" : "deposit_to_new_subaccount", amount: String(amount), status: "confirmed", tx_hash: p.txHash ?? "0x", timestamp: ts() });
  return { ok: true };
}

export function startMock(port: number) {
  const wss = new WebSocketServer({ port });
  wss.on("connection", (ws: WebSocket, req) => {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const scenario = q.get("scenario") ?? "default";
    const sid = q.get("sid") ?? `anon-${Math.random()}`;
    const st = stateFor(sid, scenario);
    const ctx: Conn = { wallet: null, net: q.get("net") === "mainnet" ? "mainnet" : "testnet", scenario, subs: st.subs, st };
    // the parser must shrug off junk the real feed never sends
    ws.send("not json at all");
    ws.send(JSON.stringify({ method: "subscription", params: { channel: "x", data: {} } }));
    ws.send(JSON.stringify({ id: 999999, result: "unsolicited" }));
    ws.on("message", (buf) => {
      let m: { id: number; method: string; params?: Record<string, unknown> };
      try {
        m = JSON.parse(String(buf));
      } catch {
        return;
      }
      const p = m.params ?? {};
      let out: unknown;
      try {
        if (m.method === "public/login") {
          const rec = getAddress(verifyMessage(String(p.timestamp), String(p.signature)));
          const wallet = getAddress(String(p.wallet));
          const key = ctx.st.keys.get(rec);
          if (rec !== wallet && !(key && key.expiry * 1000 > RECORDED_AT)) throw { code: 14014, message: "Invalid signature" };
          if (!ctx.subs.size) throw { code: 14000, message: "Account not found: Requested account does not exist." };
          ctx.wallet = wallet;
          out = { id: m.id, result: [...ctx.subs.keys()] };
        } else if (m.method === "mock/deposit") {
          out = { id: m.id, result: mockDeposit(ctx.st, p) };
        } else if (m.method === "public/get_risk_universes") {
          out = { id: m.id, result: ctx.net === "mainnet" ? mainnetUniverses : riskUniverses };
        } else if (m.method === "public/get_pending_deposits") {
          out = { id: m.id, result: { wallet: p.wallet, pending_deposits: ctx.st.pending } };
        } else if (m.method.startsWith("private/") || m.method === "mock/state") out = { id: m.id, result: privateAnswer(m.method, p, ctx) };
        else {
          const pp = perpPublic(ctx.net, m.method, p);
          out = { id: m.id, result: pp.hit ? pp.result : publicAnswer(m.method, p) };
        }
      } catch (e) {
        const err = e as { code?: number; message?: string; data?: unknown };
        out = { id: m.id, error: { code: err.code ?? -32000, message: err.message ?? String(e), data: err.data } };
      }
      ws.send(JSON.stringify(out));
    });
  });
  return wss;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 8787);
  startMock(port);
  console.log(`mock derive ws on ws://127.0.0.1:${port} (recorded ${new Date(RECORDED_AT).toISOString()})`);
}
