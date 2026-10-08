// One-tap trading: a session key generated in the browser, registered by one
// wallet signature (private/set_session_key, module SET_SESSION_KEY_MODULE,
// subaccountId 0), scoped to placing option orders on the chosen subaccounts,
// and expiring after SESSION_TTL_SEC. The private key lives only in this tab's
// memory. Revoke = re-register the same key with the earliest expiry Derive
// accepts (now + 5 min); after that it can no longer sign.
// Encoding follows derive-py SessionKeyModuleData (address, uint256, uint256[], uint256[]).

import { AbiCoder, getAddress, Wallet, type HDNodeWallet } from "ethers";
import {
  SESSION_LABEL,
  SESSION_OFFCHAIN_SCOPES,
  SESSION_REVOKE_LEAD_SEC,
  SESSION_SAFETY_SEC,
  SESSION_SCOPES,
  SESSION_TTL_SEC,
  SESSION_MIN_LIFETIME_SEC,
  SET_SESSION_KEY_MODULE,
  type Network,
} from "../config.ts";
import { digest, increasingNonce, signDigestWithKey, type ActionFields } from "./signing.ts";
import type { ActionSigner } from "./signer.ts";
import type { Rpc } from "./trader.ts";

/** Protocol scope codes (derive-py data_types/enums.py _PROTOCOL_SCOPE_CODES). */
export const PROTOCOL_SCOPE_CODES: Record<string, number> = {
  admin: 0,
  withdraw: 1,
  "trade:all": 2,
  "trade:orderbook:all": 3,
  "trade:orderbook:spot": 4,
  "trade:orderbook:perp": 5,
  "trade:orderbook:option": 6,
  "trade:rfq:all": 7,
  "trade:rfq:spot": 8,
  "trade:rfq:perp": 9,
  "trade:rfq:option": 10,
  "transfer:all": 11,
  "transfer:existing_subaccount": 12,
  "transfer:new_subaccount": 13,
  "transfer:different_owner_subaccount": 14,
  create_session_key: 15,
  liquidate: 16,
};

export interface SessionKeyData {
  sessionKey: string;
  expirySec: number;
  protocolScopes: readonly string[];
  subaccountIds: readonly number[];
}

export function encodeSessionKeyData(d: SessionKeyData): string {
  if (!Number.isInteger(d.expirySec) || d.expirySec < 0) throw new Error("expiry must be a non-negative integer");
  const codes = d.protocolScopes.map((s) => {
    const c = PROTOCOL_SCOPE_CODES[s];
    if (c === undefined) throw new Error("unknown protocol scope " + s);
    return BigInt(c);
  });
  return AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "uint256[]", "uint256[]"],
    [getAddress(d.sessionKey), BigInt(d.expirySec), codes, d.subaccountIds.map((x) => BigInt(x))],
  );
}

export interface SessionKeyHandle {
  address: string;
  expirySec: number;
  subaccountIds: number[];
  scopes: string[];
  /** in-memory only, never persisted or logged */
  key: Wallet | HDNodeWallet;
}

/** Is a key with this expiry still safe to sign new orders with? */
export function sessionKeyUsable(expirySec: number, nowMs: number, safetySec = SESSION_SAFETY_SEC): boolean {
  return Number.isFinite(expirySec) && expirySec - nowMs / 1000 > safetySec;
}

/** Expiry for a fresh key: now + ttl, never shorter than Derive's 5-minute minimum. */
export function sessionExpiry(nowMs: number, ttlSec = SESSION_TTL_SEC): number {
  return Math.floor(nowMs / 1000) + Math.max(ttlSec, SESSION_MIN_LIFETIME_SEC + 60);
}

export interface SetSessionKeyParams {
  wallet: string;
  public_session_key: string;
  expiry_sec: number;
  protocol_scopes: string[];
  offchain_scopes: string[];
  subaccount_ids: number[];
  label: string;
  nonce: string;
  signer: string;
  signature: string;
  signature_expiry_sec: number;
}

/** The action the owner signs to (re)register a key, and the request that carries it. */
export function sessionKeyAction(owner: ActionSigner, d: SessionKeyData, nowMs: number): ActionFields {
  return {
    subaccountId: 0,
    nonce: increasingNonce(nowMs),
    module: SET_SESSION_KEY_MODULE,
    data: encodeSessionKeyData(d),
    expiry: Math.floor(nowMs / 1000) + 600,
    owner: owner.owner,
    signer: owner.signer,
  };
}

export async function buildSetSessionKey(owner: ActionSigner, d: SessionKeyData, nowMs: number): Promise<SetSessionKeyParams> {
  const a = sessionKeyAction(owner, d, nowMs);
  const signature = await owner.signAction(a);
  return {
    wallet: owner.owner,
    public_session_key: getAddress(d.sessionKey),
    expiry_sec: d.expirySec,
    protocol_scopes: [...d.protocolScopes],
    offchain_scopes: [...SESSION_OFFCHAIN_SCOPES],
    subaccount_ids: [...d.subaccountIds],
    label: SESSION_LABEL,
    nonce: a.nonce,
    signer: a.signer,
    signature,
    signature_expiry_sec: a.expiry,
  };
}

/** Create a key in memory and register it with one owner signature. */
export async function registerSessionKey(
  rpc: Rpc,
  owner: ActionSigner,
  subaccountIds: number[],
  nowMs: number,
  opts: { ttlSec?: number; key?: Wallet | HDNodeWallet } = {},
): Promise<SessionKeyHandle> {
  if (!subaccountIds.length) throw new Error("no subaccount to trade from");
  const key = opts.key ?? Wallet.createRandom();
  const expirySec = sessionExpiry(nowMs, opts.ttlSec);
  const data: SessionKeyData = { sessionKey: key.address, expirySec, protocolScopes: SESSION_SCOPES, subaccountIds };
  await rpc.call("private/set_session_key", await buildSetSessionKey(owner, data, nowMs));
  return { address: key.address, expirySec, subaccountIds: [...subaccountIds], scopes: [...SESSION_SCOPES], key };
}

/** Bring the key's expiry to the earliest time Derive allows. Needs the owner's signature. */
export async function revokeSessionKey(
  rpc: Rpc,
  owner: ActionSigner,
  k: { address: string; subaccountIds: number[]; scopes?: string[] },
  nowMs: number,
): Promise<number> {
  const expirySec = Math.floor(nowMs / 1000) + SESSION_REVOKE_LEAD_SEC;
  const data: SessionKeyData = { sessionKey: k.address, expirySec, protocolScopes: k.scopes ?? SESSION_SCOPES, subaccountIds: k.subaccountIds };
  await rpc.call("private/set_session_key", await buildSetSessionKey(owner, data, nowMs));
  return expirySec;
}

export class SessionKeyExpired extends Error {
  constructor() {
    super("One-tap trading key expired. Turn it on again or sign with your wallet.");
  }
}

/** An ActionSigner backed by a session key: no wallet prompt per order. */
export function sessionSigner(h: SessionKeyHandle, owner: string, net: Network, now: () => number = Date.now): ActionSigner {
  const privateKey = h.key.privateKey;
  return {
    owner: getAddress(owner),
    signer: h.address,
    silent: true,
    signLogin: (ts) => h.key.signMessage(ts),
    signAction: async (a) => {
      if (!sessionKeyUsable(h.expirySec, now())) throw new SessionKeyExpired();
      if (getAddress(a.signer) !== getAddress(h.address)) throw new Error("action signer is not this session key");
      return signDigestWithKey(privateKey, digest(a, net));
    },
  };
}

export interface ListedSessionKey {
  address: string;
  expirySec: number;
  label: string;
  scopes: string[];
  subaccountIds: number[];
}

/** private/session_keys → keys this app registered that have not expired yet. */
export function parseSessionKeys(raw: unknown, nowMs: number, label = SESSION_LABEL): ListedSessionKey[] {
  const list = (raw as { public_session_keys?: unknown[] } | null)?.public_session_keys;
  if (!Array.isArray(list)) return [];
  const out: ListedSessionKey[] = [];
  for (const r of list) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as Record<string, unknown>;
    const exp = Number(o.expiry_sec);
    if (typeof o.public_session_key !== "string" || !Number.isFinite(exp) || exp * 1000 <= nowMs) continue;
    if ((o.label ?? "") !== label) continue;
    out.push({
      address: o.public_session_key,
      expirySec: exp,
      label: String(o.label ?? ""),
      scopes: Array.isArray(o.protocol_scopes) ? o.protocol_scopes.map(String) : [],
      subaccountIds: Array.isArray(o.subaccount_ids) ? o.subaccount_ids.map(Number) : [],
    });
  }
  return out;
}
