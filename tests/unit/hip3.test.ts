// Hyperliquid HIP-3 builder markets: asset-id maths, the recorded xyz dex parsed the way the app
// does, fee scaling, labels, the collateral move, and the venue end to end on the mock exchange
// (real signature recovery). Fixtures: tests/fixtures/hyperliquid/hip3-<net>.json (scripts/record-hip3.ts).
import { describe, expect, it, beforeEach } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { Wallet, SigningKey, getAddress } from "ethers";
import { FX_PAIR_NAMES, agentSendAssetAction, builderLabel, builderNote, collateralTokenWire, decodeAssetId, findDex, hip3Fees, hlAssetId, isolatedOnly, parseCategories, shortfall } from "../../src/venues/hyperliquid/hip3.ts";
import { HL_MAKER, HL_TAKER, hlDexOf, hlName, isHlPerpCoin, parseFills, parseMeta, type HlDexMeta } from "../../src/venues/hyperliquid/parse.ts";
import { orderAction, entryOrders } from "../../src/venues/hyperliquid/orders.ts";
import { recoverL1, signL1 } from "../../src/venues/hyperliquid/signing.ts";
import { createHyperliquidVenue } from "../../src/venues/hyperliquid/index.ts";
import { HL_RECORDED_AT, hlCredit, hlFetch, newHlState, type HlMockState } from "../mock/hyperliquid.ts";
import { quotePerp } from "../../src/lib/perp.ts";
import type { NetworkId } from "../../src/config.ts";

type Frame = { req: Record<string, unknown> & { req?: { coin?: string } }; res: unknown };
const fx = (net: NetworkId) => JSON.parse(readFileSync(new URL(`../fixtures/hyperliquid/hip3-${net}.json`, import.meta.url), "utf8")) as { frames: Frame[] };
const frame = (net: NetworkId, type: string, dex?: string) => fx(net).frames.find((f) => f.req.type === type && (dex === undefined || f.req.dex === dex))!.res;

function meta(net: NetworkId, fees = { taker: HL_TAKER, maker: HL_MAKER }): HlDexMeta {
  const d = findDex(frame(net, "perpDexs"), "xyz")!;
  return { name: "xyz", index: d.index, categories: parseCategories(frame(net, "perpConciseAnnotations")), builder: (lev, iso) => ({ dex: "xyz", label: builderLabel(net, d), note: builderNote(net, d, lev, iso) }), fees: (s, g) => hip3Fees(fees, s, g) };
}

describe("HIP-3 asset ids (docs: 100000 + perp_dex_index × 10000 + index_in_meta)", () => {
  it("matches the docs' example and the main dex", () => {
    expect(hlAssetId(1, 0)).toBe(110000); // docs: test:ABC on testnet, dex 1, index 0
    expect(hlAssetId(0, 0)).toBe(0); // BTC on mainnet
    expect(hlAssetId(0, 159)).toBe(159);
    expect(hlAssetId(1, 3)).toBe(110003);
    expect(hlAssetId(65, 4)).toBe(750004);
    expect(hlAssetId(1, 9999)).toBe(119999);
  });
  it("refuses ids that would collide", () => {
    expect(() => hlAssetId(1, 10000)).toThrow();
    expect(() => hlAssetId(-1, 0)).toThrow();
    expect(() => hlAssetId(1, 1.5)).toThrow();
  });
  it("decodes back (property), never as spot", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 400 }), fc.integer({ min: 0, max: 9999 }), (d, i) => {
        expect(decodeAssetId(hlAssetId(d, i))).toEqual({ dexIndex: d, index: i });
      }));
    fc.assert(fc.property(fc.integer({ min: 0, max: 9999 }), (i) => {
        expect(decodeAssetId(i)).toEqual({ dexIndex: 0, index: i });
      }));
    expect(decodeAssetId(10000)).toBeNull(); // spot PURR/USDC
    expect(decodeAssetId(10107)).toBeNull(); // spot HYPE
  });
});

describe("the recorded xyz dex", () => {
  it("is dex 1 on mainnet (trade.xyz's deployer) and dex 65 on testnet (another deployer)", () => {
    const m = findDex(frame("mainnet", "perpDexs"), "xyz")!;
    const t = findDex(frame("testnet", "perpDexs"), "xyz")!;
    expect(m.index).toBe(1);
    expect(m.deployer).toBe("0x88806a71d74ad0a510b350545c9ae490912f0888");
    expect(t.index).toBe(65);
    expect(t.deployer).not.toBe(m.deployer);
    expect(builderLabel("mainnet", m)).toBe("xyz · trade.xyz builder market");
    expect(builderLabel("testnet", t)).toMatch(/^xyz · builder market \(deployer 0x7770…0777, testnet\)$/);
    expect(builderNote("mainnet", m, 25, true)).toMatch(/trade\.xyz.*24\/7.*25×.*allows isolated margin only.*kept apart/);
    expect(builderNote("mainnet", m, 20, false)).toMatch(/20×.*this app trades it with isolated margin/);
  });

  for (const net of ["mainnet", "testnet"] as const) {
    it(`${net}: asset ids, categories, display names, isolated-only and fees`, () => {
      const raw = frame(net, "metaAndAssetCtxs", "xyz") as [{ universe: Record<string, unknown>[] }, unknown[]];
      const dm = meta(net);
      const { markets, tickers } = parseMeta(raw, undefined, dm);
      expect(markets.length).toBeGreaterThan(10);
      const uni = raw[0].universe;
      for (const m of markets) {
        const i = uni.findIndex((u) => u.name === m.asset.coin);
        expect(m.asset.index).toBe(hlAssetId(dm.index, i)); // the coin's own position in the dex meta
        expect(m.name).toBe(`${m.asset.coin}-PERP`);
        expect(uni[i]!.isDelisted).not.toBe(true);
        expect(m.category).toBe(dm.categories.get(m.asset.coin)!.category);
        expect(m.builder!.dex).toBe("xyz");
        expect(m.asset.onlyIsolated).toBe(isolatedOnly(uni[i]!));
        expect(m.builder!.isolatedOnly).toBe(m.asset.onlyIsolated);
        expect(m.asset.dex).toBe("xyz");
        // fees: 2× (deployerFeeScale 1.0), growth mode 0.1× of that
        const growth = uni[i]!.growthMode === "enabled";
        expect(m.takerFeeRate).toBeCloseTo(HL_TAKER * 2 * (growth ? 0.1 : 1), 12);
      }
      const gold = markets.find((m) => m.asset.coin === "xyz:GOLD")!;
      expect(gold.category).toBe("commodities");
      expect(gold.currency).toBe("GOLD");
      expect(tickers[gold.name]!.mark).toBeGreaterThan(1000);
      const cats = new Set(markets.map((m) => m.category));
      for (const c of ["commodities", "stocks", "indices", "fx"]) expect(cats.has(c as never)).toBe(true);
      expect(cats.has("crypto")).toBe(false); // xyz lists no crypto
      // a yen market reads as USD/JPY (its price is yen per dollar), never as "JPY goes up"
      const jpy = markets.find((m) => m.asset.coin === "xyz:JPY")!;
      expect(jpy.currency).toBe("USDJPY");
      expect(jpy.category).toBe("fx");
      expect(jpy.asset.onlyIsolated).toBe(true);
      // busiest first
      const vols = markets.map((m) => tickers[m.name]?.volume24h ?? 0);
      expect([...vols].sort((a, b) => b - a)).toEqual(vols);
    });
  }

  it("mainnet specifics: GOLD (no growth mode) 0.09% taker, TSLA (growth mode) 0.009%, S&P500 listed as an index", () => {
    const { markets } = parseMeta(frame("mainnet", "metaAndAssetCtxs", "xyz"), undefined, meta("mainnet"));
    const by = (c: string) => markets.find((m) => m.asset.coin === c)!;
    expect(by("xyz:GOLD").takerFeeRate).toBeCloseTo(0.0009, 12);
    expect(by("xyz:GOLD").makerFeeRate).toBeCloseTo(0.0003, 12);
    expect(by("xyz:TSLA").takerFeeRate).toBeCloseTo(0.00009, 12);
    expect(by("xyz:SP500").category).toBe("indices");
    expect(by("xyz:SP500").currency).toBe("S&P500");
    expect(by("xyz:GOLD").asset.index).toBe(110003);
    expect(markets.some((m) => m.asset.coin === "xyz:URANIUM")).toBe(false); // delisted
  });

  it("keeps out what is not ours: other dexes' coins, unannotated or pre-IPO coins", () => {
    const raw = [{ universe: [{ name: "xyz:GOLD", szDecimals: 4, maxLeverage: 25 }, { name: "flx:GOLD", szDecimals: 4, maxLeverage: 25 }, { name: "xyz:NOPE", szDecimals: 2, maxLeverage: 10 }, { name: "xyz:OAI", szDecimals: 2, maxLeverage: 5 }] }, [{ markPx: "4100" }, { markPx: "4100" }, { markPx: "1" }, { markPx: "1" }]];
    const dm = { ...meta("mainnet"), categories: parseCategories([["xyz:GOLD", { category: "commodities" }], ["xyz:OAI", { category: "preipo" }]]) };
    const { markets } = parseMeta(raw, undefined, dm);
    expect(markets.map((m) => m.asset.coin)).toEqual(["xyz:GOLD"]);
  });
});

describe("annotations, fees, names", () => {
  it("parses both annotation shapes; free-text categories map to ours; FX names fall back to the pair", () => {
    const m = parseCategories([["xyz:A", "stocks"], ["xyz:B", { category: "FX" }], ["xyz:JPY", { category: "fx" }], ["xyz:C", { category: "rates" }], ["xyz:D", { category: "stock", displayName: "Intel" }], ["bad"], null]);
    expect(m.get("xyz:A")).toEqual({ category: "stocks" });
    expect(m.get("xyz:B")).toEqual({ category: "fx" });
    expect(m.get("xyz:JPY")).toEqual({ category: "fx", displayName: FX_PAIR_NAMES["xyz:JPY"] });
    expect(m.has("xyz:C")).toBe(false);
    expect(m.get("xyz:D")).toEqual({ category: "stocks", displayName: "Intel" });
  });
  it("HIP-3 fee scale per the docs' feeRates()", () => {
    const base = { taker: 0.00045, maker: 0.00015 };
    expect(hip3Fees(base, 1, false).taker).toBeCloseTo(0.0009, 12);
    expect(hip3Fees(base, 0.5, false).taker).toBeCloseTo(0.000675, 12); // scale + 1
    expect(hip3Fees(base, 2, false).taker).toBeCloseTo(0.0018, 12); // scale × 2
    expect(hip3Fees(base, 1, true).taker).toBeCloseTo(0.00009, 12);
    expect(hip3Fees({ taker: 0.0003, maker: -0.00002 }, 1, false).maker).toBeCloseTo(-0.00002, 12); // rebates not scaled up
  });
  it("names: builder coins keep their case and dex prefix", () => {
    expect(hlName("xyz:GOLD")).toBe("xyz:GOLD-PERP");
    expect(hlName("eth")).toBe("ETH-PERP");
    expect(hlDexOf("xyz:GOLD-PERP")).toBe("xyz");
    expect(hlDexOf("ETH-PERP")).toBe("");
    expect(isHlPerpCoin("xyz:GOLD")).toBe(true);
    expect(isHlPerpCoin("@107")).toBe(false);
    expect(isHlPerpCoin("PURR/USDC")).toBe(false);
    const f = parseFills([{ coin: "xyz:GOLD", px: "4100", sz: "0.01", side: "B", time: 1, fee: "0.03", tid: 1, oid: 2, closedPnl: "0" }, { coin: "@107", px: "40", sz: "1", side: "B", time: 2 }]);
    expect(f.map((x) => x.instrument)).toEqual(["xyz:GOLD-PERP"]);
  });
});

describe("collateral move (agentSendAsset)", () => {
  it("token wire from spotMeta: USDC with its token id on each network", () => {
    expect(collateralTokenWire(frame("mainnet", "spotMeta"), 0)).toBe("USDC:0x6d1e7cde53ba9467b783cb7c530ce054");
    expect(collateralTokenWire(frame("testnet", "spotMeta"), 0)).toBe("USDC:0xeb62eee3685fc4c43992febcd9e75443");
    expect(collateralTokenWire({ tokens: [] }, 0)).toBeNull();
  });
  it("action fields in the docs' order; the signature recovers to the signing agent", () => {
    const a = agentSendAssetAction({ destination: "0xabc", sourceDex: "", destinationDex: "xyz", token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054", amount: "12.34", nonce: 1791400000000 });
    expect(Object.keys(a)).toEqual(["type", "destination", "sourceDex", "destinationDex", "token", "amount", "fromSubAccount", "nonce"]);
    const k = Wallet.createRandom();
    for (const mainnet of [true, false]) {
      const sig = signL1(new SigningKey(k.privateKey), a, a.nonce, mainnet);
      expect(getAddress(recoverL1(a, sig, a.nonce, mainnet, null, null))).toBe(k.address);
    }
  });
  it("shortfall rounds up to the cent and is null when covered", () => {
    expect(shortfall(10, 20)).toBeNull();
    expect(shortfall(10.001, 0)).toBe("10.01");
    expect(shortfall(33.3333, 3.3333)).toBe("30.00");
    fc.assert(fc.property(fc.double({ min: 0.01, max: 1e6, noNaN: true }), fc.double({ min: 0, max: 1e6, noNaN: true }), (need, free) => {
      const s = shortfall(need, free);
      if (need <= free) expect(s).toBeNull();
      else expect(Number(s) + free).toBeGreaterThanOrEqual(need - 1e-6);
    }));
  });
  it("builder orders carry the builder asset id in the signed wire", () => {
    const { markets } = parseMeta(frame("mainnet", "metaAndAssetCtxs", "xyz"), undefined, meta("mainnet"));
    const gold = markets.find((m) => m.asset.coin === "xyz:GOLD")!;
    const { wires } = entryOrders(gold.asset, { side: "buy", amount: "0.01", limitPrice: "4200", tif: "ioc", takeProfit: null, stopLoss: null });
    expect(wires[0]!.a).toBe(110003);
    const act = orderAction(wires, "na");
    const k = Wallet.createRandom();
    const sig = signL1(new SigningKey(k.privateKey), act, 1, true);
    expect(getAddress(recoverL1(act, sig, 1, true, null, null))).toBe(k.address);
  });
});

// ---- the venue on the mock exchange ----
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // Hardhat #1, test-only
const w = new Wallet(KEY);
const wallet = {
  request: async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [w.address];
    if (method === "eth_chainId") return "0xa4b1";
    if (method === "eth_signTypedData_v4") {
      const td = JSON.parse(String((params as unknown[])[1]));
      const { EIP712Domain: _d, ...types } = td.types;
      return w.signTypedData(td.domain, types, td.message);
    }
    throw new Error("unsupported " + method);
  },
};
let st: HlMockState;
const now = HL_RECORDED_AT + 60_000;
const venue = () => createHyperliquidVenue({ net: () => "mainnet", now: () => now, eth: () => wallet, fetch: hlFetch(st), sheet: { open: () => {}, close: () => {} }, changed: () => {} });

describe("Hyperliquid venue with the xyz builder dex (mock exchange)", () => {
  beforeEach(() => {
    st = newHlState("mainnet", () => now);
    hlCredit(st, w.address, 1000);
  });

  it("lists Hyperliquid's own crypto perps first, then xyz builder markets with categories", async () => {
    const ms = await venue().markets();
    expect(ms[0]!.name).toBe("ETH-PERP");
    expect(ms.filter((m) => !m.builder).every((m) => (m.category ?? "crypto") === "crypto")).toBe(true);
    const gold = ms.find((m) => m.name === "xyz:GOLD-PERP")!;
    expect(gold.builder!.label).toBe("xyz · trade.xyz builder market");
    expect(gold.category).toBe("commodities");
  });

  it("without builder dexes on the network: crypto only, no categories", async () => {
    st.noHip3 = true;
    const ms = await venue().markets();
    expect(ms.some((m) => m.builder)).toBe(false);
    expect(new Set(ms.map((m) => m.category ?? "crypto"))).toEqual(new Set(["crypto"]));
  });

  it("isolated-only builder market: no cross mode offered; order moves the shortfall to xyz, sets isolated leverage, fills", async () => {
    const v = venue();
    await v.connect!();
    const ms = await v.markets();
    const name = "xyz:EUR-PERP";
    v.focus!(name);
    expect(v.marginModes).toEqual(["isolated"]);
    expect(v.marginMode!()).toBe("isolated");
    const tk = await v.tickers();
    const inst = ms.find((m) => m.name === name)!;
    const acct = v.selectedAccount(name)!;
    expect(acct.initialMargin).toBeCloseTo(1000, 6); // main balance can be moved over
    expect(v.accountScope(name)).toMatch(/xyz dex/);
    const r = quotePerp({ inst, ticker: tk[name]!, dir: "long", risk: 50, leverage: 5, orderType: "market", slippage: v.slippage, leverageCap: 10, headroomMM: null, headroomIM: acct.initialMargin, existing: 0 });
    if (!r.ok) throw new Error(r.reason);
    const check = await v.marginCheck(acct, r.quote);
    expect(check.valid).toBe(true);
    const steps: string[] = [];
    const out = await v.open(acct, r.quote, (s) => steps.push(s));
    expect(out.entry.status).toBe("filled");
    expect(steps.some((s) => /Moving \d+\.\d\d USDC from your main Hyperliquid balance to the xyz dex/.test(s))).toBe(true);
    const types = st.log.filter((l) => l.ok).map((l) => l.type);
    expect(types.indexOf("agentSendAsset")).toBeLessThan(types.indexOf("updateLeverage"));
    expect(types.indexOf("updateLeverage")).toBeLessThan(types.indexOf("order"));
    expect(st.lev[w.address]!["xyz:EUR"]).toEqual({ type: "isolated", value: 5 });
    const moved = Number(/→xyz ([\d.]+)/.exec(st.log.find((l) => l.detail?.includes("→xyz"))!.detail!)![1]);
    expect(moved).toBeGreaterThanOrEqual(r.quote.putIn);
    expect(moved).toBeLessThan(r.quote.putIn * 1.05 + 1);
    // the position shows in the account, under its builder name
    const a2 = v.selectedAccount(name)!;
    expect(a2.positions.map((p) => p.instrument)).toContain(name);
    // closing works on the builder asset id
    const c = await v.close(a2, name, a2.positions.find((p) => p.instrument === name)!.amount, 1);
    expect(c.status).toBe("filled");
  });

  it("refuses with plain words when neither the xyz dex nor the main balance can cover the margin", async () => {
    st.balance[getAddress(w.address)] = 3;
    const v = venue();
    await v.connect!();
    const ms = await v.markets();
    const name = "xyz:GOLD-PERP";
    v.focus!(name);
    const tk = await v.tickers();
    const r = quotePerp({ inst: ms.find((m) => m.name === name)!, ticker: tk[name]!, dir: "long", risk: 20, leverage: 2, orderType: "market", slippage: v.slippage, leverageCap: 10, headroomMM: null, headroomIM: null, existing: 0 });
    if (!r.ok) throw new Error(r.reason);
    expect((await v.marginCheck(v.selectedAccount(name)!, r.quote)).valid).toBe(false);
    await expect(v.open(v.selectedAccount(name)!, r.quote)).rejects.toThrow(/builder market with its own collateral/);
    expect(st.log.some((l) => l.type === "order" && l.ok)).toBe(false);
  });
});
