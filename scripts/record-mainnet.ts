// Records PUBLIC Derive v3 MAINNET frames (no key, no login, read-only) into
// tests/fixtures/mainnet-public.json: risk universes, currencies, and the ETH/BTC
// option instruments + tickers for the two nearest usable expiries. Also stores
// the testnet risk universes for the mock server.
//   node --experimental-strip-types scripts/record-mainnet.ts
import { writeFileSync } from "node:fs";
import { NETWORKS } from "../src/config.ts";
import { DeriveClient } from "../src/net/client.ts";
import { ReadOnlyRpc } from "../src/net/dryrun.ts";

const OUT = new URL("../tests/fixtures/", import.meta.url);
type Frame = { method: string; params: Record<string, unknown>; result: unknown };

async function record(netId: "mainnet" | "testnet") {
  const c = new DeriveClient(NETWORKS[netId].wsUrl, { timeoutMs: 30_000 });
  const ro = new ReadOnlyRpc(c);
  const frames: Frame[] = [];
  const rec = async <T>(method: string, params: Record<string, unknown>) => {
    const result = await ro.call<T>(method, params);
    frames.push({ method, params, result });
    return result;
  };
  const recordedAt = await rec<number>("public/get_time", {});
  await rec("public/get_risk_universes", {});
  if (netId === "testnet") {
    c.close();
    return { network: netId, recordedAt, frames };
  }
  const cur = await ro.call<Array<Record<string, unknown>>>("public/get_all_currencies", {});
  frames.push({ method: "public/get_all_currencies", params: {}, result: cur.filter((x) => ["ETH", "BTC", "SOL", "HYPE", "ADA", "LIT", "CC"].includes(String(x.currency))) });
  for (const a of ["ETH", "BTC"]) {
    const all = (await c.getAllInstruments(a)) as Array<Record<string, unknown> & { option_details: { expiry: number }; is_active: boolean; instrument_name: string }>;
    const keys = [...new Set(all.filter((i) => i.is_active && i.option_details.expiry * 1000 - recordedAt > 2 * 86_400_000).map((i) => i.instrument_name.split("-")[1]!))].sort().slice(0, 2);
    const kept = all.filter((i) => keys.includes(i.instrument_name.split("-")[1]!));
    frames.push({ method: "public/get_all_instruments", params: { currency: a, instrument_type: "option", expired: false }, result: { instruments: kept, pagination: { num_pages: 1, count: kept.length } } });
    for (const k of keys) await rec("public/get_tickers", { currency: a, instrument_type: "option", expiry_date: Number(k) });
    await rec("public/get_ticker", { instrument_name: `${a}-PERP` });
  }
  c.close();
  return { network: netId, recordedAt, frames };
}

const main = await record("mainnet");
writeFileSync(new URL("mainnet-public.json", OUT), JSON.stringify(main));
const test = await record("testnet");
writeFileSync(new URL("testnet-risk-universes.json", OUT), JSON.stringify(test.frames.find((f) => f.method === "public/get_risk_universes")!.result));
console.log("mainnet frames", main.frames.length, new Date(main.recordedAt).toISOString());
