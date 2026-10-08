// Records READ-ONLY Hyperliquid HIP-3 info responses (mainnet + testnet) into
// tests/fixtures/hyperliquid/hip3-<net>.json for the unit tests and the mock server:
// perpDexs (dex slots kept in place, unused ones trimmed to name/fullName/deployer),
// perpConciseAnnotations (category + display name), the "xyz" dex's metaAndAssetCtxs, spotMeta's first tokens, the
// xyz:GOLD book and 24 h of hourly candles for a few coins. No keys, no /exchange.
//
//   node --experimental-strip-types --no-warnings scripts/record-hip3.ts

import { writeFileSync } from "node:fs";

const NETS = { mainnet: "https://api.hyperliquid.xyz/info", testnet: "https://api.hyperliquid-testnet.xyz/info" } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function info(url: string, body: object): Promise<unknown> {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 429) {
      await sleep(2000 * (i + 1));
      continue;
    }
    if (!r.ok) throw new Error(`${r.status} for ${JSON.stringify(body)}`);
    return r.json();
  }
  throw new Error("rate limited: " + JSON.stringify(body));
}

const recordedAt = Date.now();
for (const [net, url] of Object.entries(NETS)) {
  const frames: { req: Record<string, unknown>; res: unknown }[] = [];
  const get = async (req: Record<string, unknown>, keep: (r: unknown) => unknown = (r) => r) => {
    const res = keep(await info(url, req));
    frames.push({ req, res });
    await sleep(500);
    return res;
  };
  await get({ type: "perpDexs" }, (r) => (r as (Record<string, unknown> | null)[]).map((d) => (d && d.name !== "xyz" ? { name: d.name, fullName: d.fullName, deployer: d.deployer } : d)));
  await get({ type: "perpConciseAnnotations" });
  await get({ type: "metaAndAssetCtxs", dex: "xyz" });
  await get({ type: "spotMeta" }, (r) => ({ tokens: (r as { tokens: unknown[] }).tokens.slice(0, 3), universe: [] }));
  await get({ type: "l2Book", coin: "xyz:GOLD" });
  for (const coin of ["xyz:GOLD", "xyz:XYZ100", "xyz:NVDA", "xyz:EUR", "ETH", "BTC"]) await get({ type: "candleSnapshot", req: { coin, interval: "1h", startTime: recordedAt - 86_400_000, endTime: recordedAt } });
  writeFileSync(new URL(`../tests/fixtures/hyperliquid/hip3-${net}.json`, import.meta.url), JSON.stringify({ recordedAt, url, frames }));
  console.log(net, frames.length, "frames");
}
