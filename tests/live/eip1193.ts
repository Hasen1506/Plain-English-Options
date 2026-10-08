// A Node EIP-1193 provider backed by a raw key and a JSON-RPC node: lets the
// live tests drive the exact browser code paths (personal_sign,
// eth_signTypedData_v4, eth_sendTransaction) against Sepolia. TESTNET ONLY.
import { getBytes, isHexString, JsonRpcProvider, Wallet } from "ethers";
import type { Eip1193 } from "../../src/net/signer.ts";

export function keyProvider(privateKey: string, rpcUrl: string, chainId: number): Eip1193 & { address: string } {
  if (chainId === 1) throw new Error("the key provider refuses mainnet");
  const rpc = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  const w = new Wallet(privateKey, rpc);
  return {
    address: w.address,
    async request({ method, params }) {
      const p = (params ?? []) as unknown[];
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [w.address];
        case "eth_chainId":
          return "0x" + chainId.toString(16);
        case "wallet_switchEthereumChain":
          if (parseInt((p[0] as { chainId: string }).chainId, 16) !== chainId) throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
          return null;
        case "personal_sign": {
          const m = String(p[0]);
          return w.signMessage(isHexString(m) ? getBytes(m) : m);
        }
        case "eth_signTypedData_v4": {
          const td = JSON.parse(String(p[1]));
          const { EIP712Domain: _d, ...types } = td.types;
          return w.signTypedData(td.domain, types, td.message);
        }
        case "eth_sendTransaction": {
          const tx = p[0] as { to: string; data: string; value?: string };
          const sent = await w.sendTransaction({ to: tx.to, data: tx.data, value: 0n });
          return sent.hash;
        }
        default:
          return rpc.send(method, p);
      }
    },
  };
}
