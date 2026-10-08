// Re-record the public Veranta fixtures (pair catalogue + prices) for tests:
//   node --experimental-strip-types --no-warnings scripts/record-veranta.ts
// Keeps ETH, BTC, SOL, an upside pair and an FX pair per network; read-only.
import { writeFileSync } from "node:fs";
import { Veranta } from "veranta-sdk";

for (const network of ["testnet", "mainnet"] as const) {
  const c = new Veranta({ network, env: {} });
  const all = [...(await c.markets.pairs()).values()] as unknown as Record<string, unknown>[];
  const keep = all.filter((p) => ["ETH/USD", "BTC/USD", "SOL/USD", "USD/JPY", "EUR/USD", "XAU/USD"].includes(`${p.from}/${p.to}`) || String(p.from).endsWith("_UPSIDE")).slice(0, 9);
  // big feed blobs and skew tables are left out of the fixture
  const DROP = new Set(["feed", "backupFeed", "lazerFeed", "skewEqParams"]);
  const slim = keep.map((p) => ({ ...Object.fromEntries(Object.entries(p).filter(([k]) => !DROP.has(k))), feed: { attributes: (p.feed as { attributes?: unknown } | undefined)?.attributes } }));
  const prices: Record<number, number> = {};
  for (const p of keep.filter((x) => ["ETH", "BTC", "SOL"].includes(String(x.from)))) prices[p.index as number] = await c.markets.price(p.index as number);
  writeFileSync(`tests/fixtures/veranta/${network}.json`, JSON.stringify({ recordedAt: new Date().toISOString(), network, pairCount: all.length, pairs: slim, prices }, null, 1));
  console.log(network, all.length, "pairs, kept", slim.length);
}
