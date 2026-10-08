// Hyperliquid signing vs the OFFICIAL Python SDK (tests/fixtures/hyperliquid/sign-vectors.json,
// written by scripts/hl/gen_vectors.py with hyperliquid-python-sdk 0.24.0):
//   * "official": the SDK's own known-answer tests (tests/signing_test.py)
//   * "generated": orders/cancels/leverage/approveAgent/withdraw3 shaped like the app's, signed by the SDK
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { SigningKey, Wallet } from "ethers";
import vectors from "../fixtures/hyperliquid/sign-vectors.json" with { type: "json" };
import { packb } from "../../src/venues/hyperliquid/msgpack.ts";
import { actionHash, recoverL1, signL1, userTyped, userDigest, recoverUser, walletPayload, APPROVE_AGENT_TYPES, WITHDRAW_TYPES, approveAgentAction, withdrawAction, splitSig } from "../../src/venues/hyperliquid/signing.ts";
import type { Packable } from "../../src/venues/hyperliquid/msgpack.ts";

type V = { name: string; kind: string; action: Record<string, unknown>; vault?: string | null; nonce?: number; expiresAfter?: number | null; mainnet?: boolean; connectionId?: string; primaryType?: string; sig: { r: string; s: string; v: number } };
const key = new SigningKey(vectors.key);
const big = (h: string) => BigInt(h);
const TYPES: Record<string, typeof WITHDRAW_TYPES> = {
  "HyperliquidTransaction:Withdraw": WITHDRAW_TYPES,
  "HyperliquidTransaction:UsdSend": WITHDRAW_TYPES,
  "HyperliquidTransaction:ApproveAgent": APPROVE_AGENT_TYPES,
};

function check(v: V) {
  if (v.kind === "l1") {
    expect(actionHash(v.action as Packable, v.vault ?? null, v.nonce!, v.expiresAfter ?? null), v.name).toBe(v.connectionId);
    const s = signL1(key, v.action as Packable, v.nonce!, v.mainnet!, v.vault ?? null, v.expiresAfter ?? null);
    expect(big(s.r), v.name).toBe(big(v.sig.r));
    expect(big(s.s), v.name).toBe(big(v.sig.s));
    expect(s.v, v.name).toBe(v.sig.v);
    expect(recoverL1(v.action as Packable, s, v.nonce!, v.mainnet!, v.vault ?? null, v.expiresAfter ?? null)).toBe(vectors.address);
  } else {
    const t = userTyped(v.primaryType!, TYPES[v.primaryType!]!, v.action);
    const s = key.sign(userDigest(t));
    expect(big(s.r), v.name).toBe(big(v.sig.r));
    expect(big(s.s), v.name).toBe(big(v.sig.s));
    expect(s.v, v.name).toBe(v.sig.v);
  }
}

describe("hyperliquid signing: official SDK known-answer vectors", () => {
  it("has every vector of the SDK test file", () => expect(vectors.official.length).toBe(15));
  for (const v of vectors.official as V[]) it(v.name, () => check(v));
});

describe("hyperliquid signing: SDK-generated vectors shaped like the app's actions", () => {
  it("covers orders, triggers, ALO, expiresAfter, cancels, leverage, approveAgent, withdraw3", () => {
    const names = (vectors.generated as V[]).map((v) => v.name).join(" ");
    for (const w of ["Gtc", "Ioc", "Alo", "tp", "sl", "cancel", "updateLeverage", "approveAgent", "withdraw3"]) expect(names).toContain(w);
    expect((vectors.generated as V[]).some((v) => v.expiresAfter)).toBe(true);
  });
  for (const v of vectors.generated as V[]) it(v.name, () => check(v));
});

describe("msgpack encoder", () => {
  it("matches hand-checked encodings at every size boundary", () => {
    const hex = (x: Packable) => Buffer.from(packb(x)).toString("hex");
    expect(hex(0)).toBe("00");
    expect(hex(127)).toBe("7f");
    expect(hex(128)).toBe("cc80");
    expect(hex(255)).toBe("ccff");
    expect(hex(256)).toBe("cd0100");
    expect(hex(65536)).toBe("ce00010000");
    expect(hex(4294967296)).toBe("cf0000000100000000");
    expect(hex(-1)).toBe("ff");
    expect(hex(-33)).toBe("d0df");
    expect(hex("a".repeat(31))).toBe("bf" + "61".repeat(31));
    expect(hex("a".repeat(32))).toBe("d920" + "61".repeat(32));
    expect(hex(null)).toBe("c0");
    expect(hex([true, false])).toBe("92c3c2");
    expect(hex({ a: 1 })).toBe("81a16101");
  });
  it("refuses floats (prices/sizes must be strings)", () => {
    expect(() => packb(1.5)).toThrow(/non-integer/);
  });
  it("preserves key order (Python dict order)", () => {
    expect(Buffer.from(packb({ b: 1, a: 2 })).toString("hex")).toBe("82a16201a16102");
  });
});

describe("user-signed actions from the wallet's point of view", () => {
  it("approveAgent: the wallet payload is valid EIP-712 JSON and recovers the user (any signatureChainId)", async () => {
    const w = new Wallet(vectors.key);
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(1, 42161, 421614, 8453, 11155111), fc.boolean(), fc.integer({ min: 1_700_000_000_000, max: 1_900_000_000_000 }), async (chainId, mainnet, nonce) => {
        const a = approveAgentAction({ mainnet, chainId, agent: Wallet.createRandom().address, name: `peo valid_until ${nonce + 86_400_000}`, nonce });
        const t = userTyped("HyperliquidTransaction:ApproveAgent", APPROVE_AGENT_TYPES, a);
        const j = JSON.parse(walletPayload(t));
        expect(j.domain.chainId).toBe(chainId);
        expect(j.types.EIP712Domain).toHaveLength(4);
        const { EIP712Domain: _d, ...types } = j.types;
        const sig = splitSig(await w.signTypedData(j.domain, types, j.message));
        expect(recoverUser(t, sig)).toBe(w.address);
      }),
      { numRuns: 25 },
    );
  });
  it("withdraw3 refuses amounts that are not plain decimals", () => {
    expect(() => withdrawAction({ mainnet: false, chainId: 421614, destination: vectors.address, amount: "1e3", time: 1 })).toThrow();
  });
  it("mainnet and testnet signatures of the same L1 action differ (no cross-network replay)", () => {
    const a = { type: "cancel", cancels: [{ a: 1, o: 5 }] };
    expect(signL1(key, a, 1, true).r).not.toBe(signL1(key, a, 1, false).r);
  });
});
