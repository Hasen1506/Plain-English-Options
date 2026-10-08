// MetaMask (desktop and the mobile in-app browser) behaviour the injected-provider flow must survive.
import { describe, expect, it } from "vitest";
import { getAddress, getBytes, isHexString, TypedDataEncoder, verifyMessage, Wallet } from "ethers";
import { NETWORKS } from "../../src/config.ts";
import { ensureChain, friendlyWalletError, walletErrorCode, walletSigner, type Eip1193 } from "../../src/net/signer.ts";
import { digest, makeNonce } from "../../src/net/signing.ts";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // Hardhat #1, test-only

/** Emulates MetaMask mobile: lowercase accounts, Sepolia hidden until added, strict typed-data checks, hex personal_sign. */
function metamaskMobile(opts: { sepoliaKnown?: boolean; lagSwitch?: number } = {}) {
  const w = new Wallet(KEY);
  let chain = "0x1";
  let known = new Set(["0x1", ...(opts.sepoliaKnown ? ["0xaa36a7"] : [])]);
  let lag = 0;
  const log: string[] = [];
  const p: Eip1193 = {
    async request({ method, params }) {
      log.push(method);
      const a = (params ?? []) as unknown[];
      switch (method) {
        case "eth_requestAccounts":
          return [w.address.toLowerCase()];
        case "eth_chainId":
          if (lag > 0) {
            lag--;
            return "0x1";
          }
          return chain;
        case "wallet_switchEthereumChain": {
          const id = (a[0] as { chainId: string }).chainId;
          // MetaMask mobile wraps 4902 inside an internal error
          if (!known.has(id)) throw { code: -32603, message: "Internal JSON-RPC error.", data: { originalError: { code: 4902, message: `Unrecognized chain ID "${id}"` } } };
          chain = id;
          lag = opts.lagSwitch ?? 0;
          return null;
        }
        case "wallet_addEthereumChain":
          known = new Set([...known, (a[0] as { chainId: string }).chainId]);
          return null;
        case "personal_sign": {
          const m = String(a[0]);
          if (!isHexString(m)) throw new Error("mobile expects hex");
          if (getAddress(String(a[1])) !== w.address) throw new Error("wrong account");
          return w.signMessage(getBytes(m));
        }
        case "eth_signTypedData_v4": {
          if (typeof a[1] !== "string") throw new Error("typed data must be a JSON string");
          const td = JSON.parse(a[1]);
          if (!td.types.EIP712Domain) throw new Error("EIP712Domain missing");
          if (Number(td.domain.chainId) !== parseInt(chain, 16)) throw { code: -32603, message: `Provided chainId "${td.domain.chainId}" must match the active chainId "${parseInt(chain, 16)}"` };
          for (const v of Object.values(td.message)) if (typeof v !== "string") throw new Error("message values must be strings");
          const { EIP712Domain: _d, ...types } = td.types;
          return w.signTypedData(td.domain, types, td.message);
        }
      }
      throw new Error("unsupported " + method);
    },
  };
  return { p, w, log };
}

describe("MetaMask mobile flow", () => {
  it("login signs the hex-encoded timestamp; the signature verifies against the plain timestamp (what Derive checks)", async () => {
    const { p, w } = metamaskMobile();
    const acct = ((await p.request({ method: "eth_requestAccounts" })) as string[])[0]!;
    const s = walletSigner(p, acct, NETWORKS.mainnet);
    expect(s.owner).toBe(w.address); // lowercase account normalised
    const ts = "1791426680140";
    expect(verifyMessage(ts, await s.signLogin(ts))).toBe(w.address);
  });

  it("adds Sepolia when the wallet does not know it (4902 nested in -32603), then signs testnet typed data", async () => {
    const { p, w, log } = metamaskMobile({ sepoliaKnown: false });
    const s = walletSigner(p, w.address, NETWORKS.testnet);
    const a = { subaccountId: 1, nonce: makeNonce(), module: NETWORKS.testnet.tradeModule, data: "0x", expiry: 2_000_000_000, owner: w.address, signer: w.address };
    const sig = await s.signAction(a);
    expect(log).toContain("wallet_addEthereumChain");
    const { recoverAddress } = await import("ethers");
    expect(recoverAddress(digest(a, NETWORKS.testnet), sig)).toBe(w.address);
  });

  it("waits out a wallet that reports the old chain for a moment after switching", async () => {
    const { p, w } = metamaskMobile({ sepoliaKnown: true, lagSwitch: 2 });
    await ensureChain(p, 11155111);
    expect(await p.request({ method: "eth_chainId" })).toBe("0xaa36a7");
    expect(w.address).toBeTruthy();
  });

  it("switches to chain 1 for mainnet and the signed typed data hashes to the action digest", async () => {
    const { p, w } = metamaskMobile({ sepoliaKnown: true });
    await ensureChain(p, 11155111);
    const s = walletSigner(p, w.address, NETWORKS.mainnet);
    const a = { subaccountId: 9, nonce: makeNonce(), module: NETWORKS.mainnet.tradeModule, data: "0xabcd", expiry: 2_000_000_000, owner: w.address, signer: w.address };
    const sig = await s.signAction(a);
    expect(await p.request({ method: "eth_chainId" })).toBe("0x1");
    const { recoverAddress } = await import("ethers");
    expect(recoverAddress(digest(a, NETWORKS.mainnet), sig)).toBe(w.address);
    expect(TypedDataEncoder.hashDomain({ name: "Matching", version: "1.0", chainId: 1, verifyingContract: "0xeB8d770ec18DB98Db922E9D83260A585b9F0DeAD" })).toBe(NETWORKS.mainnet.domainSeparator);
  });

  it("turns wallet errors into sentences (user rejection 4001, pending request -32002, nested codes)", () => {
    expect(friendlyWalletError({ code: 4001, message: "User rejected the request." }).message).toMatch(/rejected/);
    expect(friendlyWalletError({ code: -32603, data: { originalError: { code: 4001 } } }).message).toMatch(/rejected/);
    expect(friendlyWalletError({ code: -32002, message: "already pending" }).message).toMatch(/already has a request/);
    expect(walletErrorCode({ data: { originalError: { code: 4902 } } })).toBe(4902);
    expect(friendlyWalletError(new Error("boom")).message).toBe("boom");
  });

  it("a rejected chain switch surfaces as a rejection, not a hang", async () => {
    const p: Eip1193 = { request: async ({ method }) => (method === "eth_chainId" ? "0xaa36a7" : Promise.reject({ code: 4001, message: "User rejected" })) };
    await expect(ensureChain(p, 1)).rejects.toThrow(/rejected/);
  });
});
