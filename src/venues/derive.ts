// Derive v3 as a PerpVenue. Signing, session keys, login, deposits and
// subaccounts are shared with the options side of the app (passed in as the
// host), so nothing here duplicates them: perps are one more instrument type
// on the same connection, wallet and one-tap key.

import { NETWORKS, PERP_SCOPE, PERP_SLIPPAGE, type NetworkId } from "../config.ts";
import type { DeriveClient } from "../net/client.ts";
import type { ActionSigner } from "../net/signer.ts";
import { ReadOnlyRpc, debugPerp } from "../net/dryrun.ts";
import { cancelEverything, cancelTrigger, closePerp, flipPerp, isDeriveQuote, openPerp, parseTriggerOrders, perpMarginCheck, type DeriveQuote } from "../net/perpTrader.ts";
import { riskUniverseFor, type RiskUniverse } from "../net/onchain.ts";
import { sessionKeyUsable, type SessionKeyHandle } from "../net/sessionKey.ts";
import type { Ctx } from "../net/trader.ts";
import { isPerpName, parsePerpInstrument, parsePerpInstruments, parsePerpTicker, parsePerpTickers, type PerpInstrument, type PerpQuote } from "../lib/perp.ts";
import { parseTrades } from "../lib/history.ts";
import { parseFunding } from "../lib/perpHistory.ts";
import type { SubaccountInfo } from "../lib/ticker.ts";
import type { PerpVenue, VenueAccount } from "./types.ts";

export interface DeriveHost {
  client(): DeriveClient;
  net(): NetworkId;
  now(): number;
  wsOpen(): boolean;
  wallet(): { on: boolean; subs: SubaccountInfo[]; sel: number | null; signer: ActionSigner | null; session: SessionKeyHandle | null; tap: ActionSigner | null };
  setSel(id: number): void;
  universes(): RiskUniverse[];
  loadSubs(): Promise<void>;
  newSubaccount(riskUniverse: number, product: string): void;
  depositTo(subaccountId: number): void;
  withdrawFrom(subaccountId: number): void;
}

export function createDeriveVenue(host: DeriveHost): PerpVenue {
  const byName = new Map<string, PerpInstrument>();
  let byNameNet: NetworkId | null = null;

  const net = () => NETWORKS[host.net()];
  const ru = (market: string) => riskUniverseFor(host.universes(), market);
  /** One-tap key if it is live and carries the perp scope; otherwise the wallet. */
  function orderSigner(): ActionSigner | null {
    const w = host.wallet();
    const s = w.session;
    if (s && w.tap && sessionKeyUsable(s.expirySec, host.now()) && s.scopes.includes(PERP_SCOPE)) return w.tap;
    return w.signer;
  }
  const ctxFor = (acct: VenueAccount, signer: ActionSigner | null): Ctx => {
    if (!signer) throw new Error("Connect your wallet first");
    return { rpc: host.client(), signer, net: net(), subaccountId: acct.id, now: host.now };
  };
  async function instrument(name: string): Promise<PerpInstrument> {
    if (byNameNet !== host.net()) {
      byName.clear();
      byNameNet = host.net();
    }
    const c = byName.get(name);
    if (c) return c;
    const i = parsePerpInstrument(await host.client().call("public/get_instrument", { instrument_name: name }));
    if (!i) throw new Error("no instrument data for " + name);
    byName.set(name, i);
    return i;
  }
  async function ticker(name: string) {
    const t = parsePerpTicker(await host.client().call("public/get_ticker", { instrument_name: name }));
    if (!t) throw new Error("no price for " + name);
    return t;
  }
  async function deriveQuote(q: PerpQuote): Promise<DeriveQuote> {
    if (isDeriveQuote(q)) return q;
    return { ...q, inst: await instrument(q.inst.name) }; // a quote built from a cached generic market
  }

  return {
    id: "derive",
    name: "Derive",
    caps: { triggers: true, postOnly: true, oneTap: true, dryRun: true, deposit: true, withdraw: true, crossMargin: true },
    slippage: PERP_SLIPPAGE,

    networkName: () => net().name,
    isMainnet: () => host.net() === "mainnet",
    isLive: () => host.wsOpen(),

    async markets() {
      const r = await host.client().call("public/get_all_instruments", { instrument_type: "perp", expired: false, page: 1, page_size: 1000 });
      const list = parsePerpInstruments(r).filter((i) => i.isActive);
      byName.clear();
      byNameNet = host.net();
      for (const i of list) byName.set(i.name, i);
      return list;
    },
    async tickers() {
      return parsePerpTickers(await host.client().call("public/get_tickers", { instrument_type: "perp" }));
    },

    connected: () => host.wallet().on,
    accountsFor(market) {
      const u = ru(market);
      return u === null ? [] : host.wallet().subs.filter((s) => s.riskUniverse === u);
    },
    accountScope(market) {
      const u = ru(market);
      if (u === null) return null;
      const name = host.universes().find((x) => x.id === u)?.name;
      return `risk universe ${u}${name ? ` (${name})` : ""}`;
    },
    selectedAccount(market) {
      const w = host.wallet();
      if (!w.on) return null;
      const u = ru(market);
      const cur = w.subs.find((s) => s.id === w.sel);
      if (cur && cur.riskUniverse === u) return cur;
      const best = w.subs.filter((s) => s.riskUniverse === u).sort((a, b) => b.value - a.value)[0] ?? null;
      if (best) host.setSel(best.id);
      return best;
    },
    selectAccount: (id) => host.setSel(id),
    newAccount(market) {
      const u = ru(market);
      if (u !== null) host.newSubaccount(u, market);
    },
    deposit: (acct) => host.depositTo(acct.id),
    withdraw: (acct) => host.withdrawFrom(acct.id),
    refreshAccounts: () => host.loadSubs(),
    signer() {
      const w = host.wallet();
      if (!w.on || !w.signer) return null;
      return { oneTap: orderSigner() !== w.signer, triggersNeedWallet: true };
    },

    async marginCheck(acct, q) {
      return perpMarginCheck(host.client(), acct.id, q.inst.name, (q.side === "buy" ? "" : "-") + q.amount);
    },
    async open(acct, q, onStep) {
      const dq = await deriveQuote(q);
      // TP/SL live 30+ days, so they are always signed by the wallet, never the one-tap key
      return openPerp(ctxFor(acct, orderSigner()), dq, onStep, ctxFor(acct, host.wallet().signer));
    },
    async checkOrder(acct, q) {
      const sg = orderSigner();
      if (!sg) return { ok: false, message: "Connect your wallet first" };
      const r = await debugPerp(new ReadOnlyRpc(host.client()), sg, net(), acct.id, await deriveQuote(q));
      return {
        ok: r.ok,
        message: r.ok ? `Derive verified the ${q.inst.name} order signature on ${net().name.toLowerCase()}. No order was sent.` : `Check failed: ${r.error ?? (r.exchangeHash === r.ourDigest ? "signer mismatch" : "hash mismatch")}`,
      };
    },
    async close(acct, market, position, fraction, label) {
      const [i, t] = await Promise.all([instrument(market), ticker(market)]);
      return closePerp(ctxFor(acct, orderSigner()), i, t, position, fraction, label);
    },
    async flip(acct, market, position) {
      const [i, t] = await Promise.all([instrument(market), ticker(market)]);
      return flipPerp(ctxFor(acct, orderSigner()), i, t, position);
    },
    async triggers(acct) {
      return parseTriggerOrders(await host.client().call("private/get_trigger_orders", { subaccount_id: acct.id }));
    },
    cancelTrigger: (acct, id) => cancelTrigger(host.client(), acct.id, id),
    cancelAll: (acct) => cancelEverything(host.client(), acct.id),

    async history(acct) {
      const [t, f] = await Promise.all([
        host.client().call("private/get_trade_history", { subaccount_id: acct.id, page_size: 200 }),
        host.client().call("private/get_funding_history", { subaccount_id: acct.id, page_size: 500 }),
      ]);
      return { trades: parseTrades(t).filter((x) => isPerpName(x.instrument)), funding: parseFunding(f) };
    },
    isPerp: isPerpName,
  };
}
