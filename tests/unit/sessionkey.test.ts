import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { AbiCoder, recoverAddress, Wallet } from "ethers";
import { NETWORKS, SESSION_REVOKE_LEAD_SEC, SESSION_SAFETY_SEC, SESSION_TTL_SEC, SET_SESSION_KEY_MODULE } from "../../src/config.ts";
import { keySigner } from "../../src/net/signer.ts";
import { digest, makeNonce } from "../../src/net/signing.ts";
import {
  buildSetSessionKey,
  encodeSessionKeyData,
  parseSessionKeys,
  registerSessionKey,
  revokeSessionKey,
  SessionKeyExpired,
  sessionExpiry,
  sessionKeyAction,
  sessionKeyUsable,
  sessionSigner,
} from "../../src/net/sessionKey.ts";

const OWNER = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // Hardhat #1, test-only
const SK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // Hardhat #2, test-only
const net = NETWORKS.testnet;
const T0 = Date.UTC(2026, 9, 8, 6, 0, 0);

function recorder() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  return { calls, call: async <T,>(method: string, params: object = {}) => (calls.push({ method, params: params as Record<string, unknown> }), {} as T) };
}

describe("session key registration", () => {
  it("encodes (address, uint256 expiry, uint256[] scope codes, uint256[] subaccounts) like derive-py", () => {
    const k = new Wallet(SK).address;
    const enc = encodeSessionKeyData({ sessionKey: k, expirySec: 1793491200, protocolScopes: ["trade:orderbook:option"], subaccountIds: [87139] });
    const [a, e, s, subs] = AbiCoder.defaultAbiCoder().decode(["address", "uint256", "uint256[]", "uint256[]"], enc);
    expect(a).toBe(k);
    expect(e).toBe(1793491200n);
    expect([...s]).toEqual([6n]);
    expect([...subs]).toEqual([87139n]);
    expect(() => encodeSessionKeyData({ sessionKey: k, expirySec: 1, protocolScopes: ["moon"], subaccountIds: [] })).toThrow(/unknown/);
  });

  it("is signed by the owner over subaccount 0 and the set-session-key module, and the signature recovers the owner", async () => {
    const owner = keySigner(OWNER, net);
    const k = new Wallet(SK).address;
    const d = { sessionKey: k, expirySec: sessionExpiry(T0), protocolScopes: ["trade:orderbook:option"], subaccountIds: [87139] };
    const a = sessionKeyAction(owner, d, T0);
    expect(a.subaccountId).toBe(0);
    expect(a.module).toBe(SET_SESSION_KEY_MODULE);
    const p = await buildSetSessionKey(owner, d, T0);
    expect(p.wallet).toBe(owner.owner);
    expect(p.signer).toBe(owner.owner);
    expect(p.protocol_scopes).toEqual(["trade:orderbook:option"]);
    expect(p.offchain_scopes).toEqual(["account_info"]);
    expect(p.subaccount_ids).toEqual([87139]);
    const rec = recoverAddress(digest({ ...a, nonce: p.nonce, expiry: p.signature_expiry_sec }, net), p.signature);
    expect(rec).toBe(owner.owner);
  });

  it("registers a fresh in-memory key for 24 h and revoke re-registers it with the earliest allowed expiry", async () => {
    const rpc = recorder();
    const owner = keySigner(OWNER, net);
    const h = await registerSessionKey(rpc, owner, [87139], T0);
    expect(h.expirySec).toBe(Math.floor(T0 / 1000) + SESSION_TTL_SEC);
    expect(rpc.calls[0]!.method).toBe("private/set_session_key");
    expect(rpc.calls[0]!.params.public_session_key).toBe(h.address);
    expect(JSON.stringify(rpc.calls)).not.toContain(h.key.privateKey.slice(2)); // the private key never leaves the tab
    const until = await revokeSessionKey(rpc, owner, h, T0 + 1000);
    expect(until).toBe(Math.floor((T0 + 1000) / 1000) + SESSION_REVOKE_LEAD_SEC);
    expect(rpc.calls[1]!.params.expiry_sec).toBe(until);
    expect(BigInt(rpc.calls[1]!.params.nonce as string)).toBeGreaterThan(BigInt(rpc.calls[0]!.params.nonce as string));
  });

  it("refuses to register a key with no subaccount", async () => {
    await expect(registerSessionKey(recorder(), keySigner(OWNER, net), [], T0)).rejects.toThrow(/subaccount/);
  });
});

describe("session key expiry (property)", () => {
  it("usable iff more than the safety margin remains", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1_700_000_000, max: 2_000_000_000 }), fc.integer({ min: -100_000, max: 100_000 }), (exp, dt) => {
        const now = (exp - dt) * 1000;
        return sessionKeyUsable(exp, now) === dt > SESSION_SAFETY_SEC;
      }),
      { numRuns: 2000 },
    );
  });

  it("a fresh key always outlives Derive's 5-minute minimum by a margin", () => {
    fc.assert(fc.property(fc.integer({ min: 1_600_000_000_000, max: 2_000_000_000_000 }), fc.integer({ min: 0, max: 400 }), (now, ttl) => sessionExpiry(now, ttl) - Math.floor(now / 1000) >= 360), { numRuns: 500 });
  });

  it("the session signer signs as the key for the owner until expiry, then refuses", async () => {
    let now = T0;
    const k = new Wallet(SK);
    const h = { address: k.address, expirySec: Math.floor(T0 / 1000) + 600, subaccountIds: [1], scopes: ["trade:orderbook:option"], key: k };
    const s = sessionSigner(h, new Wallet(OWNER).address, net, () => now);
    expect(s.silent).toBe(true);
    expect(s.signer).toBe(k.address);
    const a = { subaccountId: 1, nonce: makeNonce(T0), module: net.tradeModule, data: "0x", expiry: Math.floor(T0 / 1000) + 300, owner: s.owner, signer: s.signer };
    expect(recoverAddress(digest(a, net), await s.signAction(a))).toBe(k.address);
    now = (h.expirySec - SESSION_SAFETY_SEC) * 1000;
    await expect(s.signAction(a)).rejects.toBeInstanceOf(SessionKeyExpired);
    now = T0;
    await expect(s.signAction({ ...a, signer: s.owner })).rejects.toThrow(/not this session key/);
  });

  it("lists only this app's unexpired keys", () => {
    const r = {
      public_session_keys: [
        { public_session_key: "0x1", expiry_sec: T0 / 1000 + 10, label: "plain-english-options", protocol_scopes: ["trade:orderbook:option"], subaccount_ids: [1] },
        { public_session_key: "0x2", expiry_sec: T0 / 1000 - 10, label: "plain-english-options" },
        { public_session_key: "0x3", expiry_sec: T0 / 1000 + 10, label: "bot" },
        "junk",
      ],
    };
    expect(parseSessionKeys(r, T0).map((k) => k.address)).toEqual(["0x1"]);
    expect(parseSessionKeys(null, T0)).toEqual([]);
  });
});
