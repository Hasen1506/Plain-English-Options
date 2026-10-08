// Opt-in live checks against the REAL Hyperliquid API (never in CI):
//   npm run test:live -- tests/live/hyperliquid.test.ts
//
// 1. Signature dry run on testnet AND mainnet: an order signed by a throwaway key
//    with no account. The exchange answers "User or API Wallet 0x… does not exist"
//    with the address IT recovered; equality proves our msgpack/EIP-712 bytes are
//    exact. Nothing can trade (the signer has no account, no funds).
// 2. Full testnet round trip (only when HL_TESTNET_KEY_FILE points at a funded
//    testnet key): approve a fresh agent, set leverage, market long + short, close,
//    post-only limit + cancel, TP/SL + cancel all, revoke. Writes docs/live-hyperliquid-testnet.json.
//    The Hyperliquid testnet faucet only pays addresses that have deposited on
//    mainnet; see docs/qa-mainnet.md for how to unlock this.
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { SigningKey, Wallet } from "ethers";
import { HL_NETWORKS } from "../../src/venues/hyperliquid/config.ts";
import { HlClient } from "../../src/venues/hyperliquid/client.ts";
import { parseMeta } from "../../src/venues/hyperliquid/parse.ts";
import { orderAction, wire } from "../../src/venues/hyperliquid/orders.ts";
import { roundPrice } from "../../src/venues/hyperliquid/rules.ts";
import { createHyperliquidVenue } from "../../src/venues/hyperliquid/index.ts";
import { quotePerp } from "../../src/lib/perp.ts";

for (const net of ["testnet", "mainnet"] as const) {
  describe(`hyperliquid ${net}: signature dry run (no account, no trade)`, () => {
    it("the exchange recovers exactly our throwaway signer for an ALO order far from the market", async () => {
      const c = new HlClient({ api: HL_NETWORKS[net].api, mainnet: net === "mainnet", now: Date.now });
      const { markets, tickers } = parseMeta(await c.info({ type: "metaAndAssetCtxs" }));
      const eth = markets.find((m) => m.name === "ETH-PERP")!;
      const px = roundPrice(tickers["ETH-PERP"]!.mark * 0.5, eth.asset.szDecimals, "down"); // far below: could never fill anyway
      const burn = Wallet.createRandom();
      const r = (await c.l1(orderAction([wire(eth.asset, true, px, "0.01", false, { limit: { tif: "Alo" } })]), new SigningKey(burn.privateKey))) as { status: string; response: string };
      expect(r.status).toBe("err");
      expect(r.response.toLowerCase()).toContain(burn.address.toLowerCase());
    });
  });
}

const keyFile = process.env.HL_TESTNET_KEY_FILE;
describe.skipIf(!keyFile)("hyperliquid testnet: full round trip with a funded key", () => {
  it("approve agent → leverage → long → close → short → close → ALO + cancel → TP/SL + cancel all → revoke", async () => {
    const key = readFileSync(keyFile!, "utf8").trim(); // never printed
    const w = new Wallet(key);
    const eth = { request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === "eth_requestAccounts") return [w.address];
      if (method === "eth_chainId") return "0x66eee";
      if (method === "eth_signTypedData_v4") {
        const td = JSON.parse(String((params as unknown[])[1]));
        const { EIP712Domain: _d, ...types } = td.types;
        return w.signTypedData(td.domain, types, td.message);
      }
      throw new Error(method);
    } };
    const v = createHyperliquidVenue({ net: () => "testnet", now: Date.now, eth: () => eth, sheet: { open() {}, close() {} }, changed() {} });
    const log: Record<string, unknown>[] = [];
    await v.connect!();
    const ms = await v.markets();
    v.focus!("ETH-PERP");
    const q = async (o: object) => {
      const tk = await v.tickers();
      const a = v.selectedAccount("ETH-PERP");
      const r = quotePerp({ inst: ms.find((m) => m.name === "ETH-PERP")!, ticker: tk["ETH-PERP"]!, dir: "long", risk: 6, leverage: 2, orderType: "market", slippage: v.slippage, leverageCap: 10, headroomMM: a?.maintenanceMargin, headroomIM: a?.initialMargin, ...o });
      if (!r.ok) throw new Error(r.reason);
      return r.quote;
    };
    const acct = () => v.selectedAccount("ETH-PERP")!;
    const long = await v.open(acct(), await q({}));
    log.push({ step: "market long", ...long.entry });
    expect(long.entry.status).toBe("filled");
    const p1 = acct().positions.find((p) => p.instrument === "ETH-PERP")!;
    log.push({ step: "close long", ...(await v.close(acct(), "ETH-PERP", p1.amount, 1)) });
    const short = await v.open(acct(), await q({ dir: "short" }));
    log.push({ step: "market short", ...short.entry });
    const p2 = acct().positions.find((p) => p.instrument === "ETH-PERP")!;
    log.push({ step: "close short", ...(await v.close(acct(), "ETH-PERP", p2.amount, 1)) });
    const tk = await v.tickers();
    const alo = await v.open(acct(), await q({ orderType: "limit", limitPrice: tk["ETH-PERP"]!.bid * 0.95, postOnly: true }));
    log.push({ step: "post-only limit", ...alo.entry });
    await v.cancelAll(acct());
    log.push({ step: "cancel all", open: (await v.openOrders!(acct())).length });
    await v.disconnect!();
    writeFileSync(new URL("../../docs/live-hyperliquid-testnet.json", import.meta.url), JSON.stringify({ at: new Date().toISOString(), address: w.address, log }, null, 1));
  });
});
