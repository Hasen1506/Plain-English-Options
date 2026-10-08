// Hyperliquid as a PerpVenue. Browser-only: the info/exchange HTTP API is CORS
// open (checked 2026-10-08), orders are signed by a one-tap agent key that lives
// in this tab's memory, and the wallet signs only the agent approval, withdrawals
// and the Arbitrum deposit.

import { getAddress } from "ethers";
import type { NetworkId } from "../../config.ts";
import { closeAmount, type PerpTicker } from "../../lib/perp.ts";
import { friendlyWalletError, walletRequest, type Eip1193 } from "../../net/signer.ts";
import type { OrderOutcome } from "../../net/trader.ts";
import { escapeHtml as h } from "../../lib/format.ts";
import type { MarginMode, PerpVenue, VenueAccount, VenueTrigger } from "../types.ts";
import { HL_NETWORKS, HL_MIN_DEPOSIT, HL_SLIPPAGE, HL_WITHDRAW_FEE, type HlNetwork } from "./config.ts";
import { HlClient, agentUsable, approveNewAgent, revokeAgent, withdrawUsdc, type AgentSession, type Fetch } from "./client.ts";
import { applyBook, exchangeStatuses, hlName, parseClearinghouse, parseFills, parseMeta, parseOpenOrders, parseUserFees, parseUserFunding, restingOrders, triggerOrders, type HlAccountState, type HlMarket, type HlOrder } from "./parse.ts";
import { cancelAction, closeOrder, entryOrders, hlLeverage, iocNoFill, leverageAction, orderAction, outcome, type Grouping, type OrderWire } from "./orders.ts";
import { depositUsdc } from "./deposit.ts";
import { SigningKey, Wallet } from "ethers";
import { signL1 } from "./signing.ts";

/** Honest label: signing is verified against Hyperliquid's servers, but no real (testnet) order has been placed yet. */
export const HL_STATUS = {
  tag: "not live-tested",
  detail:
    "Order signing is checked against Hyperliquid's own servers, but this app has not yet placed a real Hyperliquid order, even on testnet (Hyperliquid's testnet only opens accounts for addresses that have deposited on mainnet). Treat trading here as unproven.",
  usable: true,
} as const;

export interface HlHost {
  net(): NetworkId;
  now(): number;
  eth(): Eip1193 | null;
  /** e2e builds only: a mock server instead of api.hyperliquid*.xyz */
  apiOverride?(): string | null;
  /** e2e builds only: the mock's base for a given network (the testnet deposit guard asks mainnet). */
  apiOverrideFor?(net: NetworkId): string | null;
  fetch?: Fetch;
  sheet: { open(html: string): void; close(): void };
  /** account / agent changed: re-render */
  changed(): void;
}

const isPerp = (n: string) => /^[A-Z0-9]+-PERP$/.test(n);

export function createHyperliquidVenue(host: HlHost) {
  let client: HlClient | null = null;
  let clientKey = "";
  let user: string | null = null;
  let agent: AgentSession | null = null;
  let mode: MarginMode = "cross";
  let state: HlAccountState | null = null;
  let orders: HlOrder[] = [];
  let markets = new Map<string, HlMarket>();
  let tk: Record<string, PerpTicker> = {};
  let focused = "ETH-PERP";
  let liveAt = 0;
  let fees: { taker: number; maker: number } | null = null;

  const N = (): HlNetwork => HL_NETWORKS[host.net()];
  function c(): HlClient {
    const api = host.apiOverride?.() ?? N().api;
    const key = `${host.net()}|${api}`;
    if (!client || key !== clientKey) {
      client = new HlClient({ api, mainnet: host.net() === "mainnet", now: host.now, fetch: host.fetch });
      clientKey = key;
      // a network switch invalidates everything that belongs to the other network
      agent = null;
      state = null;
      orders = [];
      markets = new Map();
      tk = {};
      fees = null;
    }
    return client;
  }
  const provider = (): Eip1193 => {
    const p = host.eth();
    if (!p) throw new Error("No wallet found. Open this page in MetaMask or Rabby");
    return p;
  };
  const market = (name: string): HlMarket => {
    const m = markets.get(name);
    if (!m) throw new Error(`${name} is not listed on Hyperliquid`);
    return m;
  };

  async function loadMarkets() {
    const raw = await c().info({ type: "metaAndAssetCtxs" });
    const r = parseMeta(raw, fees ?? undefined);
    markets = new Map(r.markets.map((m) => [m.name, m]));
    for (const [k, v] of Object.entries(r.tickers)) tk[k] = { ...v, ...(tk[k] && tk[k]!.askSize ? { bid: tk[k]!.bid, ask: tk[k]!.ask, bidSize: tk[k]!.bidSize, askSize: tk[k]!.askSize } : {}) };
    liveAt = host.now();
    return r;
  }
  async function book(name: string): Promise<PerpTicker> {
    const m = market(name);
    const base = tk[name];
    if (!base) throw new Error("no price for " + name);
    const b = applyBook(base, await c().info({ type: "l2Book", coin: m.asset.coin }));
    tk[name] = b;
    return b;
  }

  async function ensureAgent(onStep?: (s: string) => void): Promise<SigningKey> {
    if (!user) throw new Error("Connect your wallet first");
    if (agentUsable(agent, host.now())) return agent.key;
    onStep?.("Approve the one-tap key in your wallet (one signature; it can trade but never withdraw)…");
    agent = await approveNewAgent(c(), provider(), user, host.now());
    host.changed();
    return agent.key;
  }

  /** Leverage on Hyperliquid is a per-coin setting; set it when it differs from what this order needs. */
  async function ensureLeverage(m: HlMarket, lev: number, key: SigningKey) {
    const want = hlLeverage(lev, m.asset.maxLeverage);
    const isCross = mode === "cross" && !m.asset.onlyIsolated;
    const cur = state?.leverage[m.asset.coin];
    if (cur && cur.value === want && (cur.type === "cross") === isCross) return;
    const r = await c().l1(leverageAction(m.asset.index, isCross, want), key);
    exchangeStatuses(r); // throws with Hyperliquid's own words on rejection
    if (state) state.leverage[m.asset.coin] = { type: isCross ? "cross" : "isolated", value: want };
  }

  async function send(wires: OrderWire[], grouping: Grouping, key: SigningKey, m: HlMarket): Promise<OrderOutcome[]> {
    const r = await c().l1(orderAction(wires, grouping), key);
    const st = exchangeStatuses(r);
    return wires.map((w, i) => iocNoFill(outcome(m.asset, w, st[i])));
  }

  async function refreshAccounts() {
    if (!user) return;
    const marks: Record<string, number> = {};
    for (const [k, v] of Object.entries(tk)) marks[k] = v.mark;
    const [ch, oo, uf] = await Promise.all([
      c().info({ type: "clearinghouseState", user }),
      c().info({ type: "frontendOpenOrders", user }),
      fees ? Promise.resolve(null) : c().info({ type: "userFees", user }).catch(() => null),
    ]);
    state = parseClearinghouse(ch, marks);
    orders = parseOpenOrders(oo);
    if (state) state.account.openOrders = restingOrders(orders);
    const f = parseUserFees(uf);
    if (f) {
      fees = f;
      for (const m of markets.values()) {
        m.takerFeeRate = f.taker;
        m.makerFeeRate = f.maker;
      }
    }
    host.changed();
  }

  /**
   * Hyperliquid testnet only creates an account for an address that already exists on
   * Hyperliquid MAINNET (testnet faucet docs; hyperliquid-dex/node#138). A CCTP deposit
   * to any other address is minted on HyperEVM but never credited: the USDC is lost.
   * Seen live on 2026-10-08 (Arbitrum Sepolia tx 0x65c15cbd…7a7e). Returns why the
   * deposit must not go out, or null.
   */
  async function testnetDepositBlocker(addr: string): Promise<string | null> {
    const base = host.apiOverrideFor?.("mainnet") ?? HL_NETWORKS.mainnet.api;
    const f: Fetch = host.fetch ?? ((u, i) => globalThis.fetch(u, i));
    let role: unknown;
    try {
      role = ((await (await f(base + "/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "userRole", user: addr }) })).json()) as { role?: unknown })?.role;
    } catch {
      return "Could not check this address on Hyperliquid mainnet, so the testnet deposit was not sent.";
    }
    return role === "missing" || role == null
      ? "Hyperliquid testnet only opens accounts for addresses that already have a Hyperliquid mainnet account. This address has none, so a testnet deposit would be lost. Deposit was not sent."
      : null;
  }

  function depositSheet() {
    const n = N();
    const main = host.net() === "mainnet";
    host.sheet.open(
      `<h2>Deposit USDC to Hyperliquid ${h(n.name.toLowerCase())}</h2>` +
        `<p class="x-step">From your wallet's USDC on <b>${h(n.depositChainName)}</b> through Circle CCTP (the route Hyperliquid's docs recommend). You sign one authorization for the exact amount (no token approval) and send one transaction. Circle's forwarding fee (about 0.20 USDC) is taken from the amount; the rest arrives in your Hyperliquid perps balance within minutes. Minimum ${HL_MIN_DEPOSIT} USDC.</p>` +
        `<label class="x-field"><span>USDC</span><input id="hlDepAmt" inputmode="decimal" autocomplete="off" placeholder="${HL_MIN_DEPOSIT}"></label>` +
        (main ? `<div class="x-real" role="alert">Real money. Type <b>REAL MONEY</b> to enable.<input id="hlDepReal" autocomplete="off" aria-label="Type REAL MONEY"></div>` : "") +
        `<div class="x-sheet__btns"><button type="button" class="x-buy" id="hlDepGo" disabled>Deposit</button></div><p class="x-step" id="hlDepStep" role="status"></p>`,
    );
    const amt = document.getElementById("hlDepAmt") as HTMLInputElement, go = document.getElementById("hlDepGo") as HTMLButtonElement, out = document.getElementById("hlDepStep")!;
    const real = document.getElementById("hlDepReal") as HTMLInputElement | null;
    const sync = () => {
      const v = amt.value.trim();
      const ok = /^\d+(\.\d{1,6})?$/.test(v) && Number(v) >= HL_MIN_DEPOSIT && (!main || (real?.value.trim().toUpperCase() ?? "") === "REAL MONEY");
      go.disabled = !ok;
    };
    amt.oninput = sync;
    if (real) real.oninput = sync;
    go.onclick = async () => {
      go.disabled = true;
      try {
        if (!main) {
          out.textContent = "Checking that Hyperliquid testnet can open an account for this address…";
          const why = await testnetDepositBlocker(user!);
          if (why) throw new Error(why);
        }
        const r = await depositUsdc({ p: provider(), n, user: user!, amountUsd: amt.value.trim(), nowSec: Math.floor(host.now() / 1000), onStep: (s) => (out.textContent = s) });
        out.textContent = `Deposit sent · tx ${r.txHash}. About ${r.credited} USDC arrives on Hyperliquid in a few minutes.`;
        out.dataset.tx = r.txHash;
        void refreshAccounts();
      } catch (e) {
        go.disabled = false;
        out.textContent = "Deposit failed: " + friendlyWalletError(e).message;
      }
    };
  }

  function withdrawSheet() {
    const n = N();
    const main = host.net() === "mainnet";
    const max = state?.withdrawable ?? 0;
    host.sheet.open(
      `<h2>Withdraw from Hyperliquid ${h(n.name.toLowerCase())}</h2>` +
        `<p class="x-step">Signed by your wallet (the one-tap key cannot withdraw). Paid to your own address on ${h(n.depositChainName)} by Hyperliquid's validators in about 5 minutes; Hyperliquid charges $${HL_WITHDRAW_FEE}. Withdrawable now: <b>$${max.toFixed(2)}</b>.</p>` +
        `<label class="x-field"><span>USDC</span><input id="hlWdAmt" inputmode="decimal" autocomplete="off"></label>` +
        (main ? `<div class="x-real" role="alert">Real money. Type <b>REAL MONEY</b> to enable.<input id="hlWdReal" autocomplete="off" aria-label="Type REAL MONEY"></div>` : "") +
        `<div class="x-sheet__btns"><button type="button" class="x-buy" id="hlWdGo" disabled>Withdraw</button></div><p class="x-step" id="hlWdStep" role="status"></p>`,
    );
    const amt = document.getElementById("hlWdAmt") as HTMLInputElement, go = document.getElementById("hlWdGo") as HTMLButtonElement, out = document.getElementById("hlWdStep")!;
    const real = document.getElementById("hlWdReal") as HTMLInputElement | null;
    const sync = () => {
      const v = amt.value.trim();
      go.disabled = !(/^\d+(\.\d{1,6})?$/.test(v) && Number(v) > HL_WITHDRAW_FEE && Number(v) <= max + 1e-9 && (!main || (real?.value.trim().toUpperCase() ?? "") === "REAL MONEY"));
    };
    amt.oninput = sync;
    if (real) real.oninput = sync;
    go.onclick = async () => {
      go.disabled = true;
      out.textContent = "Sign the withdrawal in your wallet…";
      try {
        await withdrawUsdc(c(), provider(), user!, amt.value.trim(), host.now());
        out.textContent = `Withdrawal accepted. ${amt.value.trim()} USDC minus the $${HL_WITHDRAW_FEE} fee is paid to ${user} on ${n.depositChainName}.`;
        void refreshAccounts();
      } catch (e) {
        go.disabled = false;
        out.textContent = "Withdrawal failed: " + friendlyWalletError(e).message;
      }
    };
  }

  const venue: PerpVenue & { agentAddress(): string | null; user(): string | null } = {
    id: "hyperliquid",
    name: "Hyperliquid",
    caps: { triggers: true, postOnly: true, oneTap: true, dryRun: true, deposit: true, withdraw: true, crossMargin: true },
    slippage: HL_SLIPPAGE,
    status: HL_STATUS,
    marginModes: ["cross", "isolated"],

    networkName: () => N().name,
    isMainnet: () => host.net() === "mainnet",
    isLive: () => liveAt > 0 && host.now() - liveAt < 60_000,

    async markets() {
      return (await loadMarkets()).markets;
    },
    async tickers() {
      await loadMarkets();
      if (markets.has(focused)) await book(focused).catch(() => null);
      return { ...tk };
    },
    focus(name) {
      focused = name;
    },

    connected: () => !!user,
    async connect() {
      const p = provider();
      const acc = (await walletRequest(p, "eth_requestAccounts", [])) as string[];
      if (!acc?.[0]) throw new Error("The wallet shared no account");
      user = getAddress(acc[0]);
      c();
      await refreshAccounts();
    },
    async disconnect() {
      const a = agent, u = user;
      agent = null;
      try {
        if (a && u && agentUsable(a, host.now(), 0)) await revokeAgent(c(), provider(), u, host.now());
      } finally {
        user = null;
        state = null;
        orders = [];
        host.changed();
      }
    },
    accountsFor: () => (user && state ? [state.account] : []),
    accountScope: () => (user ? `your Hyperliquid account (${mode === "cross" ? "cross margin" : "isolated margin"})` : null),
    selectedAccount: () => (user && state ? state.account : null),
    selectAccount: () => {},
    newAccount: () => depositSheet(),
    deposit: () => depositSheet(),
    withdraw: () => withdrawSheet(),
    refreshAccounts,
    signer() {
      if (!user) return null;
      return { oneTap: agentUsable(agent, host.now()), triggersNeedWallet: false };
    },
    marginMode: () => mode,
    setMarginMode(m) {
      mode = m;
      host.changed();
    },
    effectiveLeverage: (name, lev) => {
      const m = markets.get(name);
      return m ? hlLeverage(lev, m.asset.maxLeverage) : Math.max(1, Math.floor(lev));
    },
    riskWords: () =>
      mode === "cross"
        ? "I understand perpetuals use leverage on my whole Hyperliquid account balance (cross margin), pay or receive funding every hour, and can be liquidated under Hyperliquid's rules."
        : "I understand this isolated-margin perpetual can lose all the margin I put in, pays or receives funding every hour, and can be liquidated under Hyperliquid's rules.",
    collateralWords: () => `USDC deposited on Hyperliquid (from ${N().depositChainName})`,

    async marginCheck(acct, q) {
      if (!state) return { valid: true, postIM: null, postMM: null };
      const lev = hlLeverage(q.leverage, (q.inst as HlMarket).asset?.maxLeverage ?? q.leverage);
      const need = q.reducesExisting ? 0 : (q.n * q.entry) / lev + q.estFee;
      const free = state.withdrawable;
      return { valid: need <= free + 1e-9, postIM: free - need, postMM: null };
    },

    async open(_acct, q, onStep) {
      const m = market(q.inst.name);
      const key = await ensureAgent(onStep);
      onStep?.("Setting leverage…");
      await ensureLeverage(m, q.leverage, key);
      const { wires, grouping } = entryOrders(m.asset, q);
      onStep?.("Sending the order…");
      const out = await send(wires, grouping, key, m);
      const entry = out[0]!;
      const triggers = out.slice(1);
      await refreshAccounts().catch(() => {});
      const what = entry.status === "filled" ? `Filled ${entry.filled} at ${entry.avgPrice}` : entry.status === "open" ? "Order resting on the book" : entry.status === "partial" ? `Partly filled ${entry.filled} of ${entry.amount}` : entry.error ?? entry.status;
      return { entry, triggers, message: `${what}${triggers.length ? ` · ${triggers.filter((t) => !t.error).length} of ${triggers.length} TP/SL placed` : ""}` };
    },

    async checkOrder(_acct, q) {
      // Dry run: sign the exact order with a throwaway key that has no account.
      // Hyperliquid recovers the signer and answers "User or API Wallet 0x… does
      // not exist" — matching our throwaway address proves the hashing and signing
      // are byte-exact. Nothing can trade: the signer has no account.
      const m = market(q.inst.name);
      const { wires, grouping } = entryOrders(m.asset, q);
      const burn = Wallet.createRandom();
      const action = orderAction(wires, grouping);
      const nonce = c().nonce();
      const signature = signL1(new SigningKey(burn.privateKey), action, nonce, host.net() === "mainnet");
      const api = host.apiOverride?.() ?? N().api;
      const r = (await (host.fetch ?? ((u, i) => globalThis.fetch(u, i)))(api + "/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, nonce, signature, vaultAddress: null }) }).then((x) => x.json())) as { status?: string; response?: unknown };
      const said = typeof r?.response === "string" ? r.response : JSON.stringify(r?.response ?? "");
      const rec = /0x[0-9a-fA-F]{40}/.exec(said)?.[0] ?? null;
      const ok = r?.status === "err" && rec !== null && rec.toLowerCase() === burn.address.toLowerCase();
      return {
        ok,
        message: ok
          ? `Hyperliquid recovered our signature exactly (${q.inst.name}, ${wires.length} order${wires.length > 1 ? "s" : ""}, ${N().name.toLowerCase()}). Signed by a throwaway key with no account, so nothing was traded.`
          : `Check failed: Hyperliquid answered "${said.slice(0, 160)}"`,
      };
    },

    async close(_acct, name, position, fraction, _label) {
      const m = market(name);
      const key = await ensureAgent();
      const t = await book(name);
      const size = closeAmount(position, fraction, m.amountStep);
      if (!(Number(size) > 0)) throw new Error("Nothing to close at this size");
      const w = closeOrder(m.asset, position, size, position < 0 ? t.ask : t.bid, HL_SLIPPAGE);
      const [o] = await send([w], "na", key, m);
      await refreshAccounts().catch(() => {});
      return o!;
    },

    async flip(acct, name, position) {
      const close = await venue.close(acct, name, position, 1);
      if (!(close.filled > 0) || close.filled + 1e-12 < Math.abs(position)) return { close, open: null, message: `Close ${close.status}; not reopening the other way` };
      const m = market(name);
      const key = await ensureAgent();
      const t = await book(name);
      const isBuy = position < 0;
      const touch = isBuy ? t.ask : t.bid;
      const q = { side: (isBuy ? "buy" : "sell") as "buy" | "sell", amount: String(Math.abs(position)), limitPrice: String(touch * (isBuy ? 1 + HL_SLIPPAGE : 1 - HL_SLIPPAGE)), tif: "ioc" as const, takeProfit: null, stopLoss: null };
      const { wires } = entryOrders(m.asset, q);
      const [open] = await send(wires, "na", key, m);
      await refreshAccounts().catch(() => {});
      return { close, open: open!, message: `Flipped: closed ${close.filled}, opened ${open!.filled} the other way` };
    },

    async triggers(): Promise<VenueTrigger[]> {
      if (!user) return [];
      orders = parseOpenOrders(await c().info({ type: "frontendOpenOrders", user }));
      return triggerOrders(orders);
    },
    async cancelTrigger(_acct, id) {
      const o = orders.find((x) => String(x.oid) === id);
      if (!o) throw new Error("order not found");
      const key = await ensureAgent();
      const m = market(hlName(o.coin));
      const st = exchangeStatuses(await c().l1(cancelAction([{ a: m.asset.index, o: o.oid }]), key));
      if (typeof st[0] === "object" && st[0] && "error" in (st[0] as object)) throw new Error(String((st[0] as { error: string }).error));
      await refreshAccounts().catch(() => {});
    },
    async cancelOrder(acct, id) {
      return venue.cancelTrigger(acct, id);
    },
    async openOrders() {
      return restingOrders(orders).map((o) => ({ orderId: o.orderId, instrument: o.instrument, direction: o.direction, amount: o.amount, limitPrice: o.limitPrice }));
    },
    async cancelAll() {
      if (!user) return;
      orders = parseOpenOrders(await c().info({ type: "frontendOpenOrders", user }));
      if (!orders.length) return;
      const key = await ensureAgent();
      const cancels = orders.flatMap((o) => {
        const m = markets.get(hlName(o.coin));
        return m ? [{ a: m.asset.index, o: o.oid }] : [];
      });
      exchangeStatuses(await c().l1(cancelAction(cancels), key));
      await refreshAccounts().catch(() => {});
    },

    async history(_acct: VenueAccount) {
      if (!user) return { trades: [], funding: [] };
      const [f, fu] = await Promise.all([c().info({ type: "userFills", user }), c().info({ type: "userFunding", user, startTime: Math.floor(host.now() - 30 * 86_400_000) })]);
      return { trades: parseFills(f), funding: parseUserFunding(fu) };
    },
    isPerp,
    agentAddress: () => (agentUsable(agent, host.now(), 0) ? agent!.address : null),
    user: () => user,
  };
  return venue;
}

export type HyperliquidVenue = ReturnType<typeof createHyperliquidVenue>;
