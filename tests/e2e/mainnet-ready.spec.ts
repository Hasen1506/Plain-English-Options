import { expect, test } from "@playwright/test";
import { connectWallet, openApp, toReview } from "./helpers.ts";

const setAmount = async (page: import("@playwright/test").Page, v: string) => {
  await page.locator("[data-pop=amt]").click();
  await page.locator("#popIn").fill(v);
  await page.locator("#popIn").press("Enter");
  await page.keyboard.press("Escape");
};

test.describe("one-tap trading (session key)", () => {
  test("one wallet signature enables it; the spread then needs no wallet prompt; disconnect revokes it", async ({ page }) => {
    const app = await openApp(page);
    await connectWallet(page, { oneTap: "enable" });
    await expect(page.locator("#balNet")).toContainText("one-tap");
    const signed = app.wallet!.typedData.length;
    expect(signed).toBe(1); // only the set_session_key action
    await setAmount(page, "100");
    await toReview(page);
    await expect(page.locator("#signedBy")).toHaveText("One-tap key (no wallet prompt)");
    await page.locator("#agree").check();
    await page.locator("#confirm").click();
    await expect(page.locator("#done h2")).toHaveText("Position opened", { timeout: 15_000 });
    expect(app.wallet!.typedData.length).toBe(signed); // no wallet prompt for the orders
    const st = (await app.mock("mock/state")) as { orderSigners: string[]; keyCalls: { key: string; expiry: number }[] };
    const key = await page.evaluate(() => (window as unknown as { __peo: { state: () => { wallet: { sessionKey: string } } } }).__peo.state().wallet.sessionKey);
    expect(st.orderSigners).toEqual([key, key]);
    expect(st.keyCalls).toHaveLength(1);

    // disconnect revokes (one more wallet signature) and forgets the key
    await page.locator("#balBtn").click();
    await expect(page.locator("#tapState")).toContainText("One-tap trading on until");
    await page.locator("#signOut").click();
    await expect(page.locator("#bal")).toHaveText("Connect wallet");
    const st2 = (await app.mock("mock/state")) as { keyCalls: { key: string; expiry: number }[] };
    expect(st2.keyCalls).toHaveLength(2);
    expect(st2.keyCalls[1]!.key).toBe(key);
    expect(st2.keyCalls[1]!.expiry).toBeLessThan(st2.keyCalls[0]!.expiry);
    expect(app.wallet!.typedData.length).toBe(signed + 1);
  });

  test("without one-tap every order is a wallet prompt (3 signatures)", async ({ page }) => {
    const app = await openApp(page);
    await connectWallet(page);
    await setAmount(page, "100");
    await toReview(page);
    await expect(page.locator("#signedBy")).toHaveText("Your wallet (3 prompts)");
    await page.locator("#agree").check();
    await page.locator("#confirm").click();
    await expect(page.locator("#done h2")).toHaveText("Position opened", { timeout: 15_000 });
    expect(app.wallet!.typedData.length).toBe(3);
  });
});

test.describe("onboarding, deposit and withdraw", () => {
  test("a wallet with no Derive account is guided through approve + deposit into a new RU1 subaccount, then signs in", async ({ page }) => {
    const app = await openApp(page, "noaccount");
    await page.locator("#balBtn").click();
    await page.locator("#signIn").click();
    await expect(page.locator("#sheetBody h2")).toHaveText("Open your Derive testnet account");
    await expect(page.locator("#noAccountNote")).toBeVisible();
    await expect(page.locator("#sheetBody")).toContainText("risk universe 1 (PRIME)");
    await expect(page.locator("#depWallet")).toContainText("5000 USDC");
    await page.locator("#depAmt").fill("4");
    await expect(page.locator("#depStep")).toContainText("Minimum deposit is $5");
    await expect(page.locator("#depGo")).toBeDisabled();
    await page.locator("#depAmt").fill("750");
    await page.locator("#depGo").click();
    await expect(page.locator("#depSteps li")).toHaveCount(2);
    await expect(page.locator("#depSteps li").nth(0)).toContainText("Approve 750 USDC");
    await expect(page.locator("#depSteps li").nth(1)).toContainText("new subaccount");
    await expect(page.locator("#depGas")).toContainText("about"); // the deposit cannot be simulated before its approve
    await expect(page.locator("#depGo")).toHaveText("Approve and deposit");
    await page.locator("#depGo").click();
    await expect(page.locator("#depStep")).toContainText("Deposit confirmed on-chain", { timeout: 15_000 });
    await expect(page.locator("#depSteps li.is-done")).toHaveCount(2);
    expect(app.wallet!.usdcLeft()).toBe(4250n * 10n ** 6n);
    await expect(page.locator("#depPending")).toContainText("confirmed");
    await page.locator("#depSignIn").click();
    await expect(page.locator("#tapOn")).toBeVisible(); // signed in: one-tap is offered
    await page.locator("#tapLater").click();
    await expect(page.locator("#bal")).toHaveText("$750.00");
    await expect(page.locator("#balNet")).toContainText("RU1");
  });

  test("deposit into the existing subaccount, then withdraw with a wallet signature", async ({ page }) => {
    await openApp(page);
    await connectWallet(page);
    await expect(page.locator("#bal")).toHaveText("$2,000.00");
    await page.locator("#balBtn").click();
    await page.locator("#depBtn").click();
    await expect(page.locator("#sheetBody h2")).toHaveText("Deposit to #87139");
    await page.locator("#depAmt").fill("50");
    await page.locator("#depGo").click();
    await expect(page.locator("#depSteps li")).toHaveCount(2);
    await page.locator("#depGo").click();
    await expect(page.locator("#depStep")).toContainText("Credited", { timeout: 15_000 });
    await expect(page.locator("#bal")).toHaveText("$2,050.00");
    await page.locator("#sheetClose").click();

    await page.locator("#balBtn").click();
    await page.locator("#wdBtn").click();
    await page.locator("#wdAmt").fill("10");
    await page.locator("#wdGo").click();
    await expect(page.locator("#wdStep")).toContainText("Withdrawal accepted · operation mock-withdraw-", { timeout: 10_000 });
    await expect(page.locator("#bal")).toHaveText("$2,040.00", { timeout: 10_000 });
  });

  test("mainnet deposits show the network fee and need REAL MONEY typed", async ({ page }) => {
    await openApp(page);
    await page.locator("#builder [data-net=mainnet]").click();
    await expect(page.locator("#liveTxt")).toContainText("Live · Derive mainnet", { timeout: 15_000 });
    await expect(page.locator("#balNet .x-chip-real")).toHaveText("REAL MONEY");
    await connectWallet(page);
    await page.locator("#balBtn").click();
    await page.locator("#depBtn").click();
    await expect(page.locator(".x-real")).toContainText("Real money");
    await page.locator("#depAmt").fill("25");
    await page.locator("#depGo").click();
    await expect(page.locator("#depGas")).toContainText("ETH");
    await expect(page.locator("#depGas")).toContainText("paid to the network");
    await expect(page.locator("#depGo")).toHaveText("Type REAL MONEY to deposit");
    await expect(page.locator("#depGo")).toBeDisabled();
    await page.locator("#depReal").fill("real money");
    await expect(page.locator("#depGo")).toHaveText("Approve and deposit real money");
    await expect(page.locator("#depGo")).toBeEnabled();
    // never pressed: tests do not move mainnet funds
  });
});

test.describe("dry run, kill switch, history, limits", () => {
  test("Check order (no trade) proves both signatures with order_debug and sends no order", async ({ page }) => {
    const app = await openApp(page);
    await connectWallet(page);
    await toReview(page);
    await page.locator("#checkOrder").click();
    await expect(page.locator("#checkStep")).toContainText("Derive verified both signatures on testnet. No order was sent.");
    const st = (await app.mock("mock/state")) as { orderSigners: string[]; debugCalls: number };
    expect(st.debugCalls).toBe(2);
    expect(st.orderSigners).toEqual([]);
  });

  test("Cancel all clears every open order", async ({ page }) => {
    await openApp(page, "openorder");
    await connectWallet(page);
    await page.locator("[data-view=portfolio]").click();
    await expect(page.locator("#orders tbody tr")).toHaveCount(1);
    await page.locator("#cancelAll").click();
    await expect(page.locator("#portStep")).toContainText("All open orders cancelled");
    await expect(page.locator("#portfolio")).toContainText("No open orders.", { timeout: 10_000 });
  });

  test("History shows trades, orders and the realised P&L of a closed spread", async ({ page }) => {
    await openApp(page);
    await connectWallet(page, { oneTap: "enable" });
    await setAmount(page, "100");
    await toReview(page);
    await page.locator("#agree").check();
    await page.locator("#confirm").click();
    await expect(page.locator("#done h2")).toHaveText("Position opened", { timeout: 15_000 });
    await page.locator("#toPort").click();
    await page.locator("[data-close-spread]").click();
    await expect(page.locator("#portfolio")).toContainText("No open positions.", { timeout: 10_000 });
    await page.locator("[data-view=history]").click();
    await expect(page.locator("#closedSpreads tbody tr")).toHaveCount(1);
    await expect(page.locator("#trades tbody tr")).toHaveCount(4);
    await expect(page.locator("#orderHistory tbody tr")).toHaveCount(4);
    await expect(page.locator("#pnlTotal")).toContainText("Realised on closed spreads: −$");
  });

  test("the mainnet per-trade limit is off by default, and when set it blocks a bigger trade", async ({ page }) => {
    await openApp(page);
    await page.locator("#builder [data-net=mainnet]").click();
    await expect(page.locator("#liveTxt")).toContainText("Live · Derive mainnet", { timeout: 15_000 });
    await connectWallet(page);
    await toReview(page);
    await page.locator("#agree").check();
    await page.locator("#realIn").fill("REAL MONEY");
    await expect(page.locator("#confirm")).toContainText("Pay real money"); // no default cap
    await page.locator("#edit").click();
    await page.locator("[data-view=portfolio]").click();
    await page.locator("#maxCostIn").fill("1");
    await page.locator("#maxCostSave").click();
    await expect(page.locator("#portStep")).toContainText("limited to $1.00 each");
    await page.locator("[data-view=build]").click();
    await toReview(page);
    await page.locator("#agree").check();
    await page.locator("#realIn").fill("REAL MONEY");
    await expect(page.locator("#confirm")).toHaveText("Above your $1.00 limit per trade");
    await expect(page.locator("#confirm")).toBeDisabled();
    // never pressed: tests do not trade mainnet
  });
});

test.describe("MetaMask mobile in-app browser behaviour @mobile", () => {
  test("lowercase account, Sepolia added on demand, hex login, strict typed data: one-tap + trade works", async ({ page }) => {
    const app = await openApp(page, "default", { flavour: "metamask-mobile" });
    await connectWallet(page, { oneTap: "enable" });
    expect(app.wallet!.calls).toContain("wallet_addEthereumChain");
    await setAmount(page, "100");
    await toReview(page);
    await page.locator("#agree").check();
    await page.locator("#confirm").click();
    await expect(page.locator("#done h2")).toHaveText("Position opened", { timeout: 15_000 });
    const td = app.wallet!.typedData[0] as { domain: { chainId: number }; primaryType: string; types: Record<string, unknown> };
    expect(td.primaryType).toBe("Action");
    expect(td.domain.chainId).toBe(11155111);
    expect(Object.keys(td.types)).toEqual(["EIP712Domain", "Action"]);
  });

  test("the no-wallet sheet links to the MetaMask app", async ({ page }) => {
    await openApp(page, "default", { wallet: false });
    await page.locator("#balBtn").click();
    await expect(page.locator("#mmLink")).toHaveAttribute("href", /^https:\/\/metamask\.app\.link\/dapp\//);
  });
});
