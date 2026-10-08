// Perp order flow against a fake exchange that verifies every signature:
// market / limit / post-only entries, TP/SL triggers, reduce-only closes,
// flip safety, Close all ordering, the dry run, guards and the venue adapter.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Wallet, recoverAddress } from "ethers";
import { NETWORKS, TRIGGER_ORDER_TTL_SEC } from "../../src/config.ts";
import { keySigner } from "../../src/net/signer.ts";
import { sessionSigner } from "../../src/net/sessionKey.ts";
import { digest, encodeTradeData } from "../../src/net/signing.ts";
import type { Ctx, OrderOutcome, Rpc } from "../../src/net/trader.ts";
import { canSignTriggers, closeAll, closePerp, flipPerp, openPerp, parseTriggerOrders, perpMarginCheck, restingTtl, type DeriveQuote, type KillLeg } from "../../src/net/perpTrader.ts";
import { DryRunViolation, NEVER_IN_DRY_RUN, ReadOnlyRpc, debugPerp } from "../../src/net/dryrun.ts";
import { quotePerp, type PerpInput } from "../../src/lib/perp.ts";
import { parseLeverageCap, perpConfirmState, type PerpConfirmInput } from "../../src/lib/guards.ts";
import { createDeriveVenue, type DeriveHost } from "../../src/venues/derive.ts";
import type { SubaccountInfo } from "../../src/lib/ticker.ts";
import { toE18 } from "../../src/lib/units.ts";
import { mkPerp, mkPerpTicker } from "./perpgen.ts";
import { NOW } from "./gen.ts";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // Hardhat #1, test-only
const net = NETWORKS.testnet;
const inst = mkPerp();
const owner = keySigner(KEY, net);

type Plan = "fill" | "partial" | "nofill" | "rest" | "error";
function exchange(plan: Plan[] = []) {
  const sent: Record<string, unknown>[] = [];
  const methods: string[] = [];
  const rpc: Rpc = {
    async call<T>(method: string, params: object = {}): Promise<T> {
      methods.push(method);
      const p = params as Record<string, string | number | boolean>;
      if (method === "private/cancel_all") return { result: "ok" } as T;
      if (method === "private/get_margin") return { is_valid_trade: true, pre_initial_margin: "900", post_initial_margin: "880", post_maintenance_margin: "890" } as T;
      if (method !== "private/order") throw new Error("unexpected " + method);
      // every order carries a valid signature over exactly what it says
      const data = encodeTradeData({ assetAddress: inst.assetAddress, subId: inst.subId, limitPrice: String(p.limit_price), amount: String(p.amount), maxFee: String(p.max_fee), recipientId: Number(p.subaccount_id), isBid: p.direction === "buy" });
      const d = digest({ subaccountId: Number(p.subaccount_id), nonce: String(p.nonce), module: net.tradeModule, data, expiry: Number(p.signature_expiry_sec), owner: String(p.owner ?? owner.owner), signer: String(p.signer) }, net);
      if (recoverAddress(d, String(p.signature)) !== p.signer) throw new Error("Invalid signature");
      sent.push(p);
      if (p.trigger_type) return { order: { order_id: `trig-${sent.length}`, order_status: "untriggered", filled_amount: "0" }, trades: [] } as T;
      const b = plan.shift() ?? "fill";
      if (b === "error") throw new Error("Insufficient margin");
      const amt = Number(p.amount);
      const filled = b === "fill" ? amt : b === "partial" ? Math.floor(amt * 500) / 1000 : 0;
      const status = b === "rest" ? "open" : filled === amt ? "filled" : "cancelled";
      return { order: { order_id: `o-${sent.length}`, order_status: status, filled_amount: String(filled), average_price: filled ? "2500.5" : "0" }, trades: filled ? [{ trade_id: `t-${sent.length}`, trade_price: "2500.5", trade_amount: String(filled), trade_fee: "0.25" }] : [] } as T;
    },
  };
  return { rpc, sent, methods };
}

const ctxOf = (rpc: Rpc, signer = owner): Ctx => ({ rpc, signer, net, subaccountId: 87142, now: () => NOW });
const quote = (p: Partial<PerpInput> = {}): DeriveQuote => {
  const r = quotePerp({ inst, ticker: mkPerpTicker(), dir: "long", risk: 100, leverage: 5, orderType: "market", slippage: 0.005, leverageCap: 10, ...p });
  if (!r.ok) throw new Error(r.reason);
  return r.quote as DeriveQuote;
};

describe("opening a perp", () => {
  it("market long = order_type market + IOC, worst price signed as the limit; TP/SL as reduce-only mark triggers sized to the fill", async () => {
    const ex = exchange(["fill"]);
    const q = quote({ takeProfit: 3000, stopLoss: 2200 });
    const r = await openPerp(ctxOf(ex.rpc), q);
    expect(r.entry.filled).toBeCloseTo(q.n, 12);
    const [entry, tp, sl] = ex.sent;
    expect(entry).toMatchObject({ order_type: "market", time_in_force: "ioc", direction: "buy", reduce_only: false, limit_price: q.limitPrice, amount: q.amount });
    expect(tp).toMatchObject({ trigger_type: "takeprofit", trigger_price_type: "mark", direction: "sell", reduce_only: true, amount: q.amount, order_type: "market" });
    expect(sl).toMatchObject({ trigger_type: "stoploss", direction: "sell", reduce_only: true });
    expect(Number(tp!.trigger_price)).toBe(3000);
    // triggers must live 30–90 days (Derive rejects anything else)
    expect(Number(tp!.signature_expiry_sec) - Math.floor(NOW / 1000)).toBe(TRIGGER_ORDER_TTL_SEC);
    expect(r.triggers.map((t) => t.status)).toEqual(["untriggered", "untriggered"]);
  });
  it("partial fill → triggers re-signed for only what filled; no fill → no triggers", async () => {
    const ex = exchange(["partial"]);
    const q = quote({ takeProfit: 3000 });
    const r = await openPerp(ctxOf(ex.rpc), q);
    expect(Number(ex.sent[1]!.amount)).toBeCloseTo(r.entry.filled, 12);
    expect(Number(ex.sent[1]!.amount)).toBeLessThan(q.n);
    const ex2 = exchange(["nofill"]);
    expect((await openPerp(ctxOf(ex2.rpc), quote({ stopLoss: 2200 }))).triggers).toEqual([]);
    expect(ex2.sent).toHaveLength(1);
  });
  it("limit = GTC; post-only = post_only + reject_post_only; resting message", async () => {
    const ex = exchange(["rest", "rest"]);
    const r = await openPerp(ctxOf(ex.rpc), quote({ orderType: "limit", limitPrice: 2450 }));
    expect(ex.sent[0]).toMatchObject({ order_type: "limit", time_in_force: "gtc", limit_price: "2450" });
    expect(r.message).toMatch(/resting/);
    await openPerp(ctxOf(ex.rpc), quote({ orderType: "limit", limitPrice: 2450, postOnly: true }));
    expect(ex.sent[1]).toMatchObject({ time_in_force: "post_only", reject_post_only: true });
  });
  it("an exchange rejection is reported, not thrown", async () => {
    const r = await openPerp(ctxOf(exchange(["error"]).rpc), quote());
    expect(r.entry.error).toMatch(/Insufficient margin/);
    expect(r.message).toMatch(/Not placed/);
  });
  it("one-tap key: orders silent and signed by the key; TP/SL refuse the short-lived key and use the wallet", async () => {
    const key = Wallet.createRandom();
    const h = { address: key.address, expirySec: Math.floor(NOW / 1000) + 24 * 3600, subaccountIds: [87142], scopes: ["trade:orderbook:option", "trade:orderbook:perp"], key };
    const tap = sessionSigner(h, owner.owner, net, () => NOW);
    const ex = exchange(["fill", "rest"]);
    expect(canSignTriggers(ctxOf(ex.rpc, tap))).toBe(false);
    await expect(openPerp(ctxOf(ex.rpc, tap), quote({ takeProfit: 3000 }))).rejects.toThrow(/need your wallet/);
    const steps: string[] = [];
    const wallet = { ...owner, silent: false }; // a browser wallet prompts per signature
    await openPerp(ctxOf(ex.rpc, tap), quote({ takeProfit: 3000 }), (s) => steps.push(s), ctxOf(ex.rpc, wallet));
    expect(ex.sent[0]!.signer).toBe(key.address);
    expect(ex.sent[1]!.signer).toBe(owner.signer);
    expect(steps[0]).toMatch(/1 signature/);
    // a resting limit signed by the key expires before the key does
    expect(restingTtl(ctxOf(ex.rpc, tap))).toBeLessThan(24 * 3600);
    expect(restingTtl(ctxOf(ex.rpc, owner))).toBe(7 * 86_400);
  });
});

describe("closing, flipping and the kill switch", () => {
  const t = mkPerpTicker();
  it("close is reduce-only market IOC on the opposite side, for the fraction asked", async () => {
    const ex = exchange();
    await closePerp(ctxOf(ex.rpc), inst, t, 0.101, 0.5);
    expect(ex.sent[0]).toMatchObject({ direction: "sell", reduce_only: true, time_in_force: "ioc", order_type: "market", amount: "0.05" });
    await closePerp(ctxOf(ex.rpc), inst, t, -0.3);
    expect(ex.sent[1]).toMatchObject({ direction: "buy", reduce_only: true, amount: "0.3" });
  });
  it("close works even with that side of the book empty (bounded by the exchange band)", async () => {
    const ex = exchange();
    await closePerp(ctxOf(ex.rpc), inst, mkPerpTicker({ bid: 0 }), 1);
    expect(Number(ex.sent[0]!.limit_price)).toBe(2400);
  });
  it("flip: both orders signed up front; the new side opens only after a full close", async () => {
    const ex = exchange(["fill", "fill"]);
    const r = await flipPerp(ctxOf(ex.rpc), inst, t, 0.2);
    expect(ex.sent.map((s) => [s.direction, s.reduce_only, s.amount])).toEqual([["sell", true, "0.2"], ["sell", false, "0.2"]]);
    expect(r.message).toMatch(/now short 0.2/);
    const ex2 = exchange(["partial"]);
    const r2 = await flipPerp(ctxOf(ex2.rpc), inst, t, 0.2);
    expect(r2.open).toBeNull();
    expect(ex2.sent).toHaveLength(1);
    await expect(flipPerp(ctxOf(exchange().rpc), inst, t, 0.05)).rejects.toThrow(/at least 0.1/);
  });
  it("Close all: cancel_all (incl. triggers + algos) first, then option shorts, option longs, perps", async () => {
    const ex = exchange();
    const order: string[] = [];
    const leg = (name: string, amount: number, kind: KillLeg["kind"]): KillLeg => ({ name, amount, kind, close: async () => (order.push(name), { filled: Math.abs(amount) } as OrderOutcome) });
    const r = await closeAll(ex.rpc, 87142, [leg("ETH-PERP", 0.1, "perp"), leg("long call", 1, "option"), leg("short call", -1, "option")]);
    expect(ex.methods[0]).toBe("private/cancel_all");
    expect(order).toEqual(["short call", "long call", "ETH-PERP"]);
    expect(r.cancelled).toBe(true);
    const failing: KillLeg = { name: "BTC-PERP", amount: -1, kind: "perp", close: async () => { throw new Error("no book"); } };
    const r2 = await closeAll(ex.rpc, 1, [failing]);
    expect(r2.results[0]!.outcome.error).toBe("no book");
  });
  it("whatever the exchange does, a close never sends more than the position, and never a non-reduce-only order", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: -100_000, max: 100_000 }).filter((x) => x !== 0).map((x) => x / 1000), fc.double({ min: 0.01, max: 1, noNaN: true }), async (pos, f) => {
        const ex = exchange();
        await closePerp(ctxOf(ex.rpc), inst, t, pos, f);
        if (!ex.sent.length) return;
        expect(ex.sent[0]!.reduce_only).toBe(true);
        expect(toE18(String(ex.sent[0]!.amount)) <= toE18(Math.abs(pos).toFixed(3))).toBe(true);
        expect(ex.sent[0]!.direction).toBe(pos > 0 ? "sell" : "buy");
      }),
      { numRuns: 40 },
    );
  });
});

describe("reads", () => {
  it("margin check sends the signed simulated size and reads is_valid_trade", async () => {
    const seen: unknown[] = [];
    const rpc: Rpc = { call: async <T>(_m: string, p?: object) => (seen.push(p), { is_valid_trade: false, post_initial_margin: "-5" } as T) };
    const r = await perpMarginCheck(rpc, 9, "ETH-PERP", "-0.1");
    expect(seen[0]).toEqual({ subaccount_id: 9, simulated_position_changes: [{ instrument_name: "ETH-PERP", amount: "-0.1" }] });
    expect(r).toEqual({ valid: false, preIM: null, postIM: -5, postMM: null });
  });
  it("trigger orders parse; junk is skipped", () => {
    const r = parseTriggerOrders({ orders: [{ order_id: "a", instrument_name: "ETH-PERP", direction: "sell", amount: "0.1", trigger_type: "stoploss", trigger_price: "2000", limit_price: "1940", order_status: "untriggered" }, { nope: 1 }, null] });
    expect(r).toEqual([{ orderId: "a", instrument: "ETH-PERP", direction: "sell", amount: 0.1, triggerType: "stoploss", triggerPrice: 2000, limitPrice: 1940, status: "untriggered" }]);
    expect(parseTriggerOrders(null)).toEqual([]);
  });
});

describe("Check order (dry run) for perps", () => {
  it("signs the exact entry and sends it ONLY to private/order_debug", async () => {
    const seen: Record<string, unknown>[] = [];
    const inner: Rpc = {
      async call<T>(method: string, params: object = {}): Promise<T> {
        if (method !== "private/order_debug") throw new Error("unexpected " + method);
        seen.push(params as Record<string, unknown>);
        return { typed_data_hash: "0xbeef", recovered_signer: owner.signer, domain_separator: net.domainSeparator } as T;
      },
    };
    const ro = new ReadOnlyRpc(inner);
    const q = quote({ orderType: "limit", limitPrice: 2450, postOnly: true });
    const r = await debugPerp(ro, owner, net, 87142, q);
    expect(ro.sent).toEqual(["private/order_debug"]);
    expect(seen[0]).toMatchObject({ instrument_name: "ETH-PERP", time_in_force: "post_only", limit_price: "2450" });
    expect(r.ok).toBe(false); // the fake hash differs from ours: never a false green
    expect(recoverAddress(r.ourDigest, String(seen[0]!.signature))).toBe(owner.signer);
  });
  it("cancels, trigger cancels and liquidations are refused by the read-only connection too", async () => {
    const ro = new ReadOnlyRpc({ call: async () => { throw new Error("reached the socket"); } });
    for (const m of ["private/cancel_all", "private/cancel_trigger_order", "private/order", "private/liquidate"]) {
      expect(NEVER_IN_DRY_RUN.has(m)).toBe(true);
      await expect(ro.call(m, {})).rejects.toBeInstanceOf(DryRunViolation);
    }
  });
});

describe("perp Confirm guard and settings", () => {
  const q = quote();
  const base: PerpConfirmInput = { quote: q, quoteAgeMs: 1000, connected: true, accountOk: true, marginValid: true, agreed: true, network: "testnet", typed: "", busy: false };
  it("each gate blocks in order; testnet needs no phrase; mainnet needs REAL MONEY", () => {
    expect(perpConfirmState(base)).toMatchObject({ enabled: true, label: `Go long ${q.amount} ETH` });
    expect(perpConfirmState({ ...base, quoteAgeMs: 120_000 }).reason).toBe("stale");
    expect(perpConfirmState({ ...base, connected: false }).reason).toBe("wallet");
    expect(perpConfirmState({ ...base, accountOk: false }).reason).toBe("wrong-universe");
    expect(perpConfirmState({ ...base, marginValid: false }).reason).toBe("margin");
    expect(perpConfirmState({ ...base, agreed: false }).reason).toBe("agree");
    expect(perpConfirmState({ ...base, network: "mainnet" }).reason).toBe("phrase");
    expect(perpConfirmState({ ...base, network: "mainnet", typed: "real money" })).toMatchObject({ enabled: true, label: expect.stringMatching(/^Real money: /) });
    expect(perpConfirmState({ ...base, quote: quote({ leverage: 12 }) }).reason).toBe("problem");
  });
  it("optional per-trade limit applies on mainnet only, to the money put in; off by default", () => {
    expect(perpConfirmState({ ...base, network: "mainnet", typed: "REAL MONEY", maxCost: 50 }).reason).toBe("cap");
    expect(perpConfirmState({ ...base, network: "mainnet", typed: "REAL MONEY", maxCost: null }).enabled).toBe(true);
    expect(perpConfirmState({ ...base, maxCost: 50 }).enabled).toBe(true);
  });
  it("leverage cap setting parses to 1…max in half steps", () => {
    expect(parseLeverageCap("3x", 10, 5)).toBe(3);
    expect(parseLeverageCap("12", 10, 5)).toBe(10);
    expect(parseLeverageCap("0.2", 10, 5)).toBe(1);
    expect(parseLeverageCap("", 10, 5)).toBe(5);
    expect(parseLeverageCap("junk", 10, 5)).toBe(5);
    expect(parseLeverageCap("2.3", 10, 5)).toBe(2.5);
  });
});

describe("Derive venue adapter (PerpVenue contract)", () => {
  const sub = (id: number, ru: number, value: number): SubaccountInfo => ({ id, riskUniverse: ru, managerId: 1, value, initialMargin: value, maintenanceMargin: value, collateralsValue: value, underLiquidation: false, positions: [], openOrders: [] });
  function host(over: Partial<DeriveHost> = {}) {
    const calls: { m: string; p: unknown }[] = [];
    let sel: number | null = 5;
    const deposits: number[] = [], withdrawals: number[] = [];
    const h: DeriveHost = {
      client: () => ({ call: async (m: string, p: unknown) => (calls.push({ m, p }), m === "public/get_all_instruments" ? { instruments: [{ instrument_type: "perp", instrument_name: "ETH-PERP", is_active: true, tick_size: "0.01", minimum_amount: "0.1", maximum_amount: "1000", amount_step: "0.001", taker_fee_rate: "0.0003", maker_fee_rate: "0.0001", base_fee: "0.1", base_asset_address: inst.assetAddress, base_asset_sub_id: "0", perp_details: { srm_perp_margin_requirements: { im_perp_req: "0.066", mm_perp_req: "0.05" } } }] } : {}) }) as never,
      net: () => "testnet",
      now: () => NOW,
      wsOpen: () => true,
      wallet: () => ({ on: true, subs: [sub(5, 0, 10), sub(87142, 1, 1000), sub(9, 1, 50)], sel, signer: owner, session: null, tap: null }),
      setSel: (id) => (sel = id),
      universes: () => [{ id: 0, name: "fallback", managers: [{ id: 0, instruments: ["ETH-PERP"] }] }, { id: 1, name: "PRIME", managers: [{ id: 1, instruments: ["ETH-PERP", "ETH-OPTION"] }] }] as never,
      loadSubs: async () => {},
      newSubaccount: () => {},
      depositTo: (id) => deposits.push(id),
      withdrawFrom: (id) => withdrawals.push(id),
      ...over,
    };
    return { h, calls, deposits, withdrawals, sel: () => sel };
  }
  it("routes a market to accounts in its risk universe and picks the biggest one", () => {
    const x = host();
    const v = createDeriveVenue(x.h);
    expect(v.accountsFor("ETH-PERP").map((a) => a.id)).toEqual([87142, 9]);
    expect(v.accountScope("ETH-PERP")).toBe("risk universe 1 (PRIME)");
    expect(v.selectedAccount("ETH-PERP")!.id).toBe(87142);
    expect(x.sel()).toBe(87142);
  });
  it("markets, deposit/withdraw hooks, cancel-all and no one-tap without a perp-scoped key", async () => {
    const x = host();
    const v = createDeriveVenue(x.h);
    expect((await v.markets()).map((m) => m.name)).toEqual(["ETH-PERP"]);
    const acct = v.accountsFor("ETH-PERP")[0]!;
    v.deposit(acct);
    v.withdraw(acct);
    expect([x.deposits, x.withdrawals]).toEqual([[87142], [87142]]);
    await v.cancelAll(acct);
    expect(x.calls.at(-1)).toEqual({ m: "private/cancel_all", p: { subaccount_id: 87142, cancel_trigger_orders: true, cancel_algo_orders: true } });
    expect(v.signer()).toEqual({ oneTap: false, triggersNeedWallet: true });
    for (const k of ["triggers", "postOnly", "oneTap", "dryRun", "deposit", "withdraw", "crossMargin"] as const) expect(v.caps[k]).toBe(true);
  });
  it("an options-only one-tap key is not used for perps", () => {
    const key = Wallet.createRandom();
    const session = { address: key.address, expirySec: Math.floor(NOW / 1000) + 3600, subaccountIds: [87142], scopes: ["trade:orderbook:option"], key };
    const tap = sessionSigner(session, owner.owner, net, () => NOW);
    const v = createDeriveVenue(host({ wallet: () => ({ on: true, subs: [], sel: null, signer: owner, session, tap }) }).h);
    expect(v.signer()!.oneTap).toBe(false);
    const v2 = createDeriveVenue(host({ wallet: () => ({ on: true, subs: [], sel: null, signer: owner, session: { ...session, scopes: ["trade:orderbook:option", "trade:orderbook:perp"] }, tap }) }).h);
    expect(v2.signer()!.oneTap).toBe(true);
  });
});
