import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { NETWORKS } from "../../src/config.ts";
import { keySigner } from "../../src/net/signer.ts";
import { closeSpread, placeSpread, type Rpc } from "../../src/net/trader.ts";
import { quoteSpread } from "../../src/lib/spread.ts";
import { mkInst, mkTicker } from "./gen.ts";
import { recoverAddress } from "ethers";
import { digest, encodeTradeData } from "../../src/net/signing.ts";
import { toE18 } from "../../src/lib/units.ts";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const L = mkInst({ strike: 2500, type: "C", subId: "11" }), S = mkInst({ strike: 3000, type: "C", subId: "22" });
const q = (() => {
  const r = quoteSpread({ dir: "up", long: { instrument: L, ticker: mkTicker({ ask: 233.7, bid: 230, mark: 232 }), side: "buy" }, short: { instrument: S, ticker: mkTicker({ bid: 58.3, ask: 60, mark: 59 }), side: "sell" }, K1: 2500, K2: 3000, width: 500 }, 1000);
  if (!r.ok) throw new Error("fixture");
  return r.quote;
})();

type Behaviour = "fill" | "nofill" | "error" | "partial";
function mockRpc(plan: Behaviour[]) {
  const sent: Record<string, unknown>[] = [];
  const signer = keySigner(KEY, NETWORKS.testnet);
  const rpc: Rpc = {
    call: async <T>(method: string, params?: object): Promise<T> => {
      const p = params as Record<string, string | number | boolean>;
      if (method !== "private/order") throw new Error("unexpected " + method);
      sent.push(p);
      // every order must carry a valid signature over exactly what it says
      const inst = p.instrument_name === L.name ? L : S;
      const data = encodeTradeData({ assetAddress: inst.assetAddress, subId: inst.subId, limitPrice: String(p.limit_price), amount: String(p.amount), maxFee: String(p.max_fee), recipientId: Number(p.subaccount_id), isBid: p.direction === "buy" });
      const d = digest({ subaccountId: Number(p.subaccount_id), nonce: String(p.nonce), module: NETWORKS.testnet.tradeModule, data, expiry: Number(p.signature_expiry_sec), owner: signer.owner, signer: String(p.signer) }, NETWORKS.testnet);
      if (recoverAddress(d, String(p.signature)) !== signer.signer) throw new Error("Invalid signature");
      const b = plan[sent.length - 1] ?? "fill";
      if (b === "error") throw new Error("Order would not fully fill");
      const amt = Number(p.amount);
      const filled = b === "fill" ? amt : b === "partial" ? Math.round(amt * 50) / 100 : 0;
      // fills happen at the book (price improvement vs the slippage-capped limit)
      const lim = Number(p.limit_price);
      const book = p.direction === "buy" ? (inst === L ? 233.7 : 60) : inst === L ? 230 : 58.3;
      if (p.direction === "buy" ? lim < book : lim > book) throw new Error("limit does not cross the book");
      const px = p.time_in_force === "fok" ? book : lim;
      return {
        order: { order_id: "oid-" + sent.length, order_status: filled === amt ? "filled" : "cancelled", filled_amount: String(filled), average_price: String(filled ? px : 0) },
        trades: filled ? [{ trade_id: "t" + sent.length, trade_price: String(px), trade_amount: String(filled), trade_fee: "1.27" }] : [],
      } as T;
    },
  };
  return { rpc, sent, ctx: { rpc, signer, net: NETWORKS.testnet, subaccountId: 87139 } };
}

describe("placeSpread leg-risk protection", () => {
  it("fills both legs with fill-or-kill orders", async () => {
    const m = mockRpc(["fill", "fill"]);
    const r = await placeSpread(m.ctx, q);
    expect(r.status).toBe("filled");
    expect(m.sent.map((s) => [s.instrument_name, s.direction, s.time_in_force])).toEqual([
      [L.name, "buy", "fok"],
      [S.name, "sell", "fok"],
    ]);
    expect(r.netDebit).toBeCloseTo(q.n * q.debit, 6);
  });

  it("unwinds leg 1 immediately when leg 2 fails, with the pre-signed order", async () => {
    for (const fail of ["nofill", "error"] as const) {
      const m = mockRpc(["fill", fail, "fill"]);
      const r = await placeSpread(m.ctx, q);
      expect(r.status).toBe("unwound");
      expect(m.sent.length).toBe(3);
      expect(m.sent[2]).toMatchObject({ instrument_name: L.name, direction: "sell", time_in_force: "ioc", amount: q.amount });
      expect(r.unwind!.filled).toBe(q.n);
    }
  });

  it("does nothing more when leg 1 does not fill", async () => {
    const m = mockRpc(["nofill"]);
    expect((await placeSpread(m.ctx, q)).status).toBe("not-filled");
    expect(m.sent.length).toBe(1);
  });

  it("reports an exposed leg when the unwind only partly fills", async () => {
    const m = mockRpc(["fill", "error", "partial"]);
    const r = await placeSpread(m.ctx, q);
    expect(r.status).toBe("exposed");
    expect(r.message).toContain("close it from Portfolio");
  });

  it("whatever the exchange does, the net position left is either the full spread or flat/flagged", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom<Behaviour>("fill", "nofill", "error", "partial"), { minLength: 3, maxLength: 4 }), async (plan) => {
        const m = mockRpc(plan);
        const r = await placeSpread(m.ctx, q);
        const longNet = r.long.filled - (r.unwind?.filled ?? 0);
        const shortNet = r.short?.filled ?? 0;
        if (r.status === "filled") expect([longNet, shortNet]).toEqual([q.n, q.n]);
        if (r.status === "unwound" || r.status === "not-filled") expect(Math.abs(longNet - shortNet)).toBeLessThan(1e-9);
        if (r.status === "exposed") expect(longNet - shortNet).toBeGreaterThan(0);
        // amounts on the wire are always exact decimals on the step
        for (const s of m.sent) expect(toE18(String(s.amount)) % toE18(L.amountStep)).toBe(0n);
      }),
      { numRuns: 200 },
    );
  });

  it("closes a spread short-leg first, reduce-only", async () => {
    const m = mockRpc(["fill", "fill"]);
    const out = await closeSpread(m.ctx, [
      { inst: L, ticker: mkTicker({ bid: 200, ask: 205, mark: 202, minPrice: 1 }), amount: 3 },
      { inst: S, ticker: mkTicker({ bid: 50, ask: 52, mark: 51, maxPrice: 400 }), amount: -3 },
    ]);
    expect(out.map((o) => o.instrument)).toEqual([S.name, L.name]);
    expect(m.sent.map((s) => [s.direction, s.reduce_only])).toEqual([
      ["buy", true],
      ["sell", true],
    ]);
  });
});
