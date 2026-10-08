// npm run check:mainnet — read-only mainnet signature check. NEVER places an order.
//   DERIVE_SESSION_KEY=0x… (a registered session key, or the owner key)
//   DERIVE_WALLET=0x…      (owner wallet; defaults to the key's address)
//   DERIVE_SUBACCOUNT_ID=… (a funded mainnet subaccount in the ETH options universe)
// Uses only: public/login, private/get_subaccount, public market data,
// private/get_margin (simulation) and private/order_debug. Checks an ETH options
// spread and the smallest ETH-PERP market + post-only orders (CHECK_PERPS=0 skips perps). Every call goes through ReadOnlyRpc, which refuses
// private/order before it reaches the socket (tests/unit/dryrun.test.ts).
import { NETWORKS } from "../src/config.ts";
import { DeriveClient } from "../src/net/client.ts";
import { keySigner } from "../src/net/signer.ts";
import { ReadOnlyRpc } from "../src/net/dryrun.ts";
import { checkMainnet } from "./check-mainnet-lib.ts";

const key = process.env.DERIVE_SESSION_KEY ?? process.env.DERIVE_PRIVATE_KEY;
const sub = Number(process.env.DERIVE_SUBACCOUNT_ID);
if (!key || !Number.isInteger(sub) || sub <= 0) {
  console.error("Set DERIVE_SESSION_KEY (or DERIVE_PRIVATE_KEY), DERIVE_SUBACCOUNT_ID and, for a session key, DERIVE_WALLET.");
  process.exit(2);
}
const net = NETWORKS.mainnet;
const signer = keySigner(key, net, process.env.DERIVE_WALLET);
const client = new DeriveClient(net.wsUrl, {
  timeoutMs: 20_000,
  onOpen: async (c) => {
    const ts = String(Date.now());
    await c.callRaw("public/login", { wallet: signer.owner, timestamp: ts, signature: await signer.signLogin(ts) });
  },
});
const ro = new ReadOnlyRpc(client);
try {
  const r = await checkMainnet({ rpc: ro, signer, subaccountId: sub, now: Date.now(), perps: process.env.CHECK_PERPS !== "0" });
  console.log(JSON.stringify({ wallet: signer.owner, signer: signer.signer, ...r, methodsSent: ro.sent }, null, 2));
  if (r.perps && !r.perps.rightUniverse) console.warn(`subaccount ${sub} is in risk universe ${r.subaccount.riskUniverse}, ${r.perps.instrument} trades in ${r.perps.universe}`);
  if (!r.rightUniverse) console.warn(`subaccount ${sub} is in risk universe ${r.subaccount.riskUniverse}, ETH options need ${r.ethOptionsUniverse}`);
  process.exitCode = r.ok ? 0 : 1;
} catch (e) {
  console.error("check failed:", (e as Error).message);
  process.exitCode = 1;
} finally {
  client.close();
}
