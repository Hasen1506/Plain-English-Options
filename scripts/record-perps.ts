// Records PUBLIC perp frames from Derive v3 MAINNET and TESTNET (no key, no
// login, read-only through ReadOnlyRpc) into tests/fixtures/perps-<net>.json:
// every perp instrument, all perp tickers, the ETH/BTC perp tickers and a slice
// of ETH-PERP funding history. Used by unit tests and the mock server.
//   npm run record:perps
import { writeFileSync } from "node:fs";
import { NETWORKS, type NetworkId } from "../src/config.ts";
import { DeriveClient } from "../src/net/client.ts";
import { ReadOnlyRpc } from "../src/net/dryrun.ts";

type Frame = { method: string; params: Record<string, unknown>; result: unknown };

async function record(netId: NetworkId) {
  const c = new DeriveClient(NETWORKS[netId].wsUrl, { timeoutMs: 30_000 });
  const ro = new ReadOnlyRpc(c);
  const frames: Frame[] = [];
  const rec = async <T>(method: string, params: Record<string, unknown>) => {
    const result = await ro.call<T>(method, params);
    frames.push({ method, params, result });
    return result;
  };
  const recordedAt = await rec<number>("public/get_time", {});
  await rec("public/get_all_instruments", { instrument_type: "perp", expired: false, page: 1, page_size: 1000 });
  await rec("public/get_tickers", { instrument_type: "perp" });
  for (const n of ["ETH-PERP", "BTC-PERP"]) await rec("public/get_ticker", { instrument_name: n });
  const fh = await ro.call<{ funding_rate_history?: unknown[] }>("public/get_funding_rate_history", { instrument_name: "ETH-PERP" });
  frames.push({ method: "public/get_funding_rate_history", params: { instrument_name: "ETH-PERP" }, result: { funding_rate_history: (fh?.funding_rate_history ?? []).slice(-48) } });
  c.close();
  return { network: netId, recordedAt, frames };
}

for (const n of ["mainnet", "testnet"] as const) {
  const r = await record(n);
  writeFileSync(new URL(`../tests/fixtures/perps-${n}.json`, import.meta.url), JSON.stringify(r));
  console.log(n, "frames", r.frames.length, new Date(r.recordedAt).toISOString());
}
