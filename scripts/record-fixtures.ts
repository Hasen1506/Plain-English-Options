// Records real Derive v3 testnet frames into tests/fixtures/*.json for the
// mock server and the unit tests. Public frames need no key. Private frames are
// recorded only when DERIVE_PRIVATE_KEY is set (the key is never written out).
//
//   node --experimental-strip-types scripts/record-fixtures.ts
//   DERIVE_PRIVATE_KEY=0x… DERIVE_SUBACCOUNT_ID=87139 node --experimental-strip-types scripts/record-fixtures.ts

import { writeFileSync } from "node:fs";
import { NETWORKS } from "../src/config.ts";
import { DeriveClient } from "../src/net/client.ts";
import { keySigner } from "../src/net/signer.ts";

const net = NETWORKS.testnet;
const OUT = new URL("../tests/fixtures/", import.meta.url);
const key = process.env.DERIVE_PRIVATE_KEY;
const sub = Number(process.env.DERIVE_SUBACCOUNT_ID ?? 87139);
const signer = key ? keySigner(key, net) : null;

const c = new DeriveClient(net.wsUrl, {
  timeoutMs: 20_000,
  onOpen: signer
    ? async (cl) => {
        const ts = String(Date.now());
        await cl.callRaw("public/login", { wallet: signer.owner, timestamp: ts, signature: await signer.signLogin(ts) });
      }
    : undefined,
});
c.connect();

type Frame = { method: string; params: Record<string, unknown>; result: unknown };
const frames: Frame[] = [];
async function rec<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const result = await c.call<T>(method, params);
  frames.push({ method, params, result });
  return result;
}

const recordedAt = await c.call<number>("public/get_time", {});
frames.push({ method: "public/get_time", params: {}, result: recordedAt });

const ASSETS = ["ETH", "BTC", "HYPE", "ADA"];
const KEEP: Record<string, number> = { ETH: 4, BTC: 2, HYPE: 1, ADA: 1 };
const currencies = await c.call<Array<Record<string, unknown>>>("public/get_all_currencies", {});
frames.push({
  method: "public/get_all_currencies",
  params: {},
  result: currencies.filter((x) => ["ETH", "BTC", "SOL", "HYPE", "ADA", "LIT", "CC"].includes(String(x.currency))),
});

for (const cur of ASSETS) {
  const all = (await c.getAllInstruments(cur)) as Array<Record<string, unknown> & { option_details: { expiry: number }; is_active: boolean; instrument_name: string }>;
  const keys = [...new Set(all.filter((i) => i.is_active && i.option_details.expiry * 1000 - recordedAt > 2 * 86_400_000).map((i) => i.instrument_name.split("-")[1]!))].sort();
  // nearest weekly, ~2 weeks, and the ones near 45 days: what the UI asks for first
  const pick = keys.slice(0, 2).concat(keys.slice(2).sort((a, b) => Math.abs(days(a) - 45) - Math.abs(days(b) - 45)).slice(0, KEEP[cur]! - 2 > 0 ? KEEP[cur]! - 2 : 0)).slice(0, KEEP[cur]);
  const kept = all.filter((i) => pick.includes(i.instrument_name.split("-")[1]!));
  frames.push({ method: "public/get_all_instruments", params: { currency: cur, instrument_type: "option", expired: false }, result: { instruments: kept, pagination: { num_pages: 1, count: kept.length } } });
  for (const k of pick) await rec("public/get_tickers", { currency: cur, instrument_type: "option", expiry_date: Number(k) });
}
for (const cur of ["ETH", "BTC", "SOL", "HYPE", "ADA", "LIT", "CC"]) {
  try {
    await rec("public/get_ticker", { instrument_name: `${cur}-PERP` });
  } catch (e) {
    console.warn("no perp", cur, (e as Error).message);
  }
}

function days(k: string): number {
  const t = Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8), 8);
  return (t - recordedAt) / 86_400_000;
}

writeFileSync(new URL("testnet-public.json", OUT), JSON.stringify({ network: "testnet", recordedAt, frames }, null, 0));
console.log("public frames", frames.length);

if (signer) {
  const priv: Frame[] = [];
  const p = async (method: string, params: Record<string, unknown>) => {
    try {
      priv.push({ method, params, result: await c.call(method, params) });
    } catch (e) {
      priv.push({ method, params, result: { error: (e as Error).message } });
    }
  };
  await p("private/get_subaccounts", { wallet: signer.owner });
  await p("private/get_subaccount", { subaccount_id: sub });
  await p("private/get_subaccount", { subaccount_id: 87138 });
  await p("private/get_open_orders", { subaccount_id: sub });
  await p("private/get_trade_history", { subaccount_id: sub });
  // addresses are public on-chain data; still, the fixture uses the recorded wallet only as data
  writeFileSync(new URL("testnet-private.json", OUT), JSON.stringify({ network: "testnet", recordedAt, wallet: signer.owner, frames: priv }, null, 0));
  console.log("private frames", priv.length);
}
c.close();
