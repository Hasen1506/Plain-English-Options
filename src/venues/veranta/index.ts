// Veranta (formerly Avantis) as a PerpVenue. Testnet only for now: the app trades a
// practice account it creates in the tab (see config.ts for why the user's wallet is
// never asked to sign on Veranta's same-chain-id testnet fork). Orders are signed by a
// 30-day session key that can trade but never withdraw, and relayed gaslessly; USDC
// approvals are always for the exact collateral of the next trade.

import type { NetworkId } from "../../config.ts";
import type { PerpQuote, PerpTicker } from "../../lib/perp.ts";
import type { OrderOutcome } from "../../net/trader.ts";
import type { PerpVenue, VenueAccount, VenueTrigger } from "../types.ts";
import { sdkVerantaApi, type VerantaApi, type VPractice, type VReceipt } from "./api.ts";
import { VERANTA_NETWORKS, VERANTA_SLIPPAGE, VERANTA_STATUS } from "./config.ts";
import { historyFrom, limitsFrom, marketsFrom, positionsFrom, usdc6, verantaLiqPrice, type VPair, type VPosition, type VerantaMarket } from "./rules.ts";

export interface VerantaHost {
  net(): NetworkId;
  now(): number;
  /** e2e builds only: the mock API instead of the SDK */
  api?(net: NetworkId): VerantaApi | null;
  changed(): void;
  /** progress words while the practice account is set up */
  step?(s: string): void;
}

/** Markets whose prices the list and comparison load (the focused one is always loaded). */
export const VERANTA_PRICED = ["ETH-PERP", "BTC-PERP", "SOL-PERP", "BNB-PERP", "ARB-PERP", "DOGE-PERP", "AVAX-PERP", "OP-PERP", "LINK-PERP", "SUI-PERP"];

const outcome = (o: Partial<OrderOutcome> & Pick<OrderOutcome, "instrument" | "direction" | "amount" | "status">): OrderOutcome => ({ orderId: null, filled: 0, avgPrice: 0, fee: 0, fills: [], error: null, ...o });
const idOf = (r: VReceipt) => (r.orderId != null ? String(r.orderId) : (r.txHash ?? r.trackingId ?? r.requestId ?? null));

export function createVerantaVenue(host: VerantaHost) {
  let api: VerantaApi | null = null;
  let apiNet: NetworkId | null = null;
  let practice: VPractice | null = null;
  let pairs: VPair[] = [];
  let pairsAt = 0;
  let markets = new Map<string, VerantaMarket>();
  let byIndex = new Map<number, VerantaMarket>();
  const prices: Record<number, number> = {};
  let tk: Record<string, PerpTicker> = {};
  let focused = "ETH-PERP";
  let liveAt = 0;
  let positions: VPosition[] = [];
  let limits: ReturnType<typeof limitsFrom> = [];
  let wallet = { balance: 0, allowance: 0 };

  const N = () => VERANTA_NETWORKS[host.net()];
  function A(): VerantaApi {
    if (!api || apiNet !== host.net()) {
      api = host.api?.(host.net()) ?? sdkVerantaApi(host.net());
      apiNet = host.net();
      practice = null;
      pairs = [];
      pairsAt = 0;
      markets = new Map();
      byIndex = new Map();
      tk = {};
      positions = [];
      limits = [];
    }
    return api;
  }
  const usable = () => VERANTA_STATUS[host.net()].usable;
  const market = (name: string): VerantaMarket => {
    const m = markets.get(name);
    if (!m) throw new Error(`${name} is not listed on Veranta`);
    return m;
  };
  const posOf = (name: string) => positions.find((p) => p.instrument === name) ?? null;

  // markets() and tickers() are asked for together: share one catalogue + price load
  let loading: Promise<VerantaMarket[]> | null = null;
  function loadMarkets(): Promise<VerantaMarket[]> {
    if (!usable()) return Promise.resolve([]);
    const net = host.net();
    loading ??= loadMarketsNow().finally(() => (loading = null));
    return loading.then((r) => (host.net() === net ? r : loadMarkets()));
  }
  async function loadMarketsNow(): Promise<VerantaMarket[]> {
    if (!pairs.length || host.now() - pairsAt > 60_000) {
      pairs = await A().pairs();
      pairsAt = host.now();
    }
    const want = new Set([focused, ...VERANTA_PRICED]);
    const idx = pairs.filter((p) => want.has(`${p.from}-PERP`) && p.to === "USD").map((p) => p.index);
    await Promise.all(idx.map((i) => A().price(i).then((px) => (prices[i] = px), () => null)));
    const r = marketsFrom(pairs, prices, host.now());
    markets = new Map(r.markets.map((m) => [m.name, m]));
    byIndex = new Map(r.markets.map((m) => [m.pairIndex, m]));
    tk = r.tickers;
    liveAt = host.now();
    return r.markets;
  }

  async function refreshAccounts() {
    if (!practice) return;
    const [u, p] = await Promise.all([A().usdc(), A().positions()]);
    wallet = u;
    const marks: Record<string, number> = {};
    for (const [k, v] of Object.entries(tk)) marks[k] = v.mark;
    positions = positionsFrom(p.positions, byIndex, marks);
    limits = limitsFrom(p.limits, byIndex);
    host.changed();
  }

  function account(): VenueAccount | null {
    if (!practice) return null;
    // wallet USDC + margin in positions (with their P&L) + margin escrowed by resting limits
    const locked = positions.reduce((s, p) => s + p.collateral + p.unrealizedPnl, 0) + limits.reduce((s, o) => s + o.collateral, 0);
    return { id: 0, value: wallet.balance + locked, initialMargin: wallet.balance, maintenanceMargin: wallet.balance, underLiquidation: false, positions, openOrders: limits };
  }

  /** Approve exactly what the next trade needs (USDC approve replaces the allowance, it never adds). */
  async function approveFor(collateral: string, onStep?: (s: string) => void) {
    const u = await A().usdc();
    if (u.balance + 1e-9 < Number(collateral)) throw new Error(`The practice wallet has ${u.balance.toFixed(2)} USDC; this trade needs ${collateral}`);
    if (u.allowance + 1e-9 >= Number(collateral) && u.allowance <= Number(collateral) + 1e-6) return;
    onStep?.(`Approving exactly ${collateral} USDC for this trade (never unlimited)…`);
    await A().approveExact(collateral);
  }

  async function waitFor(pred: () => boolean, tries = 15) {
    for (let i = 0; i < tries; i++) {
      await refreshAccounts();
      if (pred()) return true;
      await new Promise((ok) => setTimeout(ok, 2000));
    }
    return false;
  }

  function levFor(name: string, lev: number) {
    const m = markets.get(name);
    if (!m) return lev;
    return Math.min(m.maxLeverage, Math.max(m.minLeverage, Math.round(lev * 100) / 100));
  }

  const venue: PerpVenue & { sessionAddress(): string | null; user(): string | null } = {
    id: "veranta",
    name: "Veranta",
    caps: { triggers: true, postOnly: false, oneTap: true, dryRun: false, deposit: false, withdraw: false, crossMargin: false },
    slippage: VERANTA_SLIPPAGE,
    get status() {
      return VERANTA_STATUS[host.net()];
    },
    marginModes: ["isolated"],

    networkName: () => N().name,
    isMainnet: () => host.net() === "mainnet",
    isLive: () => liveAt > 0 && host.now() - liveAt < 60_000,

    markets: () => loadMarkets(),
    async tickers() {
      await loadMarkets();
      return { ...tk };
    },
    focus(name) {
      focused = name;
    },

    connected: () => !!practice,
    connectLabel: () => "Start a Veranta testnet practice account",
    async connect() {
      if (!usable()) throw new Error("Veranta mainnet is coming soon; switch to Testnet");
      if (!markets.size) await loadMarkets();
      practice = await A().startPractice((s) => host.step?.(s));
      // prices again (the faucet + key registration take a while): the order panel must not
      // show a stale or missing price right after the account appears
      await loadMarkets();
      await refreshAccounts();
    },
    async disconnect() {
      try {
        if (practice) await A().endPractice();
      } finally {
        practice = null;
        positions = [];
        limits = [];
        host.changed();
      }
    },
    accountsFor: () => {
      const a = account();
      return a ? [a] : [];
    },
    accountScope: () => (practice ? "your Veranta testnet practice account (each position has its own margin)" : null),
    selectedAccount: () => account(),
    selectAccount: () => {},
    newAccount: () => void venue.connect!(),
    deposit: () => {},
    withdraw: () => {},
    refreshAccounts,
    signer: () => (practice ? { oneTap: true, triggersNeedWallet: false } : null),
    marginMode: () => "isolated",
    setMarginMode: () => {},
    effectiveLeverage: (name, lev) => levFor(name, lev),
    liquidationPrice: (q: PerpQuote) => verantaLiqPrice({ entry: q.entry, collateral: Math.max(0, q.putIn - q.estFee), leverage: q.leverage, isLong: q.side === "buy" }),
    riskWords: () => "I understand this is a Veranta testnet practice trade: leverage on test USDC, liquidated when the loss reaches 85% of the margin, with fees, funding and borrowing costs charged under Veranta's rules.",
    collateralWords: () => "test USDC in a practice wallet on Veranta's testnet (a copy of Base)",

    async marginCheck(_acct, q) {
      const need = Number(usdc6(q.putIn));
      return { valid: need <= wallet.balance + 1e-9, postIM: wallet.balance - need, postMM: null };
    },

    async open(_acct, q, onStep) {
      const m = market(q.inst.name);
      if (q.orderType !== "market" && q.orderType !== "limit") throw new Error("Veranta supports market and limit orders");
      if (q.tif === "post_only") throw new Error("Veranta has no post-only orders");
      await refreshAccounts();
      const held = posOf(m.name);
      if (held) throw new Error(`You already hold a Veranta ${m.currency} position. Close or flip it first (Veranta keeps every trade separate).`);
      const collateral = usdc6(q.putIn);
      const lev = String(levFor(m.name, q.leverage));
      if (Number(collateral) * Number(lev) + 1e-9 < (m.minNotional ?? 0)) throw new Error(`Veranta's minimum position on ${m.symbol} is $${m.minNotional} (money put in × leverage)`);
      await approveFor(collateral, onStep);
      const side = q.dir;
      const tp = q.takeProfit ?? undefined, sl = q.stopLoss ?? undefined;
      onStep?.("Sending the order (signed by the one-tap key, gasless)…");
      if (q.orderType === "limit") {
        const r = await A().limitOpen(m.symbol, side, { collateral, leverage: lev, price: q.limitPrice, takeProfit: tp, stopLoss: sl });
        await waitFor(() => limits.some((o) => o.instrument === m.name));
        const o = limits.find((x) => x.instrument === m.name);
        const entry = outcome({ instrument: m.name, direction: q.side, amount: q.n, status: o ? "open" : "error", orderId: o?.orderId ?? idOf(r), error: o ? null : "the limit order did not show up" });
        return { entry, triggers: [], message: o ? `Limit order resting at ${q.limitPrice} · order ${o.orderId} · tx ${r.txHash ?? "—"}` : "Limit order sent but not visible yet" };
      }
      const r = await A().marketOpen(m.symbol, side, { collateral, leverage: lev, takeProfit: tp, stopLoss: sl, slippagePercent: String(VERANTA_SLIPPAGE * 100) });
      await waitFor(() => !!posOf(m.name));
      const p = posOf(m.name);
      const entry = outcome({ instrument: m.name, direction: q.side, amount: q.n, status: p ? "filled" : "error", filled: p ? Math.abs(p.amount) : 0, avgPrice: p?.averagePrice ?? 0, fee: p ? Math.max(0, Number(collateral) - p.collateral) : 0, orderId: idOf(r), error: p ? null : "the position did not show up" });
      const triggers = [tp ? "take-profit" : null, sl ? "stop-loss" : null].filter(Boolean).map((t) => outcome({ instrument: m.name, direction: q.side === "buy" ? "sell" : "buy", amount: Math.abs(p?.amount ?? q.n), status: "open", orderId: `${t}`, error: null }));
      return { entry, triggers, message: p ? `Filled ${Math.abs(p.amount).toFixed(6)} ${m.currency} at ${p.averagePrice.toFixed(2)} · order ${idOf(r)}${triggers.length ? ` · ${triggers.length} TP/SL set on the position` : ""}` : "Order sent; position not visible yet" };
    },

    async checkOrder() {
      return { ok: false, message: "Veranta has no exchange-side dry run" };
    },

    async close(_acct, name, _position, fraction) {
      const m = market(name);
      await refreshAccounts();
      const p = posOf(name);
      if (!p) throw new Error(`No Veranta ${m.currency} position`);
      const full = fraction >= 0.999;
      const coll = full ? usdc6(p.collateral) : usdc6(p.collateral * fraction);
      if (!full && (p.collateral - Number(coll)) * (p.leverage ?? 1) < (m.minNotional ?? 0)) throw new Error(`Closing part of it would leave less than Veranta's $${m.minNotional} minimum position. Close all of it instead.`);
      const r = await A().marketClose(m.symbol, p.tradeIndex, coll);
      const before = p.collateral;
      await waitFor(() => {
        const x = posOf(name);
        return full ? !x : !!x && x.collateral < before - Number(coll) * 0.5;
      });
      const left = posOf(name);
      const filled = full ? (left ? 0 : Math.abs(p.amount)) : Math.abs(p.amount) * fraction;
      return outcome({ instrument: name, direction: p.amount > 0 ? "sell" : "buy", amount: Math.abs(p.amount) * (full ? 1 : fraction), status: filled > 0 ? "filled" : "error", filled, avgPrice: tk[name]?.mark ?? 0, orderId: idOf(r), error: filled > 0 ? null : "the close did not show up" });
    },

    async flip(acct, name, position) {
      const p = posOf(name);
      const coll = p ? usdc6(p.collateral) : "0";
      const lev = p?.leverage ?? 1;
      const close = await venue.close(acct, name, position, 1);
      if (close.status !== "filled") return { close, open: null, message: `Close ${close.status}; not reopening the other way` };
      const m = market(name);
      const side = position > 0 ? "short" : "long";
      // the close returned the margin (less fees) to the wallet; reopen with what came back, capped at the old margin
      await refreshAccounts();
      const collateral = usdc6(Math.min(Number(coll), wallet.balance));
      await approveFor(collateral);
      const r = await A().marketOpen(m.symbol, side, { collateral, leverage: String(lev), slippagePercent: String(VERANTA_SLIPPAGE * 100) });
      await waitFor(() => !!posOf(name));
      const n = posOf(name);
      const open = outcome({ instrument: name, direction: side === "long" ? "buy" : "sell", amount: Math.abs(n?.amount ?? 0), status: n ? "filled" : "error", filled: Math.abs(n?.amount ?? 0), avgPrice: n?.averagePrice ?? 0, orderId: idOf(r), error: n ? null : "the new position did not show up" });
      return { close, open, message: `Flipped: closed ${close.filled.toFixed(6)}, opened ${open.filled.toFixed(6)} ${side}` };
    },

    async triggers(): Promise<VenueTrigger[]> {
      return positions.flatMap((p) => {
        const dir = p.amount > 0 ? ("sell" as const) : ("buy" as const);
        const amt = Math.abs(p.amount);
        const out: VenueTrigger[] = [];
        // Veranta stores a take-profit on every position (an "empty" one sits at the pair's max gain)
        if (p.tp) out.push({ orderId: `tp:${p.pairIndex}:${p.tradeIndex}`, instrument: p.instrument, direction: dir, amount: amt, triggerType: "takeProfit", triggerPrice: p.tp, limitPrice: p.tp, status: "open" });
        if (p.sl) out.push({ orderId: `sl:${p.pairIndex}:${p.tradeIndex}`, instrument: p.instrument, direction: dir, amount: amt, triggerType: "stopLoss", triggerPrice: p.sl, limitPrice: p.sl, status: "open" });
        return out;
      });
    },
    async cancelTrigger(_acct, id) {
      const [kind, pair, idx] = id.split(":");
      const m = byIndex.get(Number(pair));
      if (!m) throw new Error("unknown position");
      // 0 removes a stop-loss; Veranta resets a take-profit of 0 to the pair's maximum gain
      await A().updateTpSl(m.symbol, Number(idx), kind === "tp" ? { takeProfit: "0" } : { stopLoss: "0" });
      await refreshAccounts();
    },
    async openOrders() {
      return limits.map((o) => ({ orderId: o.orderId, instrument: o.instrument, direction: o.direction, amount: o.amount, limitPrice: o.limitPrice }));
    },
    async cancelOrder(_acct, id) {
      const o = limits.find((x) => x.orderId === id);
      if (!o) throw new Error("order not found");
      const m = byIndex.get(o.pairIndex)!;
      await A().cancelLimit(m.symbol, o.tradeIndex);
      await waitFor(() => !limits.some((x) => x.orderId === id));
    },
    async cancelAll() {
      await refreshAccounts();
      for (const o of [...limits]) await venue.cancelOrder!(account()!, o.orderId, o.instrument);
      for (const p of positions) if (p.sl) await A().updateTpSl(byIndex.get(p.pairIndex)!.symbol, p.tradeIndex, { stopLoss: "0" });
      await refreshAccounts();
    },

    async history() {
      if (!practice) return { trades: [], funding: [] };
      return historyFrom(await A().history());
    },
    isPerp: (n) => /^[A-Z0-9]+-PERP$/.test(n),
    sessionAddress: () => (practice ? practice.session : null),
    user: () => (practice ? practice.trader : null),
  };
  return venue;
}

export type VerantaVenue = ReturnType<typeof createVerantaVenue>;
