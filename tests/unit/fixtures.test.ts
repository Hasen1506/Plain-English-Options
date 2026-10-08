// The recorded testnet frames must parse completely with the production parsers.
import { describe, expect, it } from "vitest";
import pub from "../fixtures/testnet-public.json" with { type: "json" };
import priv from "../fixtures/testnet-private.json" with { type: "json" };
import { parseCurrencies, parseInstruments, parseSubaccount, parseTicker, parseTickers } from "../../src/lib/ticker.ts";
import { expiriesFor, liveQuote } from "../../src/lib/market.ts";
import { initialState, reduce } from "../../src/lib/state.ts";

type Frame = { method: string; params: Record<string, unknown>; result: unknown };
const frames = pub.frames as Frame[];
const find = (m: string, p: (f: Frame) => boolean = () => true) => frames.find((f) => f.method === m && p(f))!;

describe("recorded v3 frames", () => {
  it("instruments and tickers parse without loss", () => {
    const inst = find("public/get_all_instruments", (f) => f.params.currency === "ETH");
    const raw = (inst.result as { instruments: unknown[] }).instruments;
    expect(parseInstruments(inst.result).length).toBe(raw.length);
    for (const f of frames.filter((x) => x.method === "public/get_tickers")) {
      const n = Object.keys((f.result as { tickers: object }).tickers).length;
      expect(Object.keys(parseTickers(f.result)).length).toBe(n);
    }
  });
  it("perp tickers carry a 24h change fraction", () => {
    const t = parseTicker(find("public/get_ticker", (f) => f.params.instrument_name === "ETH-PERP").result)!;
    expect(t.change24h).not.toBeNull();
    expect(Math.abs(t.change24h!)).toBeLessThan(1);
  });
  it("currencies map assets to risk universes (ETH/BTC = 1, HYPE = 2, ADA = 3)", () => {
    const c = parseCurrencies(find("public/get_all_currencies").result);
    expect(c.ETH!.riskUniverse).toBe(1);
    expect(c.BTC!.riskUniverse).toBe(1);
    expect(c.HYPE!.riskUniverse).toBe(2);
    expect(c.ADA!.riskUniverse).toBe(3);
  });
  it("a live quote can be built from the recorded ETH chain", () => {
    const now = pub.recordedAt;
    const inst = parseInstruments(find("public/get_all_instruments", (f) => f.params.currency === "ETH").result);
    const ex = expiriesFor(inst, now);
    expect(ex.length).toBeGreaterThan(0);
    let s = reduce(initialState(), { type: "expiries", list: ex.map((e) => ({ key: e.key, days: e.days })) });
    const tk = parseTickers(find("public/get_tickers", (f) => f.params.currency === "ETH" && String(f.params.expiry_date) === s.expiryKey).result);
    s = reduce(s, { type: "spot", spot: Object.values(tk)[0]!.index });
    const q = liveQuote(s, inst, tk, ex.find((e) => e.key === s.expiryKey)!.expiryMs, now);
    expect(q.fail).toBeNull();
    expect(q.quote!.priced).toBe("book");
    expect(q.probability).toBeGreaterThan(0);
    expect(q.probability).toBeLessThan(1);
  });
  it("subaccounts parse with their risk universe", () => {
    const subs = (priv.frames as Frame[]).filter((f) => f.method === "private/get_subaccount").map((f) => parseSubaccount(f.result)!);
    expect(subs.find((s) => s.id === 87139)!.riskUniverse).toBe(1);
    expect(subs.find((s) => s.id === 87138)!.riskUniverse).toBe(0);
  });
});
