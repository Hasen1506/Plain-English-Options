// Who signs: a raw key (tests, live smoke) or an injected EIP-1193 wallet.

import { getAddress, hexlify, toUtf8Bytes, Wallet } from "ethers";
import type { Network } from "../config.ts";
import { digest, signDigestWithKey, typedDataFor, type ActionFields } from "./signing.ts";

export interface ActionSigner {
  owner: string; // Derive wallet (owner of the subaccounts)
  signer: string; // address that signs (owner itself, or a registered session key)
  /** true when signing needs no user interaction (re-login on reconnect is automatic) */
  silent: boolean;
  /** Unix seconds after which this signer's signatures stop being valid (session keys). Undefined = never. */
  expiresAt?: number;
  signLogin(timestamp: string): Promise<string>;
  signAction(a: ActionFields): Promise<string>;
}

export function keySigner(rawKey: string, net: Network, owner?: string): ActionSigner {
  const k = rawKey.trim();
  const privateKey = /^0x/i.test(k) ? k : "0x" + k;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("private key must be 32 bytes of hex"); // never echo the value
  const w = new Wallet(privateKey);
  return {
    owner: getAddress(owner ?? w.address),
    signer: w.address,
    silent: true,
    signLogin: (ts) => w.signMessage(ts),
    signAction: async (a) => signDigestWithKey(privateKey, digest(a, net)),
  };
}

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
}

export function walletSigner(provider: Eip1193, account: string, net: Network, owner?: string): ActionSigner {
  const acct = getAddress(account);
  return {
    owner: getAddress(owner || acct),
    signer: acct,
    silent: false,
    // hex-encoded UTF-8: MetaMask mobile and desktop both display it as text and sign the same bytes
    signLogin: async (ts) => String(await walletRequest(provider, "personal_sign", [hexlify(toUtf8Bytes(ts)), acct])),
    signAction: async (a) => {
      await ensureChain(provider, net.chainId);
      return String(await walletRequest(provider, "eth_signTypedData_v4", [acct, JSON.stringify(typedDataFor(a, net))]));
    },
  };
}

/** EIP-1193 error → a sentence a person can act on. MetaMask mobile nests the real code in data.originalError. */
export function walletErrorCode(e: unknown): number | null {
  const o = e as { code?: unknown; data?: { originalError?: { code?: unknown }; code?: unknown } } | null;
  for (const c of [o?.data?.originalError?.code, o?.data?.code, o?.code]) if (typeof c === "number") return c;
  return null;
}

export function friendlyWalletError(e: unknown): Error {
  const code = walletErrorCode(e);
  const msg = (e as { message?: string })?.message ?? String(e);
  if (code === 4001 || /user (rejected|denied)/i.test(msg)) return new Error("You rejected the request in your wallet");
  if (code === -32002) return new Error("Your wallet already has a request open. Open the wallet to finish it");
  if (code === 4100) return new Error("The wallet has not authorised this site. Connect again");
  return e instanceof Error ? e : new Error(msg);
}

export async function walletRequest(p: Eip1193, method: string, params: unknown[] | object): Promise<unknown> {
  try {
    return await p.request({ method, params });
  } catch (e) {
    throw friendlyWalletError(e);
  }
}

/** Chains a wallet may not know yet (MetaMask mobile hides Sepolia unless test networks are shown). */
export const ADD_CHAIN: Record<number, object> = {
  11155111: {
    chainId: "0xaa36a7",
    chainName: "Sepolia",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
    blockExplorerUrls: ["https://sepolia.etherscan.io"],
  },
  // Hyperliquid deposits (USDC on Arbitrum via CCTP)
  42161: {
    chainId: "0xa4b1",
    chainName: "Arbitrum One",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://arb1.arbitrum.io/rpc"],
    blockExplorerUrls: ["https://arbiscan.io"],
  },
  421614: {
    chainId: "0x66eee",
    chainName: "Arbitrum Sepolia",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"],
    blockExplorerUrls: ["https://sepolia.arbiscan.io"],
  },
  // Veranta (USDC stays in the wallet on Base)
  8453: {
    chainId: "0x2105",
    chainName: "Base",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://mainnet.base.org"],
    blockExplorerUrls: ["https://basescan.org"],
  },
};

const isUnknownChain = (e: unknown) => walletErrorCode(e) === 4902 || /unrecognized chain|unknown chain|not been added/i.test((e as { message?: string })?.message ?? "");

/** Wallets refuse typed data whose domain chainId differs from the active chain. */
export async function ensureChain(provider: Eip1193, chainId: number): Promise<void> {
  const hex = "0x" + chainId.toString(16);
  let current: unknown = null;
  try {
    current = await provider.request({ method: "eth_chainId" });
  } catch {
    /* some wallets do not answer; try switching anyway */
  }
  if (typeof current === "string" && parseInt(current, 16) === chainId) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if (!isUnknownChain(e) || !ADD_CHAIN[chainId]) throw friendlyWalletError(e);
    await walletRequest(provider, "wallet_addEthereumChain", [ADD_CHAIN[chainId]]);
    await walletRequest(provider, "wallet_switchEthereumChain", [{ chainId: hex }]);
  }
  // mobile wallets can report the old chain for a moment after switching
  for (let i = 0; i < 10; i++) {
    let now: unknown = null;
    try {
      now = await provider.request({ method: "eth_chainId" });
    } catch {
      return; // cannot check: the signature request itself will say if the chain is wrong
    }
    if (typeof now !== "string" || parseInt(now, 16) === chainId) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Switch your wallet to chain ${chainId} and try again`);
}
