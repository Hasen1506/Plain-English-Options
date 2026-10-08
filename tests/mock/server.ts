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
}

function makeState(scenario: string): Map<number, Sub> {
  const subs = new Map<number, Sub>();
  const mk = (id: number, ru: number, cash: number) => subs.set(id, { id, ru, cash, positions: new Map(), orders: [], trades: [], history: [] });
  if (scenario === "noaccount") return subs;
  if (scenario !== "wrongru") mk(87139, 1, scenario === "poor" ? 5 : 2000);
  mk(87138, 0, 0);
  if (scenario === "openorder") {
    subs.get(87139)!.orders.push({ order_id: "resting-1", instrument_name: "ETH-20261127-2500-C", direction: "buy", amount: "1", filled_amount: "0", limit_price: "100", order_status: "open", time_in_force: "gtc" });
  }
  return subs;
}

const subValue = (s: Sub) => s.cash + [...s.positions.entries()].reduce((v, [n, p]) => v + p.amount * (tickers.get(n)?.mark ?? 0), 0);
function subJson(s: Sub) {
  return {
    subaccount_id: s.id,
    risk_universe_id: s.ru,
    manager_id: s.ru, // SM manager ids equal their universe ids (1–4) on Derive v3
    margin_type: "SM",
    subaccount_value: String(subValue(s)),
    collaterals_value: String(s.cash),
    initial_margin: String(s.cash),
    positions: [...s.positions.entries()]
      .filter(([, p]) => p.amount !== 0)
      .map(([n, p]) => ({ instrument_name: n, instrument_type: "option", amount: String(p.amount), average_price: String(p.avg), mark_price: String(tickers.get(n)?.mark ?? 0), unrealized_pnl: String(p.amount * ((tickers.get(n)?.mark ?? 0) - p.avg)), total_fees: "0" })),
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
function authorised(ctx: Conn, signer: string, subId: number): boolean {
  if (!ctx.wallet) return false;
  if (getAddress(signer) === ctx.wallet) return true;
  const k = ctx.st.keys.get(getAddress(signer));
  if (!k || k.expiry * 1000 <= RECORDED_AT) return false;
  if (!k.scopes.some((x) => ["trade:orderbook:option", "trade:orderbook:all", "trade:all", "admin"].includes(x))) return false;
  return !k.subaccountIds.length || k.subaccountIds.includes(subId);
}

function orderDigest(p: Record<string, unknown>, owner: string, netId: NetId = "testnet"): { d: string; it: { inst: Instrument } } {
  const it = instruments.get(String(p.instrument_name));
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
  if (fill > 0 && buy && fill * bookPx + fee > subValue(s)) throw { code: 11000, message: "Insufficient buying power" };
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
      return subJson(subOf(p.subaccount_id));
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
      const ok = s.ru === 1 && cost + fee <= subValue(s);
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
    if (!st.subs.size) st.subs.set(st.nextSub, { id: st.nextSub++, ru: 0, cash: 0, positions: new Map(), orders: [], trades: [], history: [] }); // fallback subaccount
    const id = st.nextSub++;
    st.subs.set(id, { id, ru, cash: amount, positions: new Map(), orders: [], trades: [], history: [] });
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
        else out = { id: m.id, result: publicAnswer(m.method, p) };
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
