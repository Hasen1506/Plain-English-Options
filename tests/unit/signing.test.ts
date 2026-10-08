import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { keccak256, recoverAddress, toUtf8Bytes, TypedDataEncoder, Wallet, verifyMessage } from "ethers";
import { ACTION_TYPEHASH, NETWORKS } from "../../src/config.ts";
import { actionHash, digest, domainSeparatorFor, encodeTradeData, encodeTradeDataAbi, makeNonce, typedDataFor, type ActionFields, type TradeData } from "../../src/net/signing.ts";
import { keySigner, walletSigner } from "../../src/net/signer.ts";
import vector from "../fixtures/order-debug-vector.json" with { type: "json" };

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // well-known Hardhat test key #1, never funded
const addr = fc.uint8Array({ minLength: 20, maxLength: 20 }).map((b) => "0x" + Buffer.from(b).toString("hex"));
const dec12 = (max: number) => fc.integer({ min: 0, max }).chain((w) => fc.integer({ min: 0, max: 999_999_999_999 }).map((f) => `${w}.${String(f).padStart(12, "0")}`));
const tradeArb: fc.Arbitrary<TradeData> = fc.record({
  assetAddress: addr,
  subId: fc.bigInt({ min: 0n, max: 2n ** 128n - 1n }).map(String),
  limitPrice: dec12(1_000_000),
  amount: dec12(100_000),
  maxFee: dec12(10_000),
  recipientId: fc.integer({ min: 0, max: 2 ** 40 }),
  isBid: fc.boolean(),
});

describe("EIP-712 action signing", () => {
  it("action typehash and both domain separators are what the protocol publishes", () => {
    expect(keccak256(toUtf8Bytes("Action(uint256 subaccountId,uint256 nonce,address module,bytes data,uint256 expiry,address owner,address signer)"))).toBe(ACTION_TYPEHASH);
    expect(domainSeparatorFor(11155111)).toBe(NETWORKS.testnet.domainSeparator);
    expect(domainSeparatorFor(1)).toBe(NETWORKS.mainnet.domainSeparator);
  });

  it("matches the digest the testnet computed in private/order_debug", () => {
    const a = vector.action as ActionFields;
    expect(digest(a, NETWORKS.testnet)).toBe(vector.typed_data_hash);
    expect(a.data).toBe(vector.encoded_data);
  });

  it("hand-rolled trade encoding equals the generic ABI encoder", () => {
    fc.assert(fc.property(tradeArb, (d) => encodeTradeData(d) === encodeTradeDataAbi(d)), { numRuns: 3000 });
  });

  it("eth_signTypedData_v4 payload hashes to the same digest (so wallets sign what the exchange checks)", () => {
    fc.assert(
      fc.property(tradeArb, addr, addr, fc.integer({ min: 0, max: 2 ** 40 }), fc.constantFrom(NETWORKS.testnet, NETWORKS.mainnet), (d, owner, signer, sub, net) => {
        const a: ActionFields = { subaccountId: sub, nonce: makeNonce(1_791_000_000_000), module: net.tradeModule, data: encodeTradeData(d), expiry: 1_791_000_600, owner, signer };
        const td = typedDataFor(a, net);
        const { EIP712Domain: _drop, ...types } = td.types;
        expect(TypedDataEncoder.hash(td.domain, types, td.message)).toBe(digest(a, net));
      }),
      { numRuns: 500 },
    );
  });

  it("a key signature recovers to the signer", async () => {
    const s = keySigner(KEY, NETWORKS.testnet);
    const a: ActionFields = { subaccountId: 1, nonce: "1", module: NETWORKS.testnet.tradeModule, data: "0x1234", expiry: 2, owner: s.owner, signer: s.signer };
    const sig = await s.signAction(a);
    expect(recoverAddress(digest(a, NETWORKS.testnet), sig)).toBe(s.signer);
    expect(verifyMessage("123", await s.signLogin("123"))).toBe(s.signer);
    expect(actionHash(a)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("an injected wallet is asked for typed data on the right chain", async () => {
    const w = new Wallet(KEY);
    const calls: string[] = [];
    let chain = "0x1";
    const provider = {
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        calls.push(method);
        if (method === "eth_chainId") return chain;
        if (method === "wallet_switchEthereumChain") return void (chain = (params as { chainId: string }[])[0]!.chainId);
        if (method === "eth_signTypedData_v4") {
          const td = JSON.parse((params as string[])[1]!);
          const { EIP712Domain: _d, ...types } = td.types;
          return w.signTypedData(td.domain, types, td.message);
        }
        throw new Error("unexpected " + method);
      },
    };
    const s = walletSigner(provider, w.address, NETWORKS.testnet);
    const a: ActionFields = { subaccountId: 7, nonce: "99", module: NETWORKS.testnet.tradeModule, data: "0xabcd", expiry: 3, owner: w.address, signer: w.address };
    const sig = await s.signAction(a);
    expect(recoverAddress(digest(a, NETWORKS.testnet), sig)).toBe(w.address);
    expect(calls).toEqual(["eth_chainId", "wallet_switchEthereumChain", "eth_chainId", "eth_signTypedData_v4"]); // re-checked after the switch
  });

  it("refuses malformed keys without echoing them", () => {
    try {
      keySigner("not-a-key-but-secret", NETWORKS.testnet);
      throw new Error("should have thrown");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("secret");
    }
  });

  it("rejects amounts finer than the protocol's 1e12 precision", () => {
    expect(() => encodeTradeData({ assetAddress: "0x" + "11".repeat(20), subId: "1", limitPrice: "1.0000000000001", amount: "1", maxFee: "1", recipientId: 1, isBid: true })).toThrow(/12 decimals/);
  });
});
