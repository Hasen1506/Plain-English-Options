// Opt-in live smoke test against Derive TESTNET (never mainnet):
//   DERIVE_PRIVATE_KEY=0x… [DERIVE_WALLET=0x…] [DERIVE_SUBACCOUNT_ID=…] npm run test:live
// Without DERIVE_SUBACCOUNT_ID it uses the wallet's richest subaccount in the ETH options universe.
// Logs in, places the smallest ETH bull call spread the exchange allows through
// the same code the app uses, checks the fills and positions, then closes it.
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { NETWORKS } from "../../src/config.ts";
import { DeriveClient } from "../../src/net/client.ts";
import { keySigner } from "../../src/net/signer.ts";
import { closeSpread, placeSpread, preTradeCheck } from "../../src/net/trader.ts";
import { parseInstruments, parseSubaccount, parseTickers, type SubaccountInfo } from "../../src/lib/ticker.ts";
import { selectSpread, quoteSpread } from "../../src/lib/spread.ts";
import { expiriesFor, spotOf } from "../../src/lib/market.ts";

const KEY = process.env.DERIVE_PRIVATE_KEY;
let SUB = Number(process.env.DERIVE_SUBACCOUNT_ID ?? 0);
const net = NETWORKS.testnet; // hard-wired: this test never touches mainnet

describe.skipIf(!KEY)("live testnet smoke", () => {
  it("places, verifies and closes a minimum-size spread", async () => {
    const signer = keySigner(KEY!, net, process.env.DERIVE_WALLET);
    const client = new DeriveClient(net.wsUrl, {
      timeoutMs: 20_000,
      onOpen: async (c) => {
        const ts = String(Date.now());
        await c.callRaw("public/login", { wallet: signer.owner, timestamp: ts, signature: await signer.signLogin(ts) });
      },
    });
    client.connect();
    const log: Record<string, unknown> = { at: new Date().toISOString(), network: net.id };
    try {
      if (!SUB) {
        const ids = (await client.call<{ subaccount_ids: number[] }>("private/get_subaccounts", { wallet: signer.owner })).subaccount_ids;
        const subs = (await Promise.all(ids.map((id) => client.call("private/get_subaccount", { subaccount_id: id }).then(parseSubaccount)))).filter((s): s is SubaccountInfo => !!s && s.riskUniverse === 1);
        SUB = subs.sort((a, b) => b.value - a.value)[0]?.id ?? 0;
      }
      log.subaccount = SUB;
      expect(SUB, "no RU1 subaccount").toBeGreaterThan(0);
      const sub = async () => parseSubaccount(await client.call("private/get_subaccount", { subaccount_id: SUB }))!;
      const before = await sub();
      expect(before.riskUniverse).toBe(1);
      log.balanceBefore = before.value;

      const now = Date.now();
      const inst = parseInstruments({ instruments: await client.getAllInstruments("ETH") });
      // a weekly 5–20 days out: liquid on testnet and not about to expire
      const ex = expiriesFor(inst, now).filter((e) => e.days >= 5 && e.days <= 20);
      expect(ex.length).toBeGreaterThan(0);
      let quote = null;
      for (const e of ex) {
        const tk = parseTickers(await client.call("public/get_tickers", { currency: "ETH", instrument_type: "option", expiry_date: Number(e.key) }));
        const spot = spotOf(tk).spot!;
        const sel = selectSpread(inst, tk, spot, spot * 1.04, "up", e.key, now);
        if (!sel.ok) continue;
        const q = quoteSpread(sel.legs, 1); // $1 wanted → the exchange minimum size
        if (q.ok && q.quote.priced === "book" && q.quote.depthOk) {
          quote = q.quote;
          break;
        }
      }
      expect(quote, "no quotable ETH spread with a live book").not.toBeNull();
      const q = quote!;
      log.legs = [q.legs.long.instrument.name, q.legs.short.instrument.name];
      log.amount = q.amount;
      log.quoted = { longAsk: q.longPrice, shortBid: q.shortPrice, debit: q.debit, estFees: q.fees, maxLoss: q.maxLoss };

      const pre = await preTradeCheck(client, SUB, q);
      log.preTrade = pre;
      expect(pre.valid).toBe(true);

      const res = await placeSpread({ rpc: client, signer, net, subaccountId: SUB }, q);
      log.open = { status: res.status, message: res.message, fees: res.fees, netDebit: res.netDebit, orders: [res.long, res.short, res.unwind].filter(Boolean).map((o) => ({ id: o!.orderId, instrument: o!.instrument, side: o!.direction, status: o!.status, filled: o!.filled, avgPrice: o!.avgPrice, fee: o!.fee, fills: o!.fills, error: o!.error })) };
      expect(res.status).toBe("filled");
      expect(res.long.filled).toBeCloseTo(q.n, 9);
      expect(res.short!.filled).toBeCloseTo(q.n, 9);

      const delta = (s: SubaccountInfo, name: string) => s.positions.find((p) => p.instrument === name)?.amount ?? 0;
      // positions update a moment after the fills are reported: poll briefly
      const settle = async (ok: (s: SubaccountInfo) => boolean) => {
        let s = await sub();
        for (let i = 0; i < 20 && !ok(s); i++) {
          await new Promise((r) => setTimeout(r, 750));
          s = await sub();
        }
        return s;
      };
      const opened = (s: SubaccountInfo) => Math.abs(delta(s, q.legs.long.instrument.name) - delta(before, q.legs.long.instrument.name) - q.n) < 1e-9;
      const mid = await settle(opened);
      expect(delta(mid, q.legs.long.instrument.name) - delta(before, q.legs.long.instrument.name)).toBeCloseTo(q.n, 9);
      expect(delta(mid, q.legs.short.instrument.name) - delta(before, q.legs.short.instrument.name)).toBeCloseTo(-q.n, 9);

      // close: fresh tickers, short leg bought back first
      const tk2 = parseTickers(await client.call("public/get_tickers", { currency: "ETH", instrument_type: "option", expiry_date: Number(q.legs.long.instrument.expiryKey) }));
      const closed = await closeSpread({ rpc: client, signer, net, subaccountId: SUB }, [
        { inst: q.legs.long.instrument, ticker: tk2[q.legs.long.instrument.name]!, amount: q.n },
        { inst: q.legs.short.instrument, ticker: tk2[q.legs.short.instrument.name]!, amount: -q.n },
      ]);
      log.close = closed.map((o) => ({ id: o.orderId, instrument: o.instrument, side: o.direction, status: o.status, filled: o.filled, avgPrice: o.avgPrice, fee: o.fee, error: o.error }));
      for (const o of closed) expect(o.filled).toBeCloseTo(q.n, 9);

      const after = await settle((s) => Math.abs(delta(s, q.legs.long.instrument.name) - delta(before, q.legs.long.instrument.name)) < 1e-9 && Math.abs(delta(s, q.legs.short.instrument.name) - delta(before, q.legs.short.instrument.name)) < 1e-9);
      expect(delta(after, q.legs.long.instrument.name)).toBeCloseTo(delta(before, q.legs.long.instrument.name), 9);
      expect(delta(after, q.legs.short.instrument.name)).toBeCloseTo(delta(before, q.legs.short.instrument.name), 9);
      log.balanceAfter = after.value;
    } finally {
      client.close();
      mkdirSync("test-results", { recursive: true });
      writeFileSync("test-results/live-smoke.json", JSON.stringify(log, null, 2));
      console.info("[live]", JSON.stringify(log, null, 2));
    }
  });
});
