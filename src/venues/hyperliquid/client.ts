// Hyperliquid HTTP client + the one-tap agent session.
//
// Agent ("API wallet") model, per docs for-developers/api/nonces-and-api-wallets:
//   * a FRESH key is generated in this tab for every session and lives only in
//     memory (never storage, never logged); the docs strongly advise against
//     reusing agent addresses because nonce state is pruned after deregistration
//   * the wallet approves it once (user-signed approveAgent, EIP-712)
//   * it is approved under the app's named slot "peo" with `valid_until` = now + 24 h,
//     so it expires on its own; approving a new key under the same name
//     deregisters the old one, which is how Disconnect revokes it (a burned
//     throwaway key takes the slot, expiring in a minute)
//   * an agent can place/cancel orders and change leverage, but cannot withdraw
//     or transfer: withdraw3 is always signed by the wallet itself.

import { SigningKey, Wallet, getAddress, type HDNodeWallet } from "ethers";
import type { Packable } from "./msgpack.ts";
import { approveAgentAction, signL1, splitSig, userTyped, walletPayload, withdrawAction, APPROVE_AGENT_TYPES, WITHDRAW_TYPES, type HlSig } from "./signing.ts";
import { HL_AGENT_NAME, HL_AGENT_TTL_MS } from "./config.ts";
import { walletRequest, type Eip1193 } from "../../net/signer.ts";

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface HlClientOpts {
  api: string; // https://api.hyperliquid.xyz
  mainnet: boolean;
  now: () => number;
  fetch?: Fetch;
}

export class HlClient {
  readonly api: string;
  readonly mainnet: boolean;
  private now: () => number;
  private fetchFn: Fetch;
  private lastNonce = 0;

  constructor(o: HlClientOpts) {
    this.api = o.api.replace(/\/$/, "");
    this.mainnet = o.mainnet;
    this.now = o.now;
    // bound: an unbound window.fetch throws "Illegal invocation" in browsers
    this.fetchFn = o.fetch ?? ((u, i) => globalThis.fetch(u, i));
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    let last: unknown = null;
    for (let i = 0; i < 3; i++) {
      const r = await this.fetchFn(this.api + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (r.status === 429) {
        last = new Error("Hyperliquid is rate-limiting this connection; try again in a moment");
        await new Promise((res) => setTimeout(res, 600 * (i + 1)));
        continue;
      }
      if (!r.ok) throw new Error(`Hyperliquid answered HTTP ${r.status}`);
      return r.json();
    }
    throw last;
  }

  info<T = unknown>(body: Record<string, unknown>): Promise<T> {
    return this.post("/info", body) as Promise<T>;
  }

  /** A nonce strictly above the last one this tab used (the agent's nonce set is per signer). */
  nonce(): number {
    const n = Math.max(Math.floor(this.now()), this.lastNonce + 1);
    this.lastNonce = n;
    return n;
  }

  /** Send an L1 action signed by `key` (the agent). Actions that carry their own nonce field are built from the nonce. */
  async l1(build: Packable | ((nonce: number) => Packable), key: SigningKey, expiresAfter: number | null = null): Promise<unknown> {
    const nonce = this.nonce();
    const action = typeof build === "function" ? build(nonce) : build;
    const signature = signL1(key, action, nonce, this.mainnet, null, expiresAfter);
    return this.post("/exchange", { action, nonce, signature, vaultAddress: null, ...(expiresAfter !== null ? { expiresAfter } : {}) });
  }

  /** Send a user-signed action (signature from the wallet). */
  userAction(action: Record<string, unknown>, nonce: number, signature: HlSig): Promise<unknown> {
    return this.post("/exchange", { action, nonce, signature });
  }
}

export interface AgentSession {
  address: string;
  expiresAt: number; // ms
  /** in-memory only */
  key: SigningKey;
}

/** The chain the wallet is on right now: user-signed actions may use any signatureChainId, so we never force a switch. */
export async function walletChainId(p: Eip1193): Promise<number> {
  const c = await walletRequest(p, "eth_chainId", []);
  const n = typeof c === "string" ? parseInt(c, 16) : Number(c);
  if (!Number.isInteger(n) || n <= 0) throw new Error("Your wallet did not report its network");
  return n;
}

async function signUser(p: Eip1193, user: string, primaryType: string, types: typeof APPROVE_AGENT_TYPES, action: Record<string, unknown>): Promise<HlSig> {
  const t = userTyped(primaryType, types, action);
  const sig = String(await walletRequest(p, "eth_signTypedData_v4", [user, walletPayload(t)]));
  return splitSig(sig);
}

/** Generate a fresh agent in memory and have the wallet approve it (one signature). */
export async function approveNewAgent(c: HlClient, p: Eip1193, user: string, now: number, ttlMs = HL_AGENT_TTL_MS): Promise<AgentSession> {
  const w: HDNodeWallet = Wallet.createRandom();
  const expiresAt = Math.floor(now + ttlMs);
  const chainId = await walletChainId(p);
  const nonce = c.nonce();
  const action = approveAgentAction({ mainnet: c.mainnet, chainId, agent: w.address, name: `${HL_AGENT_NAME} valid_until ${expiresAt}`, nonce });
  const sig = await signUser(p, user, "HyperliquidTransaction:ApproveAgent", APPROVE_AGENT_TYPES, action);
  const r = (await c.userAction(action, nonce, sig)) as { status?: string; response?: unknown };
  if (r?.status !== "ok") throw new Error(typeof r?.response === "string" ? r.response : "Hyperliquid did not approve the one-tap key");
  return { address: getAddress(w.address), expiresAt, key: new SigningKey(w.privateKey) };
}

/**
 * Revoke: approve a burned throwaway key under the same name (which deregisters
 * the session agent) with the shortest life we can give it. The throwaway's
 * private key is dropped immediately, so the slot is dead either way.
 */
export async function revokeAgent(c: HlClient, p: Eip1193, user: string, now: number): Promise<void> {
  const burn = Wallet.createRandom();
  const chainId = await walletChainId(p);
  const nonce = c.nonce();
  const action = approveAgentAction({ mainnet: c.mainnet, chainId, agent: burn.address, name: `${HL_AGENT_NAME} valid_until ${Math.floor(now + 60_000)}`, nonce });
  const sig = await signUser(p, user, "HyperliquidTransaction:ApproveAgent", APPROVE_AGENT_TYPES, action);
  const r = (await c.userAction(action, nonce, sig)) as { status?: string; response?: unknown };
  if (r?.status !== "ok") throw new Error(typeof r?.response === "string" ? r.response : "Hyperliquid did not accept the revoke");
}

/** withdraw3, signed by the wallet (an agent cannot withdraw). Amount is USDC as a plain decimal. */
export async function withdrawUsdc(c: HlClient, p: Eip1193, user: string, amount: string, now: number): Promise<unknown> {
  const chainId = await walletChainId(p);
  const time = Math.max(Math.floor(now), c.nonce());
  const action = withdrawAction({ mainnet: c.mainnet, chainId, destination: getAddress(user), amount, time });
  const sig = await signUser(p, user, "HyperliquidTransaction:Withdraw", WITHDRAW_TYPES, action);
  const r = (await c.userAction(action, time, sig)) as { status?: string; response?: unknown };
  if (r?.status !== "ok") throw new Error(typeof r?.response === "string" ? r.response : "Hyperliquid did not accept the withdrawal");
  return r;
}

export const agentUsable = (a: AgentSession | null, now: number, safetyMs = 120_000): a is AgentSession => !!a && a.expiresAt - now > safetyMs;
