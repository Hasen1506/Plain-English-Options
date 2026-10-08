// Parsed view of tests/fixtures/mainnet-public.json (recorded read-only from Derive v3 mainnet).
import fx from "../fixtures/mainnet-public.json" with { type: "json" };
import { parseCurrencies, parseInstruments, parseTicker, parseTickers, type Instrument, type Ticker } from "../../src/lib/ticker.ts";
import { parseRiskUniverses } from "../../src/net/onchain.ts";

type Frame = { method: string; params: Record<string, unknown>; result: unknown };
const frames = (fx as { frames: Frame[] }).frames;
export const MAINNET_AT = (fx as { recordedAt: number }).recordedAt;
export const mainnetUniverses = parseRiskUniverses(frames.find((f) => f.method === "public/get_risk_universes")!.result);
export const mainnetCurrencies = parseCurrencies(frames.find((f) => f.method === "public/get_all_currencies")!.result);
export const mainnetRawCurrencies = frames.find((f) => f.method === "public/get_all_currencies")!.result as Array<Record<string, unknown>>;
export function mainnetInstruments(cur: string): { raw: Record<string, unknown>[]; parsed: Instrument[] } {
  const f = frames.find((x) => x.method === "public/get_all_instruments" && x.params.currency === cur)!;
  const raw = (f.result as { instruments: Record<string, unknown>[] }).instruments;
  return { raw, parsed: parseInstruments(f.result) };
}
export function mainnetTickers(cur: string): { expiry: string; tickers: Record<string, Ticker> }[] {
  return frames.filter((x) => x.method === "public/get_tickers" && x.params.currency === cur).map((x) => ({ expiry: String(x.params.expiry_date), tickers: parseTickers(x.result) }));
}
export function mainnetPerp(cur: string): Ticker | null {
  const f = frames.find((x) => x.method === "public/get_ticker" && x.params.instrument_name === `${cur}-PERP`);
  return f ? parseTicker(f.result) : null;
}
