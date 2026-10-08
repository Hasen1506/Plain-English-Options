// Records 24 h of hourly index candles (public/get_index_chart_data) per asset from
// Derive v3 testnet into tests/fixtures/index-chart-testnet.json. The e2e mock serves
// them so the asset list draws real sparklines. Public data, no key.
//
//   node --experimental-strip-types --no-warnings scripts/record-index-chart.ts

import { writeFileSync } from "node:fs";
import { ASSETS, NETWORKS } from "../src/config.ts";
import { DeriveClient } from "../src/net/client.ts";
import { indexChartParams } from "../src/lib/spark.ts";

const c = new DeriveClient(NETWORKS.testnet.wsUrl, { timeoutMs: 20_000 });
c.connect();
const recordedAt = Date.now();
const series: Record<string, unknown> = {};
for (const a of ASSETS) {
  const params = indexChartParams(a, recordedAt);
  series[a] = await c.call("public/get_index_chart_data", params).catch((e) => ({ error: String(e) }));
  console.log(a, Array.isArray(series[a]) ? (series[a] as unknown[]).length + " candles" : series[a]);
}
c.close();
writeFileSync(new URL("../tests/fixtures/index-chart-testnet.json", import.meta.url), JSON.stringify({ network: "testnet", recordedAt, method: "public/get_index_chart_data", series }, null, 1) + "\n");
