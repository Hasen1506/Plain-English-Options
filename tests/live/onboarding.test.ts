// Opt-in live TESTNET (Sepolia) run of everything the app adds for mainnet
// readiness, through the same code the browser runs (EIP-1193 provider shim):
//   onboarding: "account not found" → approve + depositToNewSubaccount (RU for ETH options) → credited
//   deposit to the existing subaccount, withdraw to the wallet
//   one-tap trading: register a session key (one wallet signature), open + close a
//   minimum spread signed only by the session key, order_debug, cancel_all, history, revoke
//
//   DERIVE_PRIVATE_KEY=0x… SEPOLIA_RPC=https://… npm run test:live -- tests/live/onboarding.test.ts
// Never touches mainnet: the network is hard-wired and the provider shim refuses chain 1.
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { NETWORKS } from "../../src/config.ts";
import { DeriveClient, DeriveRpcError } from "../../src/net/client.ts";
import { walletSigner } from "../../src/net/signer.ts";
import { closeSpread, placeSpread } from "../../src/net/trader.ts";
import { collateralFor, depositRoute, estimateDepositGas, parseRiskUniverses, planDeposit, riskUniverseForOptions, sendStep, waitReceipt, withdraw, type DepositTarget } from "../../src/net/onchain.ts";
import { registerSessionKey, revokeSessionKey, sessionSigner, parseSessionKeys } from "../../src/net/sessionKey.ts";
import { ReadOnlyRpc, debugSpread } from "../../src/net/dryrun.ts";
import { closedSpreads, parseOrders, parseTrades } from "../../src/lib/history.ts";
import { parseInstruments, parseSubaccount, parseTickers, type SubaccountInfo } from "../../src/lib/ticker.ts";
import { quoteSpread, selectSpread, type SpreadQuote } from "../../src/lib/spread.ts";
import { expiriesFor, spotOf } from "../../src/lib/market.ts";
import { isNoAccount } from "../../src/net/account.ts";
import { keyProvider } from "./eip1193.ts";

const KEY = process.env.DERIVE_PRIVATE_KEY;
const RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const net = NETWORKS.testnet;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!KEY)("live testnet onboarding + one-tap trading", () => {
  it("onboards, deposits, withdraws, trades with a session key, checks, cancels, reads history, revokes", { timeout: 1_500_000 }, async () => {
    const p = keyProvider(KEY!, RPC, net.chainId);
    const wallet = walletSigner(p, p.address, net);
    const client = new DeriveClient(net.wsUrl, {
      timeoutMs: 30_000,
      onOpen: async (c) => {
        const ts = String(Date.now());
        try {
          await c.callRaw("public/login", { wallet: wallet.owner, timestamp: ts, signature: await wallet.signLogin(ts) });
        } catch {
          /* no account yet: the test handles it */
        }
      },
    });
    const log: Record<string, unknown> = { at: new Date().toISOString(), network: net.id, wallet: wallet.owner };
    const save = () => {
      mkdirSync("test-results", { recursive: true });
      writeFileSync("test-results/live-onboarding.json", JSON.stringify(log, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    };
    const login = async () => {
      const ts = String(Date.now());
      return client.call("public/login", { wallet: wallet.owner, timestamp: ts, signature: await wallet.signLogin(ts) });
    };
    try {
      const universes = parseRiskUniverses(await client.call("public/get_risk_universes", {}));
      const ru = riskUniverseForOptions(universes, "ETH");
      expect(ru).toBe(1);
      const route = depositRoute(universes, net, ru!);
      log.route = { riskUniverse: ru, managerId: route.managerId, asset: route.collateral.assetAddress, erc20: route.collateral.erc20, min: route.collateral.minDepositUsd };

      // ---- 1. onboarding
      let hasAccount = true;
      try {
        await login();
      } catch (e) {
        expect(isNoAccount(e)).toBe(true);
        log.noAccountError = { code: (e as DeriveRpcError).code, message: (e as Error).message };
        hasAccount = false;
      }
      let subs: SubaccountInfo[] = [];
      const loadSubs = async () => {
        const r = await client.call<{ subaccount_ids: number[] }>("private/get_subaccounts", { wallet: wallet.owner });
        subs = (await Promise.all(r.subaccount_ids.map((id) => client.call("private/get_subaccount", { subaccount_id: id }).then(parseSubaccount)))).filter((s): s is SubaccountInfo => !!s);
        return subs;
      };
      const before = hasAccount ? (await loadSubs()).map((s) => s.id) : [];
      const deposit = async (amount: string, target: DepositTarget) => {
        const plan = await planDeposit(p, net, p.address, route.collateral, route.managerId, amount, target);
        const gas = await estimateDepositGas(p, plan);
        const txs: string[] = [];
        for (const s of plan.steps) {
          const h = await sendStep(p, net, p.address, s);
          txs.push(h);
          await waitReceipt(p, h, { pollMs: 4000, timeoutMs: 300_000 });
        }
        return { steps: plan.steps.map((s) => s.kind), txs, gasWei: gas.totalWei, approximate: gas.approximate };
      };
      if (!before.some((id) => subs.find((s) => s.id === id)?.riskUniverse === ru)) {
        log.depositNew = await deposit("1000", { kind: "new", managerId: route.managerId, owner: wallet.owner });
        save();
        // crediting is asynchronous (~2 minutes of confirmations)
        for (let i = 0; i < 60; i++) {
          try {
            await login();
            const now = await loadSubs();
            if (now.some((s) => s.riskUniverse === ru && s.value > 0)) break;
          } catch (e) {
            if (!isNoAccount(e)) throw e;
          }
          await sleep(10_000);
        }
      }
      const main = subs.filter((s) => s.riskUniverse === ru).sort((a, b) => b.value - a.value)[0];
      expect(main, "no credited subaccount in the ETH options universe").toBeTruthy();
      log.subaccounts = subs.map((s) => ({ id: s.id, ru: s.riskUniverse, value: s.value }));
      const SUB = main!.id;
      save();

      // ---- 2. deposit to the existing subaccount, then withdraw
      const v0 = main!.value;
      log.depositExisting = await deposit("25", { kind: "existing", subaccountId: SUB, fallback: wallet.owner });
      for (let i = 0; i < 60; i++) {
        const s = parseSubaccount(await client.call("private/get_subaccount", { subaccount_id: SUB }))!;
        if (s.value >= v0 + 24.9) {
          log.creditedExisting = { before: v0, after: s.value };
          break;
        }
        await sleep(10_000);
      }
      expect(log.creditedExisting, "existing-subaccount deposit not credited in 10 minutes").toBeTruthy();
      const coll = collateralFor(universes, net, route.managerId);
      log.withdraw = await withdraw(client, wallet, { subaccountId: SUB, collateral: coll, amount: "5", recipient: wallet.owner, maxFeeUsd: "1" }, Date.now());
      save();

      // ---- 3. one-tap trading
      const handle = await registerSessionKey(client, wallet, [SUB], Date.now());
      log.sessionKey = { address: handle.address, expirySec: handle.expirySec, scopes: handle.scopes, subaccounts: handle.subaccountIds };
      const listed = parseSessionKeys(await client.call("private/session_keys", { wallet: wallet.owner }), Date.now());
      expect(listed.some((k) => k.address.toLowerCase() === handle.address.toLowerCase())).toBe(true);
      const tapper = sessionSigner(handle, wallet.owner, net);

      const inst = parseInstruments({ instruments: await client.getAllInstruments("ETH") });
      let q: SpreadQuote | null = null;
      for (const e of expiriesFor(inst, Date.now()).filter((x) => x.days >= 5 && x.days <= 30)) {
        const tk = parseTickers(await client.call("public/get_tickers", { currency: "ETH", instrument_type: "option", expiry_date: Number(e.key) }));
        const spot = spotOf(tk).spot!;
        const sel = selectSpread(inst, tk, spot, spot * 1.04, "up", e.key, Date.now());
        if (!sel.ok) continue;
        const r = quoteSpread(sel.legs, 1);
        if (r.ok && r.quote.priced === "book" && r.quote.depthOk) {
          q = r.quote;
          break;
        }
      }
      expect(q, "no quotable ETH spread").not.toBeNull();

      // dry run first: proves the session-key signatures without trading
      const dry = new ReadOnlyRpc(client);
      log.orderDebug = await debugSpread(dry, tapper, net, SUB, q!);
      expect((log.orderDebug as { ok: boolean }[]).every((d) => d.ok)).toBe(true);
      expect(dry.sent.every((m) => m !== "private/order")).toBe(true);

      const res = await placeSpread({ rpc: client, signer: tapper, net, subaccountId: SUB }, q!);
      log.open = { status: res.status, orders: [res.long, res.short].filter(Boolean).map((o) => ({ id: o!.orderId, instrument: o!.instrument, side: o!.direction, status: o!.status, filled: o!.filled, avgPrice: o!.avgPrice, fee: o!.fee, error: o!.error })) };
      save();
      expect(res.status).toBe("filled");
      await sleep(3000);
      const tk2 = parseTickers(await client.call("public/get_tickers", { currency: "ETH", instrument_type: "option", expiry_date: Number(q!.legs.long.instrument.expiryKey) }));
      const closed = await closeSpread({ rpc: client, signer: tapper, net, subaccountId: SUB }, [
        { inst: q!.legs.long.instrument, ticker: tk2[q!.legs.long.instrument.name]!, amount: q!.n },
        { inst: q!.legs.short.instrument, ticker: tk2[q!.legs.short.instrument.name]!, amount: -q!.n },
      ]);
      log.close = closed.map((o) => ({ id: o.orderId, instrument: o.instrument, side: o.direction, status: o.status, filled: o.filled, avgPrice: o.avgPrice, fee: o.fee, error: o.error }));
      save();
      for (const o of closed) expect(o.filled).toBeCloseTo(q!.n, 9);

      // kill switch: a resting order far from the market, then cancel_all
      const far = await import("../../src/net/trader.ts").then((m) =>
        m.signOrder({ inst: q!.legs.long.instrument, direction: "buy", amount: q!.amount, limitPrice: q!.legs.long.instrument.tickSize, maxFee: "10", tif: "gtc", label: "peo-rest" }, { rpc: client, signer: tapper, net, subaccountId: SUB }),
      );
      const rest = await import("../../src/net/trader.ts").then((m) => m.sendOrder(client, far));
      log.resting = { id: rest.orderId, status: rest.status, error: rest.error };
      log.cancelAll = await client.call("private/cancel_all", { subaccount_id: SUB });
      await sleep(1500);
      const afterCancel = parseSubaccount(await client.call("private/get_subaccount", { subaccount_id: SUB }))!;
      log.openOrdersAfterCancelAll = afterCancel.openOrders.length;
      expect(afterCancel.openOrders.length).toBe(0);

      // history and P&L
      await sleep(2000);
      const trades = parseTrades(await client.call("private/get_trade_history", { subaccount_id: SUB, page_size: 100 }));
      const orders = parseOrders(await client.call("private/get_order_history", { subaccount_id: SUB, page_size: 100 }));
      const cs = closedSpreads(trades);
      log.history = { trades: trades.length, orders: orders.length, closedSpreads: cs.spreads.map((s) => ({ long: s.long.instrument, short: s.short.instrument, size: s.size, pnl: s.pnl, fees: s.fees })) };
      expect(trades.length).toBeGreaterThanOrEqual(4);
      expect(cs.spreads.length).toBeGreaterThanOrEqual(1);

      // revoke (one wallet signature), then the key is forgotten
      log.revokedUntil = await revokeSessionKey(client, wallet, handle, Date.now());
      save();
    } finally {
      client.close();
      save();
      console.info("[live onboarding]", JSON.stringify(log, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    }
  });
});
