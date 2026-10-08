// Opt-in, TESTNET ONLY: fund a Hyperliquid testnet account through the app's own
// CCTP deposit code (src/venues/hyperliquid/deposit.ts), Arbitrum Sepolia →
// HyperCore testnet. This is the route that does NOT need the Hyperliquid
// faucet (which only pays addresses that deposited on mainnet): Circle's public
// faucet (faucet.circle.com) gives Arbitrum Sepolia USDC, and Arbitrum Sepolia
// ETH for gas comes from bridging Sepolia ETH (Delayed Inbox depositEth).
//
//   HL_TESTNET_KEY_FILE=../secrets/… AMOUNT=19 node --experimental-strip-types --no-warnings scripts/hl/testnet-deposit.ts
//
// The key is read from the file and never printed. Refuses to run on mainnet.
import { readFileSync } from "node:fs";
import { JsonRpcProvider, Wallet } from "ethers";
import { HL_NETWORKS } from "../../src/venues/hyperliquid/config.ts";
import { depositUsdc } from "../../src/venues/hyperliquid/deposit.ts";

const n = HL_NETWORKS.testnet;
if (n.depositChainId !== 421614) throw new Error("testnet only");
const key = readFileSync(process.env.HL_TESTNET_KEY_FILE!, "utf8").trim();
const rpc = new JsonRpcProvider("https://sepolia-rollup.arbitrum.io/rpc", 421614);
const w = new Wallet(key.startsWith("0x") ? key : "0x" + key, rpc);
const shim = {
  async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
    const p = (params ?? []) as unknown[];
    switch (method) {
      case "eth_chainId":
        return "0x66eee";
      case "wallet_switchEthereumChain":
        if ((p[0] as { chainId: string }).chainId !== "0x66eee") throw new Error("this shim only does Arbitrum Sepolia");
        return null;
      case "eth_call":
        return rpc.call(p[0] as { to: string; data: string });
      case "eth_signTypedData_v4": {
        const td = JSON.parse(String(p[1]));
        const { EIP712Domain: _d, ...types } = td.types;
        return w.signTypedData(td.domain, types, td.message);
      }
      case "eth_sendTransaction": {
        const tx = p[0] as { to: string; data: string };
        const sent = await w.sendTransaction({ to: tx.to, data: tx.data });
        return sent.hash;
      }
      case "eth_getTransactionReceipt": {
        const r = await rpc.getTransactionReceipt(String(p[0]));
        return r ? { status: r.status === 1 ? "0x1" : "0x0" } : null;
      }
    }
    throw new Error("unsupported " + method);
  },
};
const r = await depositUsdc({ p: shim, n, user: w.address, amountUsd: process.env.AMOUNT ?? "19", nowSec: Math.floor(Date.now() / 1000), onStep: (s) => console.log("·", s), waitMs: 180_000 });
console.log(JSON.stringify({ address: w.address, ...r }));
