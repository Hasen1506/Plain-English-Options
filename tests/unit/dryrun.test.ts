import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { recoverAddress } from "ethers";
import { NETWORKS } from "../../src/config.ts";
import { keySigner } from "../../src/net/signer.ts";
import { DryRunViolation, NEVER_IN_DRY_RUN, READ_ONLY_METHODS, ReadOnlyRpc, debugSpread } from "../../src/net/dryrun.ts";
import { checkMainnet } from "../../scripts/check-mainnet-lib.ts";
import { quoteSpread, selectSpread } from "../../src/lib/spread.ts";
import { MAINNET_AT as NOW, mainnetInstruments, mainnetTickers } from "./mainnet-fixture.ts";
import { spotOf } from "../../src/lib/market.ts";

function mainnetQuote() {
  const inst = mainnetInstruments("BTC").parsed;
  for (const e of mainnetTickers("BTC")) {
    const spot = spotOf(e.tickers).spot!;
    const sel = selectSpread(inst, e.tickers, spot, spot * 1.03, "up", e.expiry, NOW);
    if (!sel.ok) continue;
    const q = quoteSpread(sel.legs, 50);
    if (q.ok) return q.quote;
  }
  throw new Error("no mainnet quote in fixture");
}

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // Hardhat #1, test-only

function fakeExchange(net = NETWORKS.mainnet) {
  const calls: string[] = [];
  const rpc = {
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push(method);
      if (method === "private/order") throw new Error("A REAL ORDER WAS SENT");
      if (method === "private/order_debug") {
        // the exchange rebuilds the digest from the wire params; we echo what a correct server would
        return { typed_data_hash: params.__digest ?? null, recovered_signer: params.signer, expected_signer: params.signer, domain_separator: net.domainSeparator } as T;
      }
      return {} as T;
    },
  };
  return { rpc, calls };
}

describe("dry run can never trade", () => {
  it("the allowlist contains no order-placing, withdrawing or key-changing method", () => {
    for (const m of NEVER_IN_DRY_RUN) expect(READ_ONLY_METHODS.has(m)).toBe(false);
    expect(READ_ONLY_METHODS.has("private/order_debug")).toBe(true);
  });

  it("ReadOnlyRpc refuses private/order (and every other non-allowlisted method) before it reaches the socket", async () => {
    const { rpc, calls } = fakeExchange();
    const ro = new ReadOnlyRpc(rpc);
    for (const m of [...NEVER_IN_DRY_RUN, "private/cancel_all", "private/cancel", "private/transfer_position", "made/up"]) {
      await expect(ro.call(m, {})).rejects.toBeInstanceOf(DryRunViolation);
    }
    expect(calls).toEqual([]);
  });

  it("property: whatever method a caller tries, only allowlisted ones are forwarded and private/order never is", async () => {
    const methods = [...READ_ONLY_METHODS, ...NEVER_IN_DRY_RUN, "private/cancel_all", "public/x"];
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom(...methods), { maxLength: 30 }), async (seq) => {
        const { rpc, calls } = fakeExchange();
        const ro = new ReadOnlyRpc(rpc);
        for (const m of seq) await ro.call(m, {}).catch(() => {});
        return !calls.includes("private/order") && calls.every((m) => READ_ONLY_METHODS.has(m));
      }),
      { numRuns: 300 },
    );
  });

  it("debugSpread signs both legs, asks order_debug and compares digests; no private/order", async () => {
    const net = NETWORKS.mainnet;
    const signer = keySigner(KEY, net);
    const q = { quote: mainnetQuote() };
    const seen: Record<string, unknown>[] = [];
    const rpc = {
      async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        if (method !== "private/order_debug") throw new Error("unexpected " + method);
        seen.push(params);
        return { typed_data_hash: "0xdead", recovered_signer: params.signer, domain_separator: net.domainSeparator } as T;
      },
    };
    const ro = new ReadOnlyRpc(rpc);
    const r = await debugSpread(ro, signer, net, 7, q.quote);
    expect(r).toHaveLength(2);
    expect(ro.sent).toEqual(["private/order_debug", "private/order_debug"]);
    // the server hash differs from ours, so the report must say not ok (no false green)
    expect(r.every((x) => !x.ok && x.exchangeHash === "0xdead")).toBe(true);
    expect(recoverAddress(r[0]!.ourDigest, String(seen[0]!.signature))).toBe(signer.signer);
  });

  it("checkMainnet (the npm run check:mainnet core) only uses read-only methods and never private/order", async () => {
    const calls: string[] = [];
    const rawInst = mainnetInstruments("ETH").raw;
    const tk = mainnetTickers("ETH");
    type Fr = { method: string; params: Record<string, unknown>; result: unknown };
    const perpFx = (await import("../fixtures/perps-mainnet.json", { with: { type: "json" } })).default.frames as { method: string; params: Record<string, unknown>; result: any }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    const fxTickers = ((await import("../fixtures/mainnet-public.json", { with: { type: "json" } })).default.frames as Fr[]).filter((f) => f.method === "public/get_tickers");
    const inner = {
      async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        calls.push(method);
        if (method === "private/order") throw new Error("A REAL ORDER WAS SENT");
        if (method === "private/get_subaccount") return { subaccount_id: params.subaccount_id, risk_universe_id: 1, subaccount_value: "100", positions: [], open_orders: [] } as T;
        if (method === "public/get_all_instruments") return { instruments: rawInst, pagination: { num_pages: 1 } } as T;
        if (method === "public/get_tickers") return (fxTickers.find((f) => f.params.currency === "ETH" && String(f.params.expiry_date) === String(params.expiry_date))?.result ?? { tickers: {} }) as T;
        if (method === "public/get_risk_universes") return [{ risk_universe_id: 1, managers: [{ manager_id: 1, margin_type: "SM", instruments: ["ETH-OPTION"], collaterals: [] }] }] as T;
        if (method === "private/order_debug") return { typed_data_hash: "0x00", recovered_signer: params.signer, domain_separator: NETWORKS.mainnet.domainSeparator } as T;
        if (method === "public/get_instrument") return perpFx.find((f) => f.method === "public/get_all_instruments")!.result.instruments.find((i: { instrument_name: string }) => i.instrument_name === params.instrument_name) as T;
        if (method === "public/get_ticker") return perpFx.find((f) => f.method === "public/get_ticker" && f.params.instrument_name === params.instrument_name)!.result as T;
        if (method === "private/get_margin") return { is_valid_trade: true } as T;
        return {} as T;
      },
    };
    const report = await checkMainnet({ rpc: new ReadOnlyRpc(inner), signer: keySigner(KEY, NETWORKS.mainnet), subaccountId: 5, now: NOW });
    expect(calls).not.toContain("private/order");
    expect(calls.every((m) => READ_ONLY_METHODS.has(m))).toBe(true);
    expect(calls).toContain("private/order_debug");
    expect(report.subaccount.riskUniverse).toBe(1);
    expect(report.rightUniverse).toBe(true);
    expect(tk.length).toBeGreaterThan(0);
    // perps: the smallest ETH-PERP market and post-only orders, signed and only debugged
    expect(report.perps!.instrument).toBe("ETH-PERP");
    expect(calls.filter((m) => m === "private/order_debug").length).toBe(4);
    expect(report.perps!.margin!.valid).toBe(true);
  });

  it("checkMainnet refuses a raw (unguarded) connection", async () => {
    await expect(checkMainnet({ rpc: { call: async () => ({}) as never } as never, signer: keySigner(KEY, NETWORKS.mainnet), subaccountId: 1, now: NOW })).rejects.toThrow(/ReadOnlyRpc/);
  });
});

describe("check:mainnet script source", () => {
  it("never names private/order, never imports the order senders, and wraps the client in ReadOnlyRpc", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["scripts/check-mainnet.ts", "scripts/check-mainnet-lib.ts"]) {
      const src = readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, "");
      expect(src).not.toMatch(/["'`]private\/order["'`]/);
      expect(src).not.toMatch(/\b(sendOrder|placeSpread|closeSpread|closePosition|openPerp|closePerp|flipPerp|closeAll|cancelEverything)\b/);
    }
    const cli = readFileSync("scripts/check-mainnet.ts", "utf8");
    expect(cli).toMatch(/new ReadOnlyRpc\(client\)/);
    expect(cli).toMatch(/checkMainnet\(\{ rpc: ro/);
  });
});
