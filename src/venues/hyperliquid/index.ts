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
import { HL_MAKER, HL_TAKER, applyBook, exchangeStatuses, hlName, parseClearinghouse, parseFills, parseMeta, parseOpenOrders, parseUserFees, parseUserFunding, restingOrders, triggerOrders, type HlAccountState, type HlDexMeta, type HlMarket, type HlOrder } from "./parse.ts";
import { HL_BUILDER_DEXES, agentSendAssetAction, builderLabel, builderNote, collateralTokenWire, findDex, hip3Fees, parseCategories, shortfall, type HlDex } from "./hip3.ts";
import { cancelAction, closeOrder, entryOrders, hlLeverage, iocNoFill, leverageAction, orderAction, outcome, type Grouping, type OrderWire } from "./orders.ts";
import { depositUsdc } from "./deposit.ts";
import { SigningKey, Wallet } from "ethers";
import { signL1 } from "./signing.ts";

/** Honest label: signing is verified against Hyperliquid's servers, but no real (testnet) order has been placed yet. */
export const HL_STATUS = {
  tag: "not live-tested",
  detail:
    "Order signing is checked against Hyperliquid's own servers, but this app has not yet placed a real Hyperliquid order, even on testnet (Hyperliquid's testnet only opens accounts for addresses that have deposited on mainnet). Treat trading here as unproven. Builder (HIP-3) markets such as trade.xyz's stocks, commodities, indices and FX use the same order path with their own asset ids, isolated margin and a collateral move to their dex, all wired from Hyperliquid's docs and equally untested.",
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

const isPerp = (n: string) => /^([a-z0-9]{1,10}:[A-Za-z0-9]+|[A-Z0-9]+)-PERP$/.test(n);

/** userAbstraction values under which Hyperliquid moves builder-dex collateral itself. */
const AUTO_COLLATERAL = new Set(["unifiedAccount", "portfolioMargin", "dexAbstraction"]);

export function createHyperliquidVenue(host: HlHost) {
  let client: HlClient | null = null;
  let clientKey = "";
  let user: string | null = null;
  let agent: AgentSession | null = null;
  let mode: MarginMode = "cross";
  let state: HlAccountState | null = null; // Hyperliquid's own dex ("")
  let dexStates: Record<string, HlAccountState | null> = {}; // builder dexes, by name
  let abstraction: string | null = null;
  let builders: HlDex[] = [];
  let categories: ReturnType<typeof parseCategories> = new Map();
  let buildersAt = 0;
  const collateral: Record<string, number> = {}; // builder dex → collateral token index
  let tokenWire: Record<number, string> = {};
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
      dexStates = {};
      abstraction = null;
      builders = [];
      categories = new Map();
      buildersAt = 0;
      tokenWire = {};
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

  /** Which builder dexes exist on this network (perpDexs) and the deployers' categories and names (perpConciseAnnotations); refreshed every 10 minutes. */
  let buildersBusy: Promise<void> | null = null;
  function loadBuilders(): Promise<void> {
    if (buildersAt && host.now() - buildersAt < 600_000) return Promise.resolve();
    // one perpDexs + perpConciseAnnotations round trip at a time: overlapping market loads share it
    buildersBusy ??= fetchBuilders().finally(() => (buildersBusy = null));
    return buildersBusy;
  }
  async function fetchBuilders() {
    const cl = c();
    const [dx, ct] = await Promise.allSettled([cl.info({ type: "perpDexs" }), cl.info({ type: "perpConciseAnnotations" })]);
    if (cl !== client || dx.status !== "fulfilled" || ct.status !== "fulfilled") return; // try again next refresh
    builders = HL_BUILDER_DEXES.map((n) => findDex(dx.value, n)).filter((d): d is HlDex => d !== null);
    categories = parseCategories(ct.value);
    buildersAt = host.now();
  }
  function dexMeta(d: HlDex): HlDexMeta {
    return {
      name: d.name,
      index: d.index,
      categories,
      builder: (lev, iso) => ({ dex: d.name, label: builderLabel(host.net(), d), note: builderNote(host.net(), d, lev, iso) }),
      fees: (scale, growth) => hip3Fees(fees ?? { taker: HL_TAKER, maker: HL_MAKER }, scale, growth),
    };
  }
  async function loadMarkets() {
    await loadBuilders().catch(() => {});
    const [raw, ...dexRaw] = await Promise.all([c().info({ type: "metaAndAssetCtxs" }), ...builders.map((d) => c().info({ type: "metaAndAssetCtxs", dex: d.name }).catch(() => null))]);
    const r = parseMeta(raw, fees ?? undefined);
    builders.forEach((d, i) => {
      const x = dexRaw[i];
      if (!x) return;
      const b = parseMeta(x, fees ?? undefined, dexMeta(d));
      const ct = Array.isArray(x) && typeof (x[0] as { collateralToken?: unknown })?.collateralToken === "number" ? (x[0] as { collateralToken: number }).collateralToken : null;
      if (ct !== null) collateral[d.name] = ct;
      r.markets.push(...b.markets);
      Object.assign(r.tickers, b.tickers);
    });
    markets = new Map(r.markets.map((m) => [m.name, m]));
    for (const [k, v] of Object.entries(r.tickers)) tk[k] = { ...v, ...(tk[k] && tk[k]!.askSize ? { bid: tk[k]!.bid, ask: tk[k]!.ask, bidSize: tk[k]!.bidSize, askSize: tk[k]!.askSize } : {}) };
    liveAt = host.now();
    return r;
  }
  /** Isolated is the only mode for this market: the exchange says so, or it is a builder market. */
  const isolatedHere = (name: string) => {
    const m = markets.get(name);
    return !!m && (m.asset.onlyIsolated || !!m.asset.dex);
  };
  /** The account state that margins this market (each perp dex margins separately). */
  const stateFor = (m: HlMarket | null | undefined): HlAccountState | null => (m?.asset.dex ? (dexStates[m.asset.dex] ?? null) : state);
  /** USDC Hyperliquid will move into a builder dex for this user without being asked. */
  const autoCollateral = () => abstraction !== null && AUTO_COLLATERAL.has(abstraction);
  /**
   * The VenueAccount for a market: positions and orders of every dex (one address, one
   * portfolio), value summed, free margin of the dex that margins this market (for a builder
   * market, plus what the app can move over from the main balance).
   */
  function accountFor(name: string): VenueAccount | null {
    if (!user || !state) return null;
    const m = markets.get(name) ?? null;
    const own = stateFor(m) ?? (m?.asset.dex ? null : state);
    const all = [state, ...Object.values(dexStates)].filter((x): x is HlAccountState => !!x);
    const free = m?.asset.dex ? (own?.withdrawable ?? 0) + state.withdrawable : state.account.initialMargin;
    return {
      id: 0,
      value: all.reduce((a, x) => a + x.account.value, 0),
      initialMargin: free,
      maintenanceMargin: own ? own.account.maintenanceMargin : state.withdrawable,
      underLiquidation: all.some((x) => x.account.underLiquidation),
      positions: all.flatMap((x) => x.account.positions),
      openOrders: restingOrders(orders),
    };
  }
  /** "USDC:0x…" for the collateral token of a builder dex (spotMeta, cached). */
  async function collateralWire(dex: string): Promise<string> {
    const idx = collateral[dex] ?? 0;
    if (!tokenWire[idx]) {
      const w = collateralTokenWire(await c().info({ type: "spotMeta" }), idx);
      if (!w) throw new Error("Could not read the collateral token of the " + dex + " dex");
      tokenWire[idx] = w;
    }
    return tokenWire[idx]!;
  }
  /**
   * Builder dexes margin separately from Hyperliquid's main USDC balance. Before an order on
   * one, move exactly the shortfall (rounded up to the cent, +1% for the price protection) from
   * the main balance with agentSendAsset, unless the account already has Hyperliquid move
   * collateral itself (unified / portfolio margin / dex abstraction).
   */
  async function ensureCollateral(m: HlMarket, need: number, key: SigningKey, onStep?: (s: string) => void) {
    const dex = m.asset.dex;
    if (!dex || autoCollateral() || !user) return;
    const free = dexStates[dex]?.withdrawable ?? 0;
    const amt = shortfall(need * 1.01, free);
    if (!amt) return;
    const main = state?.withdrawable ?? 0;
    if (main + 1e-9 < Number(amt)) throw new Error(`${m.currency} is a builder market with its own collateral: it needs $${amt} more on the ${dex} dex, and your main Hyperliquid balance has $${main.toFixed(2)} free`);
    const token = await collateralWire(dex);
    onStep?.(`Moving ${amt} USDC from your main Hyperliquid balance to the ${dex} dex (builder markets keep their own collateral)…`);
    const u = user;
    exchangeStatuses(await c().l1((nonce) => agentSendAssetAction({ destination: u.toLowerCase(), sourceDex: "", destinationDex: dex, token, amount: amt, nonce }), key));
    const st = dexStates[dex];
    if (st) st.withdrawable += Number(amt);
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
    const isCross = mode === "cross" && !isolatedHere(m.name);
    const st = stateFor(m);
    const cur = st?.leverage[m.asset.coin];
    if (cur && cur.value === want && (cur.type === "cross") === isCross) return;
    const r = await c().l1(leverageAction(m.asset.index, isCross, want), key);
    exchangeStatuses(r); // throws with Hyperliquid's own words on rejection
    if (st) st.leverage[m.asset.coin] = { type: isCross ? "cross" : "isolated", value: want };
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
    const u = user;
    const [ch, oo, uf, ab, ...dx] = await Promise.all([
      c().info({ type: "clearinghouseState", user }),
      c().info({ type: "frontendOpenOrders", user }),
      fees ? Promise.resolve(null) : c().info({ type: "userFees", user }).catch(() => null),
      builders.length && abstraction === null ? c().info({ type: "userAbstraction", user }).catch(() => null) : Promise.resolve(abstraction),
      ...builders.map((d) => Promise.all([c().info({ type: "clearinghouseState", user: u, dex: d.name }).catch(() => null), c().info({ type: "frontendOpenOrders", user: u, dex: d.name }).catch(() => [])])),
    ]);
    state = parseClearinghouse(ch, marks);
    abstraction = typeof ab === "string" ? ab : null;
    dexStates = {};
    orders = parseOpenOrders(oo);
    builders.forEach((d, i) => {
      const [dch, doo] = dx[i] as [unknown, unknown];
      dexStates[d.name] = parseClearinghouse(dch, marks);
      orders.push(...parseOpenOrders(doo));
    });
    if (state) state.account.openOrders = restingOrders(orders);
    const f = parseUserFees(uf);
    if (f) {
      const base = fees ?? { taker: HL_TAKER, maker: HL_MAKER };
      fees = f;
      for (const m of markets.values()) {
        // builder coins keep their HIP-3 multiplier (2× / growth mode 0.2×) on top of the user's own rate
        m.takerFeeRate = m.asset.dex ? (m.takerFeeRate / base.taker) * f.taker : f.taker;
        m.makerFeeRate = m.asset.dex ? (base.maker ? (m.makerFeeRate / base.maker) * f.maker : f.maker) : f.maker;
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
    /**
     * Builder markets are traded isolated only: each margins on its own dex, and the app moves
     * exactly one position's margin there, so cross margin on that dex would rest on whatever
     * else happened to sit there.
     */
    get marginModes(): readonly MarginMode[] {
      return isolatedHere(focused) ? ["isolated"] : ["cross", "isolated"];
    },

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
        dexStates = {};
        abstraction = null;
        orders = [];
        host.changed();
      }
    },
    accountsFor: (name) => {
      const a = accountFor(name);
      return a ? [a] : [];
    },
    accountScope: (name) => {
      if (!user) return null;
      const m = markets.get(name);
      if (m?.asset.dex) return `your Hyperliquid account, ${m.asset.dex} dex (isolated margin${autoCollateral() ? "" : ", its own collateral"})`;
      if (m?.asset.onlyIsolated) return "your Hyperliquid account (isolated margin)";
      return `your Hyperliquid account (${mode === "cross" ? "cross margin" : "isolated margin"})`;
    },
    selectedAccount: (name) => accountFor(name),
    selectAccount: () => {},
    newAccount: () => depositSheet(),
    deposit: () => depositSheet(),
    withdraw: () => withdrawSheet(),
    refreshAccounts,
    signer() {
      if (!user) return null;
      return { oneTap: agentUsable(agent, host.now()), triggersNeedWallet: false };
    },
    marginMode: () => (isolatedHere(focused) ? "isolated" : mode),
    setMarginMode(m) {
      mode = m;
      host.changed();
    },
    effectiveLeverage: (name, lev) => {
      const m = markets.get(name);
      return m ? hlLeverage(lev, m.asset.maxLeverage) : Math.max(1, Math.floor(lev));
    },
    riskWords: () =>
      markets.get(focused)?.builder
        ? `I understand ${markets.get(focused)!.currency} is a builder (HIP-3) market deployed by a third party on Hyperliquid, that this isolated-margin perpetual can lose all the margin I put in, pays or receives funding every hour, can trade while its underlying market is closed, and can be liquidated under Hyperliquid's rules.`
        : (isolatedHere(focused) ? "isolated" : mode) === "cross"
        ? "I understand perpetuals use leverage on my whole Hyperliquid account balance (cross margin), pay or receive funding every hour, and can be liquidated under Hyperliquid's rules."
        : "I understand this isolated-margin perpetual can lose all the margin I put in, pays or receives funding every hour, and can be liquidated under Hyperliquid's rules.",
    collateralWords: () => {
      const m = markets.get(focused);
      return m?.asset.dex
        ? `USDC on Hyperliquid's ${m.asset.dex} dex (kept apart from your main balance; ${autoCollateral() ? "your account moves it over automatically" : "the app moves the margin over from your main balance before the order"})`
        : `USDC deposited on Hyperliquid (from ${N().depositChainName})`;
    },

    async marginCheck(acct, q) {
      if (!state) return { valid: true, postIM: null, postMM: null };
      const m = markets.get(q.inst.name) ?? (q.inst as HlMarket);
      const lev = hlLeverage(q.leverage, m.asset?.maxLeverage ?? q.leverage);
      const need = q.reducesExisting ? 0 : (q.n * q.entry) / lev + q.estFee;
      // a builder dex can be topped up from the main balance before the order
      const free = m.asset?.dex ? (dexStates[m.asset.dex]?.withdrawable ?? 0) + state.withdrawable : state.withdrawable;
      return { valid: need <= free + 1e-9, postIM: free - need, postMM: null };
    },

    async open(_acct, q, onStep) {
      const m = market(q.inst.name);
      const key = await ensureAgent(onStep);
      if (m.asset.dex && !q.reducesExisting) {
        const lev = hlLeverage(q.leverage, m.asset.maxLeverage);
        await ensureCollateral(m, (q.n * Number(q.limitPrice || q.entry)) / lev + q.worstFee, key, onStep);
      }
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

    async sparkline(name) {
      const m = markets.get(name);
      if (!m) return [];
      const end = host.now();
      const r = await c().info({ type: "candleSnapshot", req: { coin: m.asset.coin, interval: "1h", startTime: end - 86_400_000, endTime: end } });
      return Array.isArray(r) ? r.map((x) => Number((x as { c?: unknown })?.c)).filter((v) => Number.isFinite(v) && v > 0) : [];
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
