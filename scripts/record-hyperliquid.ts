// Records READ-ONLY Hyperliquid info responses (mainnet + testnet) into
// tests/fixtures/hyperliquid/<net>.json for the unit tests and the mock server.
// No keys, no signing, no /exchange calls.
//
//   node --experimental-strip-types --no-warnings scripts/record-hyperliquid.ts
//
// Account frames use a public, always-active address (an HLP sub-vault on mainnet, which always holds positions)
// so position / fill / funding parsing is tested on real shapes.

import { writeFileSync } from "node:fs";

const NETS = {
  mainnet: { url: "https://api.hyperliquid.xyz/info", user: "0x010461c14e146ac35fe42271bdc1134ee31c703a" },
  testnet: { url: "https://api.hyperliquid-testnet.xyz/info", user: null as string | null },
} as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function info(url: string, body: object): Promise<unknown> {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 429) {
      await sleep(1500 * (i + 1));
      continue;
    }
    if (!r.ok) throw new Error(`${r.status} for ${JSON.stringify(body)}`);
    return r.json();
  }
  throw new Error("rate limited: " + JSON.stringify(body));
}

const recordedAt = Date.now();
for (const [net, cfg] of Object.entries(NETS)) {
  const frames: { req: object; res: unknown }[] = [];
  const get = async (req: object) => {
    const res = await info(cfg.url, req);
    frames.push({ req, res });
    await sleep(400);
    return res;
  };
  const [meta] = (await get({ type: "metaAndAssetCtxs" })) as [{ universe: { name: string }[] }, unknown[]];
  for (const coin of ["ETH", "BTC", "SOL"]) if (meta.universe.some((u) => u.name === coin)) await get({ type: "l2Book", coin });
  if (cfg.user) {
    const ch = (await get({ type: "clearinghouseState", user: cfg.user })) as { assetPositions: unknown[] };
    ch.assetPositions = ch.assetPositions.slice(0, 12);
    await get({ type: "frontendOpenOrders", user: cfg.user });
    const fills = (await get({ type: "userFills", user: cfg.user })) as unknown[];
    frames[frames.length - 1]!.res = fills.slice(0, 60); // keep the fixture small
    const fund = (await get({ type: "userFunding", user: cfg.user, startTime: recordedAt - 6 * 3600_000 })) as unknown[];
    frames[frames.length - 1]!.res = fund.slice(0, 60);
    await get({ type: "userFees", user: cfg.user });
  }
  writeFileSync(new URL(`../tests/fixtures/hyperliquid/${net}.json`, import.meta.url), JSON.stringify({ recordedAt, url: cfg.url, user: cfg.user, frames }, null, 0));
  console.log(net, frames.length, "frames");
}
