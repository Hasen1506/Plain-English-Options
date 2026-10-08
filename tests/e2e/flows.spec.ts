import { expect, test } from "@playwright/test";
import { connectWallet, openApp, toReview } from "./helpers.ts";

test.describe("building a position", () => {
  test("live quote, asset, direction, target, date, amount, review @mobile", async ({ page }) => {
    await openApp(page);
    await expect(page.locator("#pAsset")).toHaveText("ETH");
    await expect(page.locator("#spotTag")).toContainText("ETH $2,5");
    await expect(page.locator("#qCost")).toContainText("It costs $");
    await expect(page.locator("#qChance")).toContainText("chance it happens");

    // asset list shows the real 24h change from the perp ticker
    await page.locator("[data-pop=asset]").click();
    await expect(page.locator("#pop")).toContainText("-1.6%"); // ETH-PERP 24h change from the recorded perp tickers (tests/fixtures/perps-testnet.json)
    await page.locator("#pop button", { hasText: "BTC" }).click();
    await expect(page.locator("#pAsset")).toHaveText("BTC");
    await expect(page.locator("#spotTag")).toContainText("BTC $");
    await expect(page.locator("#qCost")).toContainText("It costs $");

    // back to ETH, flip direction
    await page.locator("[data-pop=asset]").click();
    await page.locator("#pop button", { hasText: "ETH" }).click();
    await page.locator("#pDir").click();
    await expect(page.locator("#pDirT")).toHaveText("drops to");
    await expect(page.locator("#kind")).toHaveText("Put spread");
    await expect(page.locator("#pPct")).toHaveText("↓15%");
    await page.locator("#pDir").click();

    // type an exact target
    await page.locator("[data-pop=tgt]").click();
    await page.locator("#popIn").fill("2900");
    await page.locator("#popIn").press("Enter");
    await expect(page.locator("#pTgt")).toHaveText("$2,900");
    await expect(page.locator("#tgtCap")).toContainText("chance");
    await page.keyboard.press("Escape");

    // a target below spot for "hits" explains itself
    await page.locator("[data-pop=tgt]").click();
    await page.locator("#popIn").fill("2000");
    await page.locator("#popIn").press("Enter");
    await page.keyboard.press("Escape");
    await expect(page.locator("#hint")).toContainText("Pick a target above");
    await expect(page.locator("#buy")).toBeDisabled();
    await page.locator("[data-pop=tgt]").click();
    await page.locator("#popIn").fill("2900");
    await page.locator("#popIn").press("Enter");
    await page.keyboard.press("Escape");

    // pick another date
    await page.locator("[data-pop=date]").click();
    const items = page.locator("#pop li button");
    await expect(items.first()).toBeVisible();
    await page.locator("#pop button", { hasText: "Oct 30" }).click();
    await expect(page.locator("#pDate")).toHaveText("Oct 30");
    await expect(page.locator("#qCost")).toContainText("It costs $");

    // amount
    await page.locator("[data-pop=amt]").click();
    await page.locator("#popIn").fill("500");
    await page.locator("#popIn").press("Enter");
    await page.keyboard.press("Escape");
    await expect(page.locator("#pAmt")).toHaveText("$500");

    await toReview(page);
    await expect(page.locator("#review")).toContainText("ETH-20261030-");
    await expect(page.locator("#review")).toContainText("Maximum loss");
    await expect(page.locator("#chart rect")).toHaveCount(14);
    await page.locator("#chart rect").nth(13).click();
    await expect(page.locator("#tip")).toContainText("+$");
    await expect(page.locator("#confirm")).toHaveText("Connect wallet to trade");
    await page.locator("#edit").click();
    await expect(page.locator("#builder")).toBeVisible();
  });

  test("switching network clears data and mainnet demands a typed confirmation", async ({ page }) => {
    await openApp(page);
    await page.locator("#builder [data-net=mainnet]").click();
    await expect(page.locator("#builder [data-net=mainnet]")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#netNote")).toBeVisible();
    await expect(page.locator("#liveTxt")).toContainText("Live · Derive mainnet", { timeout: 15_000 });
    await connectWallet(page);
    await expect(page.locator("#balNet")).toContainText("Mainnet · #87139");
    await toReview(page);
    await expect(page.locator(".x-real")).toContainText("Real money");
    await page.locator("#agree").check();
    await expect(page.locator("#confirm")).toHaveText("Type REAL MONEY to confirm");
    await expect(page.locator("#confirm")).toBeDisabled();
    await page.locator("#realIn").fill("real money");
    await expect(page.locator("#confirm")).toBeEnabled();
    await expect(page.locator("#confirm")).toContainText("Pay real money");
    // never press it: tests do not trade mainnet
    await page.locator("#edit").click();
    await page.locator("#builder [data-net=testnet]").click();
    await expect(page.locator("#builder")).toBeVisible();
    await expect(page.locator("#bal")).toHaveText("Reconnect wallet");
  });
});

test.describe("trading against the mock exchange", () => {
  test("connect wallet, confirm, see fills, then close from Portfolio", async ({ page }) => {
    await openApp(page);
    await connectWallet(page);
    await expect(page.locator("#bal")).toHaveText("$2,000.00");
    await expect(page.locator("#balNet")).toHaveText("Testnet · #87139 · RU1");
    await page.locator("[data-pop=amt]").click();
    await page.locator("#popIn").fill("100");
    await page.locator("#popIn").press("Enter");
    await page.keyboard.press("Escape");
    await toReview(page);
    await expect(page.locator("#subPick")).toHaveValue("87139");
    await expect(page.locator("#review")).toContainText("Passes margin");
    await expect(page.locator("#confirm")).toHaveText("Tick the box to continue");
    await page.locator("#agree").check();
    await expect(page.locator("#confirm")).toContainText("Confirm and pay $");
    await page.locator("#confirm").click();
    await expect(page.locator("#done h2")).toHaveText("Position opened", { timeout: 15_000 });
    const fills = page.locator("#fills tbody tr");
    await expect(fills).toHaveCount(2);
    await expect(fills.nth(0)).toContainText("filled");
    await expect(fills.nth(0)).toContainText("mock-");
    await expect(fills.nth(1)).toContainText("filled");

    await page.locator("#toPort").click();
    await expect(page.locator("#positions tbody tr")).toHaveCount(2);
    await page.locator("[data-close-spread]").click();
    await expect(page.locator("#portStep")).toContainText("filled", { timeout: 10_000 });
    await expect(page.locator("#portfolio")).toContainText("No open positions.", { timeout: 10_000 });
  });

  test("insufficient balance keeps Confirm disabled", async ({ page }) => {
    await openApp(page, "poor");
    await connectWallet(page);
    await expect(page.locator("#bal")).toHaveText("$5.00");
    await toReview(page);
    await page.locator("#agree").check();
    await expect(page.locator("#confirm")).toHaveText("Not enough collateral");
    await expect(page.locator("#confirm")).toBeDisabled();
    await expect(page.locator("[data-bal] dd")).toHaveText("Not enough collateral");
  });

  test("leg 2 failure unwinds leg 1 straight away", async ({ page }) => {
    await openApp(page, "leg2fail");
    await connectWallet(page);
    await page.locator("[data-pop=amt]").click();
    await page.locator("#popIn").fill("100");
    await page.locator("#popIn").press("Enter");
    await page.keyboard.press("Escape");
    await toReview(page);
    await page.locator("#agree").check();
    await page.locator("#confirm").click();
    await expect(page.locator("#done h2")).toHaveText("Order unwound", { timeout: 15_000 });
    const rows = page.locator("#fills tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1)).toContainText("cancelled");
    await expect(rows.nth(2)).toContainText("Unwind");
    await expect(rows.nth(2)).toContainText("filled");
    await page.locator("#toPort").click();
    await expect(page.locator("#portfolio")).toContainText("No open positions.");
  });

  test("a subaccount in the wrong risk universe cannot trade and the app says how to fix it", async ({ page }) => {
    await openApp(page, "wrongru");
    await connectWallet(page, { oneTap: "none" });
    // signed in but nothing in ETH's universe: the app offers the deposit that creates one
    await expect(page.locator("#sheetBody h2")).toHaveText("New ETH subaccount");
    await page.locator("#sheetClose").click();
    await expect(page.locator("#balNet")).toContainText("#87138 · RU0");
    await toReview(page);
    await expect(page.locator("#noSubHint")).toContainText("risk universe 1");
    await expect(page.locator("#newSubBtn")).toBeVisible();
    await page.locator("#agree").check();
    await expect(page.locator("#confirm")).toHaveText("Pick a subaccount for this asset");
  });

  test("open orders can be cancelled", async ({ page }) => {
    await openApp(page, "openorder");
    await connectWallet(page);
    await page.locator("[data-view=portfolio]").click();
    await expect(page.locator("#orders tbody tr")).toHaveCount(1);
    await page.locator("[data-cancel]").click();
    await expect(page.locator("#portfolio")).toContainText("No open orders.", { timeout: 10_000 });
  });

  test("without an injected wallet the app explains what to do", async ({ page }) => {
    await openApp(page, "default", { wallet: false });
    await page.locator("#balBtn").click();
    await expect(page.locator("#sheetBody")).toContainText("No wallet found");
  });
});
