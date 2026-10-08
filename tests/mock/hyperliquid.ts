// A deterministic Hyperliquid exchange for tests. Market data is the recorded
// mainnet/testnet frames (tests/fixtures/hyperliquid/<net>.json). /exchange
// verifies every signature with the app's own EIP-712 code paths re-derived
// from the wire (recoverL1 / recoverUser) and applies the exchange's published
// rules: agents (valid_until, named slots, replaced on re-approve), nonces
// (unique, within the window), price/size rules, the $10 minimum, IOC / GTC /
// ALO, reduce-only, normalTpsl children, cross/isolated leverage, cancels,
// withdraw3. A rejected signature answers exactly like the real exchange:
// "User or API Wallet 0x… does not exist." (that is what the dry run relies on).

import { readFileSync } from "node:fs";
import { getAddress } from "ethers";
import { recoverL1, recoverUser, userTyped, APPROVE_AGENT_TYPES, WITHDRAW_TYPES, type HlSig } from "../../src/venues/hyperliquid/signing.ts";
import { parseMeta, applyBook, type HlMarket } from "../../src/venues/hyperliquid/parse.ts";
import { meetsMinimum, validPrice, validSize } from "../../src/venues/hyperliquid/rules.ts";
import type { PerpTicker } from "../../src/lib/perp.ts";
import type { Packable } from "../../src/venues/hyperliquid/msgpack.ts";

export type Net = "mainnet" | "testnet";
type Frame = { req: { type: string; coin?: string }; res: unknown };
const fixtures: Record<Net, { recordedAt: number; frames: Frame[] }> = {
  mainnet: JSON.parse(readFileSync(new URL("../fixtures/hyperliquid/mainnet.json", import.meta.url), "utf8")),
  testnet: JSON.parse(readFileSync(new URL("../fixtures/hyperliquid/testnet.json", import.meta.url), "utf8")),
};
export const HL_RECORDED_AT = fixtures.mainnet.recordedAt;

interface Pos {
  szi: number;
  entry: number;
  cumFunding: number;
}
interface Order {
  oid: number;
  coin: string;
  side: "B" | "A";
  limitPx: string;
  sz: string;
  reduceOnly: boolean;
  tif: string | null;
  trigger: { triggerPx: string; tpsl: "tp" | "sl" } | null;
  timestamp: number;
}
export interface HlMockState {
  net: Net;
  /** userRole answers "missing" (no Hyperliquid mainnet account for anyone in this scenario) */
  noMainnet?: boolean;
  balance: Record<string, number>; // USDC per user
  agents: Map<string, { user: string; name: string; until: number }>; // agent → owner
  pos: Record<string, Record<string, Pos>>;
  lev: Record<string, Record<string, { type: "cross" | "isolated"; value: number }>>;
  orders: Record<string, Order[]>;
  fills: Record<string, unknown[]>;
  nonces: Map<string, Set<number>>;
  oid: number;
  now: () => number;
  log: { type: string; signer: string; ok: boolean; detail?: string }[];
  withdrawals: { user: string; amount: string; destination: string }[];
}

const marketsCache = new Map<Net, { markets: HlMarket[]; tk: Record<string, PerpTicker>; meta: unknown; books: Map<string, unknown> }>();
export function hlMarket(net: Net) {
  let m = marketsCache.get(net);
  if (!m) {
    const fx = fixtures[net];
    const meta = fx.frames.find((f) => f.req.type === "metaAndAssetCtxs")!.res;
    const p = parseMeta(meta);
    const books = new Map<string, unknown>();
    for (const f of fx.frames) if (f.req.type === "l2Book") books.set(f.req.coin!, f.res);
    m = { markets: p.markets, tk: p.tickers, meta, books };
    marketsCache.set(net, m);
  }
  return m;
}

export function newHlState(net: Net, now: () => number = () => HL_RECORDED_AT + 60_000): HlMockState {
  return { net, balance: {}, agents: new Map(), pos: {}, lev: {}, orders: {}, fills: {}, nonces: new Map(), oid: 1000, now, log: [], withdrawals: [] };
}

/** Synthetic one-level book around the mark for coins without a recorded l2Book. */
function bookFor(st: HlMockState, coin: string) {
  const m = hlMarket(st.net);
  const rec = m.books.get(coin);
  if (rec) return rec;
  const name = `${coin.toUpperCase()}-PERP`;
  const t = m.tk[name];
  const mark = t?.mark ?? 1;
  const mk = m.markets.find((x) => x.name === name)!;
  const tick = Number(mk.tickSize);
  const bid = Math.floor((mark * 0.9998) / tick) * tick, ask = Math.ceil((mark * 1.0002) / tick) * tick;
  return { coin, time: HL_RECORDED_AT, levels: [[{ px: String(+bid.toFixed(8)), sz: "1000000", n: 5 }], [{ px: String(+ask.toFixed(8)), sz: "1000000", n: 5 }]] };
}
function touch(st: HlMockState, coin: string) {
  const name = `${coin.toUpperCase()}-PERP`;
  const t = applyBook(hlMarket(st.net).tk[name]!, bookFor(st, coin));
  return t;
}
const marketByAsset = (st: HlMockState, a: number) => hlMarket(st.net).markets.find((m) => m.asset.index === a) ?? null;

function account(st: HlMockState, user: string) {
  const ps = st.pos[user] ?? {};
  const m = hlMarket(st.net);
  let upnl = 0, used = 0, mm = 0;
  const assetPositions = Object.entries(ps)
    .filter(([, p]) => p.szi !== 0)
    .map(([coin, p]) => {
      const mk = m.markets.find((x) => x.asset.coin === coin)!;
      const mark = m.tk[mk.name]!.mark;
      const u = p.szi * (mark - p.entry);
      const lv = st.lev[user]?.[coin] ?? { type: "cross" as const, value: Math.min(20, mk.maxLeverage) };
      const ntl = Math.abs(p.szi) * mark;
      upnl += u;
      used += ntl / lv.value;
      mm += ntl * mk.mmReq;
      return { coin, szi: p.szi, lv, entry: p.entry, mark, u, ntl, mk, cum: p.cumFunding };
    });
  const value = (st.balance[user] ?? 0) + upnl;
  const headroom = value - mm;
  return {
    marginSummary: { accountValue: String(value), totalNtlPos: "0", totalRawUsd: String(st.balance[user] ?? 0), totalMarginUsed: String(used) },
    crossMarginSummary: { accountValue: String(value), totalNtlPos: "0", totalRawUsd: "0", totalMarginUsed: String(used) },
    crossMaintenanceMarginUsed: String(mm),
    withdrawable: String(Math.max(0, value - used)),
    assetPositions: assetPositions.map((x) => {
      const slope = x.szi - x.mk.mmReq * Math.abs(x.szi);
      const liq = x.mark - headroom / slope;
      return {
        type: "oneWay",
        position: { coin: x.coin, szi: String(x.szi), leverage: x.lv, entryPx: String(x.entry), positionValue: String(x.ntl), unrealizedPnl: String(x.u), returnOnEquity: "0", liquidationPx: liq > 0 ? String(liq) : null, marginUsed: String(x.ntl / x.lv.value), maxLeverage: x.mk.maxLeverage, cumFunding: { allTime: String(x.cum), sinceOpen: String(x.cum), sinceChange: "0" } },
      };
    }),
    time: st.now(),
  };
}

function frontendOrders(st: HlMockState, user: string) {
  return (st.orders[user] ?? []).map((o) => ({
    coin: o.coin,
    side: o.side,
    limitPx: o.limitPx,
    sz: o.sz,
    oid: o.oid,
    timestamp: o.timestamp,
    triggerCondition: o.trigger ? `Price ${o.trigger.tpsl === "tp" ? "above" : "below"} ${o.trigger.triggerPx}` : "N/A",
    isTrigger: !!o.trigger,
    triggerPx: o.trigger?.triggerPx ?? "0.0",
    children: [],
    isPositionTpsl: false,
    reduceOnly: o.reduceOnly,
    orderType: o.trigger ? (o.trigger.tpsl === "tp" ? "Take Profit Market" : "Stop Market") : "Limit",
    origSz: o.sz,
    tif: o.tif,
    cloid: null,
  }));
}

export function hlInfo(st: HlMockState, body: Record<string, unknown>): unknown {
  const m = hlMarket(st.net);
  const user = typeof body.user === "string" ? getAddress(body.user) : "";
  switch (body.type) {
    case "metaAndAssetCtxs":
      return m.meta;
    case "l2Book":
      return bookFor(st, String(body.coin));
    case "clearinghouseState":
      return account(st, user);
    case "frontendOpenOrders":
    case "openOrders":
      return frontendOrders(st, user);
    case "userFills":
      return [...(st.fills[user] ?? [])].reverse();
    case "userFunding":
      return [];
    case "userRole":
      // mainnet presence decides whether testnet may open an account (sid "hlnomain…" = none)
      return { role: st.noMainnet ? "missing" : "user" };
    case "userFees":
      return { userCrossRate: "0.00045", userAddRate: "0.00015", activeReferralDiscount: "0.0" };
  }
  return null;
}

const err = (response: string) => ({ status: "err", response });
const statuses = (type: string, s: unknown[]) => ({ status: "ok", response: { type, data: { statuses: s } } });

function useNonce(st: HlMockState, signer: string, nonce: number): string | null {
  const now = st.now();
  if (!(nonce > now - 2 * 86_400_000 && nonce < now + 86_400_000)) return "Nonce too far from the block time";
  const s = st.nonces.get(signer) ?? new Set<number>();
  if (s.has(nonce)) return "Nonce already used";
  s.add(nonce);
  st.nonces.set(signer, s);
  return null;
}

function fill(st: HlMockState, user: string, coin: string, isBuy: boolean, sz: number, px: number, oid: number, crossed: boolean) {
  const ps = (st.pos[user] ??= {});
  const p = (ps[coin] ??= { szi: 0, entry: 0, cumFunding: 0 });
  const d = isBuy ? sz : -sz;
  let closed = 0;
  if (p.szi !== 0 && Math.sign(p.szi) !== Math.sign(d)) {
    const c = Math.min(Math.abs(p.szi), sz);
    closed = c * (px - p.entry) * Math.sign(p.szi);
  }
  const ns = +(p.szi + d).toFixed(10);
  if (p.szi === 0 || Math.sign(p.szi) === Math.sign(d)) p.entry = (Math.abs(p.szi) * p.entry + sz * px) / Math.abs(ns);
  else if (ns !== 0 && Math.sign(ns) !== Math.sign(p.szi)) p.entry = px;
  p.szi = ns;
  if (ns === 0) p.entry = 0;
  const fee = sz * px * (crossed ? 0.00045 : 0.00015);
  st.balance[user] = (st.balance[user] ?? 0) + closed - fee;
  (st.fills[user] ??= []).push({ coin, px: String(px), sz: String(sz), side: isBuy ? "B" : "A", time: st.now(), startPosition: "0", dir: "", closedPnl: String(closed), hash: "0x0", oid, crossed, fee: String(fee), tid: st.oid * 7, feeToken: "USDC" });
}

function placeOrders(st: HlMockState, user: string, action: { orders: { a: number; b: boolean; p: string; s: string; r: boolean; t: Record<string, { tif?: string; triggerPx?: string; tpsl?: "tp" | "sl"; isMarket?: boolean }> }[]; grouping: string }) {
  const out: unknown[] = [];
  let parentFilled = true;
  action.orders.forEach((o, i) => {
    const mk = marketByAsset(st, o.a);
    if (!mk) return out.push({ error: "Invalid asset." });
    const coin = mk.asset.coin;
    if (!validPrice(o.p, mk.asset.szDecimals)) return out.push({ error: "Order has invalid price." });
    if (!validSize(o.s, mk.asset.szDecimals)) return out.push({ error: "Order has invalid size." });
    const sz = Number(o.s), px = Number(o.p);
    const isTrig = "trigger" in o.t;
    if (!o.r && !isTrig && !meetsMinimum(o.s, o.p)) return out.push({ error: "Order must have minimum value of $10." });
    const pos = st.pos[user]?.[coin]?.szi ?? 0;
    if (o.r && !isTrig && (pos === 0 || Math.sign(pos) === (o.b ? 1 : -1))) return out.push({ error: "Reduce only order would increase position." });
    const oid = ++st.oid;
    if (isTrig) {
      if (action.grouping === "normalTpsl" && i > 0 && !parentFilled) return out.push("waitingForFill");
      const t = o.t.trigger!;
      (st.orders[user] ??= []).push({ oid, coin, side: o.b ? "B" : "A", limitPx: o.p, sz: o.s, reduceOnly: true, tif: null, trigger: { triggerPx: t.triggerPx!, tpsl: t.tpsl! }, timestamp: st.now() });
      return out.push({ resting: { oid } });
    }
    const tif = o.t.limit!.tif!;
    const tk = touch(st, coin);
    const crosses = o.b ? px >= tk.ask : px <= tk.bid;
    // margin: the opening part of the order must fit in free collateral at the coin's leverage
    if (!o.r) {
      const a = account(st, user);
      const lv = st.lev[user]?.[coin]?.value ?? Math.min(20, mk.maxLeverage);
      if ((sz * px) / lv > Number(a.withdrawable) + 1e-9) {
        if (i === 0) parentFilled = false;
        return out.push({ error: "Insufficient margin to place order. asset=" + o.a });
      }
    }
    if (tif === "Alo" && crosses) {
      if (i === 0) parentFilled = false;
      return out.push({ error: "Post only order would have immediately matched, bbo was " + tk.bid + "@" + tk.ask + ". asset=" + o.a });
    }
    if (crosses) {
      const fpx = o.b ? tk.ask : tk.bid;
      const fsz = o.r ? Math.min(sz, Math.abs(pos)) : sz;
      fill(st, user, coin, o.b, fsz, fpx, oid, true);
      return out.push({ filled: { totalSz: String(fsz), avgPx: String(fpx), oid } });
    }
    if (tif === "Ioc") {
      if (i === 0) parentFilled = false;
      return out.push({ error: "Order could not immediately match against any resting orders. asset=" + o.a });
    }
    if (i === 0) parentFilled = false;
    (st.orders[user] ??= []).push({ oid, coin, side: o.b ? "B" : "A", limitPx: o.p, sz: o.s, reduceOnly: o.r, tif, trigger: null, timestamp: st.now() });
    return out.push({ resting: { oid } });
  });
  return statuses("order", out);
}

export function hlExchange(st: HlMockState, body: { action: Record<string, unknown>; nonce: number; signature: HlSig; vaultAddress?: string | null; expiresAfter?: number }): unknown {
  const a = body.action;
  const mainnet = st.net === "mainnet";
  // ---- user-signed ----
  if (a.type === "approveAgent" || a.type === "withdraw3") {
    if (a.hyperliquidChain !== (mainnet ? "Mainnet" : "Testnet")) return err("Invalid hyperliquidChain");
    const t = a.type === "approveAgent" ? userTyped("HyperliquidTransaction:ApproveAgent", APPROVE_AGENT_TYPES, a) : userTyped("HyperliquidTransaction:Withdraw", WITHDRAW_TYPES, a);
    let user: string;
    try {
      user = getAddress(recoverUser(t, body.signature));
    } catch {
      return err("Invalid signature");
    }
    if (!(user in st.balance)) {
      st.log.push({ type: String(a.type), signer: user, ok: false });
      return err(`User or API Wallet ${user.toLowerCase()} does not exist.`);
    }
    const n = useNonce(st, user, body.nonce);
    if (n) return err(n);
    if (a.type === "approveAgent") {
      const name = String(a.agentName ?? "");
      const until = /valid_until (\d+)/.exec(name)?.[1];
      const base = name.replace(/ valid_until \d+$/, "");
      if (base.length > 16) return err("Agent name too long");
      if (until && Number(until) > st.now() + 180 * 86_400_000) return err("valid_until too far");
      for (const [k, v] of st.agents) if (v.user === user && v.name === base) st.agents.delete(k); // same slot: deregister the old one
      st.agents.set(getAddress(String(a.agentAddress)), { user, name: base, until: until ? Number(until) : Infinity });
      st.log.push({ type: "approveAgent", signer: user, ok: true, detail: String(a.agentAddress) });
      return { status: "ok", response: { type: "default" } };
    }
    if (body.nonce !== a.time) return err("nonce must equal time");
    const amt = Number(a.amount);
    const acct = account(st, user);
    if (!(amt > 1) || amt > Number(acct.withdrawable)) return err("Insufficient balance for withdrawal");
    st.balance[user] = (st.balance[user] ?? 0) - amt;
    st.withdrawals.push({ user, amount: String(a.amount), destination: String(a.destination) });
    st.log.push({ type: "withdraw3", signer: user, ok: true });
    return { status: "ok", response: { type: "default" } };
  }
  // ---- L1 actions: signed by the agent (or the user's own key) ----
  let signer: string;
  try {
    signer = getAddress(recoverL1(a as Packable, body.signature, body.nonce, mainnet, body.vaultAddress ?? null, body.expiresAfter ?? null));
  } catch {
    return err("Invalid signature");
  }
  const ag = st.agents.get(signer);
  const user = ag && ag.until > st.now() ? ag.user : signer in st.balance ? signer : null;
  if (!user) {
    st.log.push({ type: String(a.type), signer, ok: false });
    return err(`User or API Wallet ${signer.toLowerCase()} does not exist.`);
  }
  if (body.expiresAfter && body.expiresAfter < st.now()) return err("Action expired");
  const n = useNonce(st, signer, body.nonce);
  if (n) return err(n);
  st.log.push({ type: String(a.type), signer, ok: true });
  if (a.type === "updateLeverage") {
    const mk = marketByAsset(st, Number(a.asset));
    if (!mk) return err("Invalid asset");
    const lv = Number(a.leverage);
    if (!Number.isInteger(lv) || lv < 1 || lv > mk.maxLeverage) return err("Invalid leverage value");
    if (a.isCross && mk.asset.onlyIsolated) return err("Cross margin is not allowed for this asset");
    (st.lev[user] ??= {})[mk.asset.coin] = { type: a.isCross ? "cross" : "isolated", value: lv };
    return { status: "ok", response: { type: "default" } };
  }
  if (a.type === "order") return placeOrders(st, user, a as never);
  if (a.type === "cancel") {
    const out = (a.cancels as { a: number; o: number }[]).map((c) => {
      const list = st.orders[user] ?? [];
      const i = list.findIndex((o) => o.oid === c.o);
      if (i < 0) return { error: "Order was never placed, already canceled, or filled. asset=" + c.a };
      list.splice(i, 1);
      return "success";
    });
    return statuses("cancel", out);
  }
  return err("Unknown action");
}

/** Mock-only: credit a deposit (what the Arbitrum CCTP route would do a few minutes later). */
export function hlCredit(st: HlMockState, user: string, usdc: number) {
  const u = getAddress(user);
  st.balance[u] = (st.balance[u] ?? 0) + usdc;
}

/** A fetch() that answers from the mock (unit tests). */
export function hlFetch(st: HlMockState) {
  return async (url: string, init: { method: string; body: string }) => {
    const body = JSON.parse(init.body);
    const res = url.endsWith("/info") ? hlInfo(st, body) : url.endsWith("/exchange") ? hlExchange(st, body) : null;
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(res)) };
  };
}
