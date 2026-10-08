// Perps tab end to end against the mock exchange (recorded Derive v3 perp markets,
// tests/fixtures/perps-<net>.json). Orders are verified by the mock with the same
// EIP-712 code the app signs with, and fill against the recorded book.
import { expect, test, type Page } from "@playwright/test";
import { connectWallet, openApp } from "./helpers.ts";

const toPerps = async (page: Page) => {
  await page.locator("[data-view=perps]").click();
  await expect(page.locator("#perpMarkets tbody tr").first()).toBeVisible({ timeout: 10_000 });
};
const pill = async (page: Page, kind: "risk" | "lev", v: string) => {
  await page.locator(`[data-ppop=${kind}]`).click();
  await page.locator("#ppIn").fill(v);
  await page.locator("#ppIn").press("Enter");
  await page.keyboard.press("Escape");
};
const state = (page: Page) =>
  page.evaluate(() => (window as unknown as { __peo: { state: () => { perps: { quote: { amount: string; n: number; liqPrice: number | null; entry: number } | null; venue: string; scope: string | null; oneTap: boolean }; wallet: { sessionKey: string | null; scopes: string[] }; leverageCap: number } } }).__peo.state());

test.describe("perps: markets and the plain-English builder", () => {
  test("every recorded perp is listed with mark, index, 24h, funding and OI; the sentence sizes the order @mobile", async ({ page }) => {
    await openApp(page);
    await toPerps(page);
    await expect(page.locator("#perpMarkets tbody tr")).toHaveCount(15);
    await expect(page.locator("#perpMarkets tbody tr").first()).toContainText("ETH");
    await expect(page.locator("#perpMarkets tbody tr").nth(1)).toContainText("BTC");
    await expect(page.locator("#perpMarkets")).toContainText("/h");
    await expect(page.locator("#perpMarkets")).toContainText("/yr");
    await expect(page.locator("#venuePick button")).toHaveCount(2); // Derive + Hyperliquid
    await expect(page.locator("#perpLiveTxt")).toContainText("Live · Derive testnet");
    await pill(page, "risk", "100");
    await pill(page, "lev", "5");
    await expect(page.locator("#ppRisk")).toHaveText("$100");
    await expect(page.locator("#ppLev")).toContainText("5×");
    const s = await state(page);
    expect(s.perps.venue).toBe("derive");
    expect(s.perps.scope).toBe("risk universe 1 (PRIME)"); // looked up from the instrument, like ETH-OPTION
    const q = s.perps.quote!;
    // $100 × 5 / entry, floored to ETH-PERP's 0.001 step
    expect(q.n).toBeCloseTo(Math.floor((500 / q.entry) * 1000) / 1000, 9);
    await expect(page.locator("#perpSize")).toContainText(`Buy ${q.amount}`);
    await expect(page.locator("#perpFunding")).toContainText("/yr");
    await expect(page.locator("#perpFee")).toContainText("taker");
    await expect(page.locator("#perpLoss")).toContainText("you have lost the $");
    await expect(page.locator("#perpConfirm")).toHaveText("Connect wallet to trade");
    await page.locator("#ppDir").click();
    await expect(page.locator("#ppDirT")).toHaveText("goes down");
    await expect(page.locator("#ppSummary")).toContainText("Short");
    await page.locator("#perpMarkets [data-pick=BTC-PERP]").click();
    await expect(page.locator("#ppMarket")).toHaveText("BTC");
    await expect(page.locator("#perpSize")).toContainText("BTC-PERP");
  });
});

test.describe("perps: trading", () => {
  test("one-tap market long with TP/SL → portfolio shows liq + triggers → close ½ → flip → close → cancel all @mobile", async ({ page }) => {
    const app = await openApp(page);
    await connectWallet(page, { oneTap: "enable" });
    const s0 = await state(page);
    expect(s0.wallet.scopes).toEqual(["trade:orderbook:option", "trade:orderbook:perp"]);
    const promptsAfterKey = app.wallet!.typedData.length; // 1: set_session_key
    await toPerps(page);
    await pill(page, "risk", "100");
    await pill(page, "lev", "5");
    const entry = (await state(page)).perps.quote!.entry;
    await page.locator("#ppTpsl summary").click();
    await page.locator("#ppTp").fill(String(Math.round(entry * 1.2)));
    await page.locator("#ppSl").fill(String(Math.round(entry * 0.85)));
    await expect(page.locator("#perpSignedBy")).toContainText("your wallet for TP/SL (2 prompts");
    await expect(page.locator("#perpMarginOk")).toBeVisible(); // private/get_margin said yes
    await page.locator("#perpAgree").check();
    await expect(page.locator("#perpConfirm")).toBeEnabled();
    await page.locator("#perpConfirm").click();
    await expect(page.locator("#perpStep")).toContainText("Filled", { timeout: 15_000 });
    // entry signed by the one-tap key; the two 30-day triggers by the wallet
    expect(app.wallet!.typedData.length).toBe(promptsAfterKey + 2);
    const st = (await app.mock("mock/state")) as { orderSigners: string[] };
    const key = (await state(page)).wallet.sessionKey!;
    expect(st.orderSigners[0]).toBe(key);
    expect(st.orderSigners.slice(1)).toEqual([app.wallet!.address, app.wallet!.address]);

    await page.locator("[data-view=portfolio]").click();
    const row = page.locator("#perpPositions tr[data-perp-pos='ETH-PERP']");
    await expect(row).toContainText("Long");
    await expect(page.locator("#perpTriggers tbody tr")).toHaveCount(2);
    await expect(page.locator("#marginUsage")).toContainText("Margin used");
    await page.locator("[data-perp-flip='ETH-PERP']").click();
    await expect(page.locator("#portStep")).toContainText("Flipped", { timeout: 10_000 });
    await expect(row).toContainText("Short");
    await page.locator("[data-perp-half='ETH-PERP']").click(); // reduce-only: allowed under the 0.1 minimum, as on live testnet
    await expect(page.locator("#portStep")).toContainText("filled", { timeout: 10_000 });
    // what is left is under the minimum: a flip would close and fail to reopen, so it is refused up front
    await page.locator("[data-perp-flip='ETH-PERP']").click();
    await expect(page.locator("#portStep")).toContainText("Flip needs at least 0.1 ETH", { timeout: 10_000 });
    await expect(row).toContainText("Short");
    await page.locator("[data-perp-close='ETH-PERP']").click();
    await expect(page.locator("#portStep")).toContainText("filled", { timeout: 10_000 });
    await expect(page.locator("#perpPortfolio")).toContainText("No perp positions.", { timeout: 10_000 });
    // the triggers outlive the position until cancelled: Cancel all removes them too
    await page.locator("#cancelAll").click();
    await expect(page.locator("#portStep")).toContainText("All open orders cancelled");
    await expect(page.locator("#perpTriggers")).toHaveCount(0, { timeout: 10_000 });

    await page.locator("[data-view=history]").click();
    await expect(page.locator("#perpPnl tbody tr")).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator("#perpPnl")).toContainText("ETH-PERP");
    await expect(page.locator("#perpPnlTotal")).toContainText("after fees and funding");
  });

  test("post-only that would cross is blocked; a resting limit shows in Portfolio and Cancel all clears it", async ({ page }) => {
    await openApp(page);
    await connectWallet(page);
    await toPerps(page);
    await pill(page, "risk", "100");
    const mark = (await state(page)).perps.quote!.entry; // market quote: the ask
    await page.locator("[data-otype=limit]").click();
    await page.locator("#ppPostOnly").check();
    await page.locator("#ppLimit").fill("999999");
    await page.locator("#perpAgree").check();
    await expect(page.locator("#perpConfirm")).toBeDisabled();
    await expect(page.locator("#perpNotes")).toContainText("Post-only buy must be below the ask");
    await page.locator("#ppLimit").fill(String(Math.floor(mark * 0.99))); // under the bid, inside the ±2% band
    await expect(page.locator("#perpConfirm")).toBeEnabled();
    await expect(page.locator("#perpConfirm")).toContainText("Go long");
    await page.locator("#perpConfirm").click();
    await expect(page.locator("#perpStep")).toContainText("resting on the book", { timeout: 15_000 });
    await page.locator("[data-view=portfolio]").click();
    await expect(page.locator("#orders")).toContainText("ETH-PERP");
    await page.locator("#cancelAll").click();
    await expect(page.locator("#portfolio")).toContainText("No open orders.", { timeout: 10_000 });
  });

  test("Deposit and Withdraw from the Perps tab open the venue's own sheets for the selected subaccount", async ({ page }) => {
    await openApp(page);
    await connectWallet(page);
    await toPerps(page);
    await page.locator("#perpDeposit").click();
    await expect(page.locator("#sheetBody")).toContainText("Deposit");
    await page.locator("#sheetClose").click();
    await page.locator("#perpWithdraw").click();
    await expect(page.locator("#sheetBody")).toContainText("Withdraw");
  });

  test("Check order (no trade) signs the perp order and sends it only to private/order_debug", async ({ page }) => {
    const app = await openApp(page);
    await connectWallet(page);
    await toPerps(page);
    await page.locator("#perpCheck").click();
    await expect(page.locator("#perpCheckStep")).toContainText("Derive verified the ETH-PERP order signature", { timeout: 10_000 });
    const st = (await app.mock("mock/state")) as { orderSigners: string[]; debugCalls: number };
    expect(st.debugCalls).toBe(1);
    expect(st.orderSigners).toEqual([]);
  });

  test("Close all positions cancels every order and trigger, then closes the perp and the option", async ({ page }) => {
    await openApp(page, "perppos");
    await connectWallet(page);
    await page.locator("[data-view=portfolio]").click();
    await expect(page.locator("#perpPositions")).toContainText("Long 0.5");
    await expect(page.locator("#perpTriggers tbody tr")).toHaveCount(1);
    await expect(page.locator("#positions")).toContainText("ETH-20261127-2500-C");
    page.on("dialog", (d) => void d.accept());
    await page.locator("#closeAllPos").click();
    await expect(page.locator("#portStep")).toContainText("2 of 2 positions closed", { timeout: 15_000 });
    await expect(page.locator("#perpPortfolio")).toContainText("No perp positions.", { timeout: 10_000 });
    await expect(page.locator("#portfolio")).toContainText("No open positions.");
    await expect(page.locator("#perpTriggers")).toHaveCount(0);
  });

  test("mainnet: leverage cap, per-trade limit and REAL MONEY all gate Confirm", async ({ page }) => {
    await openApp(page);
    await toPerps(page);
    await page.locator("#perps [data-net=mainnet]").click();
    await expect(page.locator("#perpLiveTxt")).toContainText("Live · Derive mainnet", { timeout: 15_000 });
    await expect(page.locator("#perpNetNote")).toBeVisible();
    await connectWallet(page);
    // leverage cap 2× (default 5×)
    await page.locator("[data-view=portfolio]").click();
    await page.locator("#levCapIn").fill("2");
    // Opening Portfolio reloads subaccounts and triggers, and each answer re-renders the card.
    // Force that re-render between typing and saving: the typed value must survive it
    // (it used to be reset to 5×, which made this test flaky in CI).
    await page.locator("[data-view=portfolio]").click();
    await expect(page.locator("#levCapIn")).toHaveValue("2");
    await page.locator("#levCapSave").click();
    await expect(page.locator("#portStep")).toContainText("capped at 2×");
    await expect(page.locator("#levCapIn")).toHaveValue("2");
    expect((await state(page)).leverageCap).toBe(2);
    await page.locator("#maxCostIn").fill("50");
    await page.locator("#maxCostSave").click();
    await expect(page.locator("#portStep")).toContainText("limited to $50");
    await page.locator("[data-view=perps]").click();
    await expect(page.locator("#perpReal")).toBeVisible();
    await pill(page, "risk", "100");
    // the slider cannot go past the cap; the default 3× is now over it
    await expect(page.locator("#perpNotes")).toContainText("Leverage is capped at 2×");
    await pill(page, "lev", "2");
    await page.locator("#perpAgree").check();
    await expect(page.locator("#perpConfirm")).toHaveAttribute("data-reason", "cap");
    // at 2× the 0.1 ETH minimum needs ≈ $128 put in, still over $50: raise the limit
    await page.locator("[data-view=portfolio]").click();
    await page.locator("#maxCostIn").fill("500");
    await page.locator("#maxCostSave").click();
    await expect(page.locator("#portStep")).toContainText("limited to $500");
    await page.locator("[data-view=perps]").click();
    await page.locator("#perpAgree").check();
    await expect(page.locator("#perpConfirm")).toHaveAttribute("data-reason", "phrase");
    await page.locator("#perpReal").fill("REAL MONEY");
    await expect(page.locator("#perpConfirm")).toBeEnabled();
    await expect(page.locator("#perpConfirm")).toContainText("Real money: Go long");
  });
});
