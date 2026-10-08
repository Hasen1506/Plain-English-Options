import { expect, type Page } from "@playwright/test";
import { getBytes, isHexString, Interface, TypedDataEncoder, Wallet } from "ethers";
import WebSocket from "ws";
import pub from "../fixtures/testnet-public.json" with { type: "json" };

export const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // Hardhat #1, test-only
export const RECORDED_AT = pub.recordedAt;
const MOCK = "ws://127.0.0.1:8787/ws";

export interface WalletOpts {
  wallet?: boolean;
  /** "metamask-mobile": lowercase accounts, Sepolia unknown until added (4902 nested in -32603), hex-only personal_sign, strict typed data */
  flavour?: "desktop" | "metamask-mobile";
  usdc?: number; // wallet USDC balance (6 decimals)
}

/** Open the e2e build against the mock server, with the clock pinned to the recording time. */
export async function openApp(page: Page, scenario = "default", opts: WalletOpts = {}) {
  const sid = `${scenario}-${Math.random().toString(36).slice(2)}`;
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.clock.install({ time: RECORDED_AT + 60_000 });
  const w = opts.wallet !== false ? await injectWallet(page, sid, opts) : null;
  const ws = `${MOCK}?scenario=${scenario}&sid=${sid}`;
  await page.goto(`/?ws=${encodeURIComponent(ws)}`);
  await expect(page.locator("#liveTxt")).toContainText("Live · Derive testnet", { timeout: 15_000 });
  return { sid, wallet: w, mock: (method: string, params: object = {}) => mockCall(sid, scenario, method, params, w?.address) };
}

/** Talk to the mock exchange over its own socket (same sid = same state), logged in as the test wallet. */
export async function mockCall(sid: string, scenario: string, method: string, params: object, address?: string): Promise<unknown> {
  const ws = new WebSocket(`${MOCK}?scenario=${scenario}&sid=${sid}`);
  await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  let id = 0;
  const call = (m: string, p: object) =>
    new Promise<unknown>((resolve, reject) => {
      const my = ++id;
      const on = (buf: WebSocket.RawData) => {
        let msg: { id?: number; result?: unknown; error?: { message: string } };
        try {
          msg = JSON.parse(String(buf));
        } catch {
          return;
        }
        if (msg.id !== my) return;
        ws.off("message", on);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      };
      ws.on("message", on);
      ws.send(JSON.stringify({ id: my, method: m, params: p }));
    });
  try {
    if (method.startsWith("private/") || method === "mock/state") {
      const w = new Wallet(TEST_KEY);
      const ts = String(RECORDED_AT);
      await call("public/login", { wallet: address ?? w.address, timestamp: ts, signature: await w.signMessage(ts) });
    }
    return await call(method, params);
  } finally {
    ws.close();
  }
}

const ERC20 = new Interface(["function approve(address,uint256)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const AM = new Interface(["function deposit(address,uint256,uint64,address)", "function depositToNewSubaccount(address,uint256,uint32,address)"]);

/** An injected EIP-1193 provider whose signatures come from a fixed test key held in Node, with a tiny fake chain for deposits. */
export async function injectWallet(page: Page, sid: string, opts: WalletOpts = {}) {
  const w = new Wallet(TEST_KEY);
  const mobile = opts.flavour === "metamask-mobile";
  let chainId = mobile ? "0x1" : "0xaa36a7";
  const known = new Set(["0x1", ...(mobile ? [] : ["0xaa36a7"])]);
  const calls: string[] = [];
  const typedData: unknown[] = [];
  let usdc = BigInt(Math.round((opts.usdc ?? 5000) * 1e6));
  let allowance = 0n;
  let nonce = 0;
  const receipts = new Map<string, number>();
  await page.exposeFunction("__mockWallet", async (method: string, params: unknown[]) => {
    calls.push(method);
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [mobile ? w.address.toLowerCase() : w.address];
      case "eth_chainId":
        return chainId;
      case "wallet_switchEthereumChain": {
        const id = (params[0] as { chainId: string }).chainId;
        if (!known.has(id)) throw { code: -32603, message: "Internal JSON-RPC error.", data: { originalError: { code: 4902, message: `Unrecognized chain ID "${id}"` } } };
        chainId = id;
        return null;
      }
      case "wallet_addEthereumChain":
        known.add((params[0] as { chainId: string }).chainId);
        return null;
      case "personal_sign": {
        const m = String(params[0]);
        if (mobile && !isHexString(m)) throw new Error("expects hex");
        return w.signMessage(isHexString(m) ? getBytes(m) : m);
      }
      case "eth_signTypedData_v4": {
        if (typeof params[1] !== "string") throw new Error("typed data must be a JSON string");
        const td = JSON.parse(String(params[1]));
        if (Number(td.domain.chainId) !== parseInt(chainId, 16)) throw new Error("chainId mismatch");
        if (!td.types.EIP712Domain) throw new Error("EIP712Domain missing");
        if (mobile) for (const v of Object.values(td.message)) if (typeof v !== "string") throw new Error("message values must be strings");
        typedData.push(td);
        const { EIP712Domain: _d, ...types } = td.types;
        TypedDataEncoder.hash(td.domain, types, td.message); // throws on malformed data, as MetaMask would
        return w.signTypedData(td.domain, types, td.message);
      }
      case "eth_call": {
        const data = String((params[0] as { data: string }).data);
        const d = ERC20.parseTransaction({ data });
        if (d?.name === "balanceOf") return "0x" + usdc.toString(16);
        if (d?.name === "allowance") return "0x" + allowance.toString(16);
        return "0x";
      }
      case "eth_estimateGas": {
        const data = String((params[0] as { data: string }).data);
        if (data.startsWith(AM.getFunction("depositToNewSubaccount")!.selector) || data.startsWith(AM.getFunction("deposit")!.selector)) {
          if (allowance === 0n) throw new Error("execution reverted");
          return "0x30d40";
        }
        return "0xea60";
      }
      case "eth_gasPrice":
        return "0x77359400"; // 2 gwei
      case "eth_sendTransaction": {
        const tx = params[0] as { to: string; data: string };
        const hash = "0x" + (++nonce).toString(16).padStart(64, "0");
        const e = ERC20.parseTransaction({ data: tx.data });
        if (e?.name === "approve") allowance = e.args[1] as bigint;
        const a = AM.parseTransaction({ data: tx.data });
        if (a) {
          const amount = a.args[1] as bigint;
          if (amount > allowance || amount > usdc) throw new Error("execution reverted");
          allowance -= amount;
          usdc -= amount;
          const human = Number(amount) / 1e6;
          const scenario = sid.split("-")[0]!;
          await mockCall(sid, scenario, "mock/deposit", a.name === "deposit" ? { subaccountId: Number(a.args[2]), amount: human, txHash: hash } : { managerId: Number(a.args[2]), amount: human, txHash: hash });
        }
        receipts.set(hash, 0);
        return hash;
      }
      case "eth_getTransactionReceipt": {
        const hsh = String(params[0]);
        if (!receipts.has(hsh)) return null;
        return { status: "0x1", blockNumber: "0x10", transactionHash: hsh };
      }
    }
    throw new Error("unsupported " + method);
  });
  await page.addInitScript(() => {
    const w = window as unknown as { ethereum: unknown; __mockWallet: (m: string, p: unknown[]) => Promise<unknown> };
    w.ethereum = { isMetaMask: true, request: ({ method, params }: { method: string; params?: unknown[] }) => w.__mockWallet(method, params ?? []) };
  });
  return { address: w.address, calls, typedData, usdcLeft: () => usdc };
}

export async function connectWallet(page: Page, opts: { oneTap?: "skip" | "enable" | "none" } = { oneTap: "skip" }) {
  await page.locator("#balBtn").click();
  await page.locator("#signIn").click();
  if (opts.oneTap === "none") return;
  // after sign-in the app offers one-tap trading once
  await expect(page.locator("#tapOn")).toBeVisible();
  if (opts.oneTap === "enable") {
    await page.locator("#tapOn").click();
    await expect(page.locator("#sheet")).toBeHidden();
  } else await page.locator("#tapLater").click();
}

export async function toReview(page: Page) {
  await expect(page.locator("#buy")).toBeEnabled();
  await page.locator("#buy").click();
  await expect(page.locator("#review .x-rh")).toBeVisible();
}
