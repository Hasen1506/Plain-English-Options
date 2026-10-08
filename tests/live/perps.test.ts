// Opt-in live PERP test against Derive TESTNET (never mainnet):
//   DERIVE_PRIVATE_KEY=0x… [DERIVE_WALLET=0x…] [DERIVE_SUBACCOUNT_ID=…] npm run test:live -- perps
// The owner key registers a one-tap session key scoped to option + perp orders,
// and every order below is signed by that session key, through the app's own
// code: open a small long (with a take-profit and stop-loss attached), close it;
// open a small short, close half then the rest; flip a long into a short and
// close it; rest a post-only limit and cancel it. Then it checks trade history
// and that positions, orders and triggers are back to where they started.
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { NETWORKS, PERP_SLIPPAGE } from "../../src/config.ts";
import { DeriveClient } from "../../src/net/client.ts";
import { keySigner } from "../../src/net/signer.ts";
import { registerSessionKey, revokeSessionKey, sessionSigner } from "../../src/net/sessionKey.ts";
import { cancelOrder, type Ctx, type OrderOutcome } from "../../src/net/trader.ts";
import { cancelEverything, cancelTrigger, closePerp, flipPerp, openPerp, parseTriggerOrders, perpMarginCheck, type DeriveQuote } from "../../src/net/perpTrader.ts";
import { parsePerpInstrument, parsePerpTicker, quotePerp, type PerpInstrument } from "../../src/lib/perp.ts";
import { parseFunding, perpLedger } from "../../src/lib/perpHistory.ts";
import { parseTrades } from "../../src/lib/history.ts";
import { parseSubaccount, type SubaccountInfo } from "../../src/lib/ticker.ts";
import { parseRiskUniverses, riskUniverseFor } from "../../src/net/onchain.ts";

const KEY = process.env.DERIVE_PRIVATE_KEY;
let SUB = Number(process.env.DERIVE_SUBACCOUNT_ID ?? 0);
const net = NETWORKS.testnet; // hard-wired: this test never touches mainnet
const NAME = "ETH-PERP";

describe.skipIf(!KEY)("live testnet perps", () => {
  it("long, short, partial close, flip, resting limit, TP/SL and cancel-all, all with a one-tap key", async () => {
    const owner = keySigner(KEY!, net, process.env.DERIVE_WALLET);
    let loginAs = owner;
    const client = new DeriveClient(net.wsUrl, {
      timeoutMs: 20_000,
      onOpen: async (c) => {
        const ts = String(Date.now());
        await c.callRaw("public/login", { wallet: loginAs.owner, timestamp: ts, signature: await loginAs.signLogin(ts) });
      },
    });
    client.connect();
    const log: Record<string, unknown> = { at: new Date().toISOString(), network: net.id, instrument: NAME };
    const orders: Record<string, string | null> = {};
    const rec = (k: string, o: OrderOutcome) => {
      orders[k] = o.orderId;
      return o;
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // RECORD_FIXTURES=1 keeps the raw private replies (tests/fixtures/perps-testnet-private.json)
    const frames: { method: string; params: unknown; result: unknown }[] = [];
    const KEEP = new Set(["private/get_subaccount", "private/get_trigger_orders", "private/order", "private/get_trade_history", "private/get_funding_history", "private/get_margin"]);
    const rpc = {
      call: async <T>(method: string, params: object = {}): Promise<T> => {
        const r = await client.call<T>(method, params);
        if (KEEP.has(method)) frames.push({ method, params: { ...params, signature: undefined }, result: r });
        return r;
      },
    };
    try {
      const ru = riskUniverseFor(parseRiskUniverses(await client.call("public/get_risk_universes", {})), NAME);
      log.riskUniverse = ru;
      expect(ru).toBe(1);
      if (!SUB) {
        const ids = (await client.call<{ subaccount_ids: number[] }>("private/get_subaccounts", { wallet: owner.owner })).subaccount_ids;
        const subs = (await Promise.all(ids.map((id) => client.call("private/get_subaccount", { subaccount_id: id }).then(parseSubaccount)))).filter((s): s is SubaccountInfo => !!s && s.riskUniverse === ru);
        SUB = subs.sort((a, b) => b.value - a.value)[0]?.id ?? 0;
      }
      expect(SUB, "no subaccount in the ETH-PERP risk universe").toBeGreaterThan(0);
      log.subaccount = SUB;
      const sub = async () => parseSubaccount(await rpc.call("private/get_subaccount", { subaccount_id: SUB }))!;
      const sizeOf = (s: SubaccountInfo) => s.positions.find((p) => p.instrument === NAME)?.amount ?? 0;
      const before = await sub();
      const baseline = sizeOf(before);
      log.baseline = { size: baseline, value: before.value, openOrders: before.openOrders.length };

      // one-tap key: owner signs once; every order after this is signed by the session key
      const hnd = await registerSessionKey(client, owner, [SUB], Date.now(), { ttlSec: 3600 });
      log.sessionKey = { address: hnd.address, scopes: hnd.scopes };
      const tap = sessionSigner(hnd, owner.owner, net);
      const ctx: Ctx = { rpc, signer: tap, net, subaccountId: SUB };

      const inst = parsePerpInstrument(await client.call("public/get_instrument", { instrument_name: NAME })) as PerpInstrument;
      expect(inst).toBeTruthy();
      const tick = async () => parsePerpTicker(await client.call("public/get_ticker", { instrument_name: NAME }))!;
      const quote = async (dir: "long" | "short", extra: Partial<Parameters<typeof quotePerp>[0]> = {}): Promise<DeriveQuote> => {
        const t = await tick();
        const s = await sub();
        const ref = t.mark;
        // the exchange minimum (0.1 ETH ≈ $250) at 5×
        const risk = (Number(inst.minAmount) * ref) / 5 + 1;
        const r = quotePerp({ inst, ticker: t, dir, risk, leverage: 5, orderType: "market", slippage: PERP_SLIPPAGE, headroomMM: s.maintenanceMargin, headroomIM: s.initialMargin, existing: sizeOf(s), leverageCap: 10, ...extra });
        if (!r.ok) throw new Error("quote failed: " + r.reason);
        expect(r.quote.problems).toEqual([]);
        return r.quote as DeriveQuote; // built on a Derive instrument
      };

      // exchange margin check (read-only)
      const q0 = await quote("long");
      const mc = await perpMarginCheck(rpc, SUB, NAME, q0.amount);
      log.marginCheck = { amount: q0.amount, ...mc, ourLiqEstimate: q0.liqPrice };
      expect(mc.valid).toBe(true);

      // 1. long with take-profit and stop-loss attached
      const t1 = await tick();
      const q1 = await quote("long", { takeProfit: t1.mark * 1.2, stopLoss: t1.mark * 0.8 });
      const o1 = await openPerp(ctx, q1, undefined, { ...ctx, signer: owner }); // TP/SL: owner-signed (30-day signatures)
      rec("openLong", o1.entry);
      expect(o1.entry.error).toBeNull();
      expect(o1.entry.filled).toBeCloseTo(q1.n, 9);
      log.openLong = { amount: q1.amount, avg: o1.entry.avgPrice, fee: o1.entry.fee, liqEstimate: q1.liqPrice, triggers: o1.triggers.map((t) => ({ id: t.orderId, status: t.status, error: t.error })) };
      o1.triggers.forEach((t, i) => (orders[i === 0 ? "takeProfit" : "stopLoss"] = t.orderId));
      await sleep(1500);
      const afterLong = await sub();
      const pLong = afterLong.positions.find((p) => p.instrument === NAME)!;
      log.positionAfterLong = { size: pLong.amount, avg: pLong.averagePrice, liq: pLong.liquidationPrice, funding: pLong.cumulativeFunding + pLong.pendingFunding, leverage: pLong.leverage, ourLiqEstimate: q1.liqPrice };
      expect(sizeOf(afterLong)).toBeCloseTo(baseline + q1.n, 9);
      const trig = parseTriggerOrders(await rpc.call("private/get_trigger_orders", { subaccount_id: SUB }));
      log.triggersListed = trig.map((t) => ({ id: t.orderId, type: t.triggerType, price: t.triggerPrice, side: t.direction, amount: t.amount }));
      log.triggerOrdersSupported = o1.triggers.length === 2 && o1.triggers.every((t) => !t.error);
      if (log.triggerOrdersSupported) {
        expect(trig.length).toBeGreaterThanOrEqual(2);
        await cancelTrigger(client, SUB, trig.find((t) => t.triggerType === "takeprofit")!.orderId); // one by id…
      }
      const c1 = rec("closeLong", await closePerp(ctx, inst, await tick(), sizeOf(afterLong) - baseline));
      expect(c1.filled).toBeCloseTo(q1.n, 9);
      await cancelEverything(client, SUB); // …the rest with cancel_all (incl. triggers)
      expect(parseTriggerOrders(await rpc.call("private/get_trigger_orders", { subaccount_id: SUB }))).toEqual([]);

      // 2. short, close half, then the rest
      const q2 = await quote("short");
      const o2 = await openPerp(ctx, q2);
      rec("openShort", o2.entry);
      expect(o2.entry.filled).toBeCloseTo(q2.n, 9);
      await sleep(1000);
      const half = rec("closeShortHalf", await closePerp(ctx, inst, await tick(), -q2.n, 0.5));
      expect(half.filled).toBeGreaterThan(0);
      expect(half.filled).toBeLessThan(q2.n);
      await sleep(1000);
      const rest = rec("closeShortRest", await closePerp(ctx, inst, await tick(), sizeOf(await sub()) - baseline));
      expect(half.filled + rest.filled).toBeCloseTo(q2.n, 9);
      log.short = { amount: q2.amount, open: o2.entry.avgPrice, half: half.filled, rest: rest.filled };

      // 3. flip a long into a short, then close
      const q3 = await quote("long");
      rec("flipOpenLong", (await openPerp(ctx, q3)).entry);
      await sleep(1000);
      const fl = await flipPerp(ctx, inst, await tick(), q3.n);
      rec("flipClose", fl.close);
      if (fl.open) rec("flipOpenShort", fl.open);
      expect(fl.open?.filled ?? 0).toBeCloseTo(q3.n, 9);
      await sleep(1000);
      const afterFlip = sizeOf(await sub());
      expect(afterFlip).toBeCloseTo(baseline - q3.n, 9);
      rec("flipCloseShort", await closePerp(ctx, inst, await tick(), afterFlip - baseline));
      log.flip = fl.message;

      // 4. resting post-only limit far from the touch, then cancel it
      const t4 = await tick();
      const q4 = await quote("long", { orderType: "limit", limitPrice: Math.max(t4.bid * 0.985, t4.minPrice ?? 0), postOnly: true }); // inside the ±band, below the bid
      const o4 = await openPerp(ctx, q4);
      rec("restingLimit", o4.entry);
      expect(o4.entry.status).toBe("open");
      let open: SubaccountInfo["openOrders"] = [];
      for (let i = 0; i < 10 && !open.length; i++) {
        await sleep(800); // the book lists a new resting order a moment after the reply
        open = (await sub()).openOrders.filter((o) => o.orderId === o4.entry.orderId);
      }
      expect(open).toHaveLength(1);
      await cancelOrder(client, SUB, o4.entry.orderId!, NAME);
      log.resting = { price: q4.limitPrice, tif: q4.tif, cancelled: true };

      // 5. back to baseline; history has every fill; funding history readable
      await sleep(2500);
      const after = await sub();
      expect(sizeOf(after)).toBeCloseTo(baseline, 9);
      expect(after.openOrders.filter((o) => o.instrument === NAME)).toHaveLength(0);
      const trades = parseTrades(await rpc.call("private/get_trade_history", { subaccount_id: SUB, page_size: 100 }));
      const ids = new Set(trades.map((t) => t.orderId));
      for (const k of ["openLong", "closeLong", "openShort", "closeShortHalf", "closeShortRest", "flipOpenLong", "flipClose", "flipOpenShort", "flipCloseShort"]) expect(ids.has(orders[k]!), k).toBe(true);
      const mine = trades.filter((t) => Object.values(orders).includes(t.orderId));
      const ledger = perpLedger(mine).find((l) => l.instrument === NAME)!;
      const exchangeRealised = mine.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
      const funding = parseFunding(await rpc.call("private/get_funding_history", { subaccount_id: SUB, instrument_name: NAME }));
      log.history = { trades: mine.length, ourRealisedExFees: ledger.realized, fees: ledger.fees, ourRealisedNet: ledger.realized - ledger.fees, exchangeRealisedSum: exchangeRealised, fundingEvents: funding.length };
      expect(Math.abs(ledger.size)).toBeLessThan(1e-9); // our own trades net to flat
      // our average-cost realised P&L (after fees) matches the exchange's own realized_pnl
      expect(Math.abs(ledger.realized - ledger.fees - exchangeRealised)).toBeLessThan(1e-6);
      log.valueAfter = after.value;
      log.valueChange = after.value - before.value;

      // revoke the one-tap key (owner signs)
      loginAs = owner;
      await revokeSessionKey(client, owner, hnd, Date.now());
      log.sessionKeyRevoked = true;
      log.orders = orders;
      log.ok = true;
    } finally {
      log.orders = orders;
      mkdirSync(new URL("../../docs/", import.meta.url), { recursive: true });
      writeFileSync(new URL("../../docs/live-perps-testnet.json", import.meta.url), JSON.stringify(log, null, 2) + "\n");
      if (process.env.RECORD_FIXTURES === "1" && log.ok) writeFileSync(new URL("../fixtures/perps-testnet-private.json", import.meta.url), JSON.stringify({ recordedAt: Date.now(), subaccount: SUB, orders, frames }));
      client.close();
    }
  });
});
