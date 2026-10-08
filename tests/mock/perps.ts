// Perp side of the mock exchange: recorded perp instruments/tickers per
// network (tests/fixtures/perps-<net>.json), and the margin model the mock uses
// (standard manager: im/mm fraction of notional, net margin = value − requirement).

import { readFileSync } from "node:fs";
import { parsePerpInstruments, parsePerpTickers, type PerpInstrument, type PerpTicker } from "../../src/lib/perp.ts";

export type NetId = "testnet" | "mainnet";
type Frame = { method: string; params: Record<string, unknown>; result: unknown };

export interface PerpMarket {
  recordedAt: number;
  frames: Frame[];
  inst: Map<string, { raw: Record<string, unknown>; inst: PerpInstrument }>;
  tk: Map<string, PerpTicker>;
  rawTk: Map<string, unknown>;
}

function load(net: NetId): PerpMarket {
  const fx = JSON.parse(readFileSync(new URL(`../fixtures/perps-${net}.json`, import.meta.url), "utf8")) as { recordedAt: number; frames: Frame[] };
  const instFrame = fx.frames.find((f) => f.method === "public/get_all_instruments")!;
  const raws = (instFrame.result as { instruments: Record<string, unknown>[] }).instruments;
  const parsed = parsePerpInstruments(instFrame.result);
  const inst = new Map<string, { raw: Record<string, unknown>; inst: PerpInstrument }>();
  for (const r of raws) {
    const i = parsed.find((p) => p.name === r.instrument_name);
    if (i) inst.set(i.name, { raw: r, inst: i });
  }
  const tkFrame = fx.frames.find((f) => f.method === "public/get_tickers")!;
  const rawTk = new Map(Object.entries((tkFrame.result as { tickers: Record<string, unknown> }).tickers));
  // the mock book always has depth on both sides (testnet's small alts are often empty)
  for (const [name, t] of rawTk) {
    const o = t as Record<string, string>;
    if (!(Number(o.a) > 0) || !(Number(o.b) > 0)) {
      const m = Number(o.M);
      const tick = Number(inst.get(name)?.inst.tickSize ?? "0.0001");
      o.a = String(Math.round((m * 1.0005) / tick) * tick);
      o.b = String(Math.round((m * 0.9995) / tick) * tick);
      o.A = o.B = "1000";
    }
    if (Number(o.A) < 50) o.A = "50";
    if (Number(o.B) < 50) o.B = "50";
  }
  const tk = new Map(Object.entries(parsePerpTickers({ tickers: Object.fromEntries(rawTk) })));
  return { recordedAt: fx.recordedAt, frames: fx.frames, inst, tk, rawTk };
}

export const PERPS: Record<NetId, PerpMarket> = { testnet: load("testnet"), mainnet: load("mainnet") };

export const isPerp = (name: string) => /-PERP$/.test(name);

export function perpPublic(net: NetId, method: string, p: Record<string, unknown>): { hit: boolean; result?: unknown } {
  const m = PERPS[net];
  if (method === "public/get_all_instruments" && p.instrument_type === "perp") return { hit: true, result: m.frames.find((f) => f.method === method)!.result };
  if (method === "public/get_tickers" && p.instrument_type === "perp") return { hit: true, result: { tickers: Object.fromEntries(m.rawTk) } };
  if (method === "public/get_ticker" && isPerp(String(p.instrument_name))) {
    const t = m.rawTk.get(String(p.instrument_name));
    if (!t) throw { code: -32602, message: "Invalid params", data: "Instrument not found" };
    return { hit: true, result: t };
  }
  if (method === "public/get_instrument" && isPerp(String(p.instrument_name))) {
    const i = m.inst.get(String(p.instrument_name));
    if (!i) throw { code: -32602, message: "Invalid params", data: "Instrument not found" };
    return { hit: true, result: i.raw };
  }
  if (method === "public/get_funding_rate_history") return { hit: true, result: m.frames.find((f) => f.method === method)?.result ?? { funding_rate_history: [] } };
  return { hit: false };
}

export interface PerpPos {
  amount: number;
  avg: number;
  funding: number;
}

/** Requirements of the perp book of a subaccount at recorded marks. */
export function perpReqs(net: NetId, perps: Map<string, PerpPos>): { im: number; mm: number; upnl: number } {
  let im = 0, mm = 0, upnl = 0;
  for (const [n, p] of perps) {
    const i = PERPS[net].inst.get(n)?.inst, t = PERPS[net].tk.get(n);
    if (!i || !t || p.amount === 0) continue;
    im += i.imReq * Math.abs(p.amount) * t.mark;
    mm += i.mmReq * Math.abs(p.amount) * t.mark;
    upnl += p.amount * (t.mark - p.avg);
  }
  return { im, mm, upnl };
}
