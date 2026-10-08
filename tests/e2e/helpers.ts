import { expect, type Page } from "@playwright/test";
import { Wallet } from "ethers";
import pub from "../fixtures/testnet-public.json" with { type: "json" };

export const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // Hardhat #1, test-only
export const RECORDED_AT = pub.recordedAt;

/** Open the e2e build against the mock server, with the clock pinned to the recording time. */
export async function openApp(page: Page, scenario = "default", opts: { wallet?: boolean } = {}) {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.clock.install({ time: RECORDED_AT + 60_000 });
  if (opts.wallet !== false) await injectWallet(page);
  const ws = `ws://127.0.0.1:8787/ws?scenario=${scenario}`;
  await page.goto(`/?ws=${encodeURIComponent(ws)}`);
  await expect(page.locator("#liveTxt")).toContainText("Live · Derive testnet", { timeout: 15_000 });
}

/** An injected EIP-1193 provider whose signatures come from a fixed test key held in Node. */
export async function injectWallet(page: Page) {
  const w = new Wallet(TEST_KEY);
  let chainId = "0xaa36a7";
  const calls: string[] = [];
  await page.exposeFunction("__mockWallet", async (method: string, params: unknown[]) => {
    calls.push(method);
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [w.address];
      case "eth_chainId":
        return chainId;
      case "wallet_switchEthereumChain":
        chainId = (params[0] as { chainId: string }).chainId;
        return null;
      case "personal_sign":
        return w.signMessage(String(params[0]));
      case "eth_signTypedData_v4": {
        const td = JSON.parse(String(params[1]));
        if (Number(td.domain.chainId) !== parseInt(chainId, 16)) throw new Error("chainId mismatch");
        const { EIP712Domain: _d, ...types } = td.types;
        return w.signTypedData(td.domain, types, td.message);
      }
    }
    throw new Error("unsupported " + method);
  });
  await page.addInitScript(() => {
    const w = window as unknown as { ethereum: unknown; __mockWallet: (m: string, p: unknown[]) => Promise<unknown> };
    w.ethereum = { isMetaMask: true, request: ({ method, params }: { method: string; params?: unknown[] }) => w.__mockWallet(method, params ?? []) };
  });
  return { address: w.address, calls };
}

export async function connectWallet(page: Page) {
  await page.locator("#balBtn").click();
  await page.locator("#signIn").click();
}

export async function toReview(page: Page) {
  await expect(page.locator("#buy")).toBeEnabled();
  await page.locator("#buy").click();
  await expect(page.locator("#review .x-rh")).toBeVisible();
}
