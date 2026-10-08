// Who signs: a raw key (tests, live smoke) or an injected EIP-1193 wallet.

import { getAddress, Wallet } from "ethers";
import type { Network } from "../config.ts";
import { digest, signDigestWithKey, typedDataFor, type ActionFields } from "./signing.ts";

export interface ActionSigner {
  owner: string; // Derive wallet (owner of the subaccounts)
  signer: string; // address that signs (owner itself, or a registered session key)
  /** true when signing needs no user interaction (re-login on reconnect is automatic) */
  silent: boolean;
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
    signLogin: async (ts) => String(await provider.request({ method: "personal_sign", params: [ts, acct] })),
    signAction: async (a) => {
      await ensureChain(provider, net.chainId);
      return String(await provider.request({ method: "eth_signTypedData_v4", params: [acct, JSON.stringify(typedDataFor(a, net))] }));
    },
  };
}

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
  await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
}
