// LIVE, opt-in, never in CI: the production build in Chromium trading Veranta's
// real testnet (a fork of Base) through veranta-sdk, using only the app's UI.
//   npm run test:live:browser
// Proves the SDK runs in a static browser app (CORS, bundling, SSE relayer stream)
// and records every order id and transaction in docs/live-veranta-testnet.json.
// No wallet is involved: on testnet the app uses a practice account it creates.
import { expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { Veranta } from "veranta-sdk";

const steps: { step: string; said: string; at: string }[] = [];
const said = async (page: Page, sel: string, step: string, want: RegExp) => {
  await expect(page.locator(sel)).toContainText(want, { timeout: 120_000 });
  const t = (await page.locator(sel).innerText()).trim();
  steps.push({ step, said: t, at: new Date().toISOString() });
  return t;
};
const pill = async (page: Page, kind: "risk" | "lev", v: string) => {
  await page.locator(`[data-ppop=${kind}]`).click();
  await page.locator("#ppIn").fill(v);
  await page.locator("#ppIn").press("Enter");
  await page.keyboard.press("Escape");
};
const confirm = async (page: Page) => {
  await page.locator("#perpAgree").check();
  await expect(page.locator("#perpConfirm")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#perpConfirm").click();
};

test("Veranta testnet in the browser: practice account → long with TP/SL → close ½ → flip → close → short → close → limit + cancel → history → flat → revoke", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => void d.accept());
  await page.goto("/");
  await page.locator("[data-view=perps]").click();
  const pick = page.locator("#venuePick button", { hasText: "Veranta" });
  await expect(pick).toContainText("testnet practice account");
  await pick.click();
  await expect(page.locator("#perpLiveTxt")).toContainText("Live · Veranta testnet", { timeout: 60_000 });
  await expect(page.locator("#venueStatus")).toContainText("practice account");

  // 1. practice account: faucet + 30-day session key (no wallet)
  await page.locator("#perpVenueConnect").click();
  await expect(page.locator("#perpAcct")).toContainText(/\$1,0\d\d|\$99\d/, { timeout: 180_000 });
  const who = await page.locator("#venueWho").innerText();
  const trader = await page.locator("#venueWho [data-address]").getAttribute("data-address");
  expect(trader).toBeTruthy();
  steps.push({ step: "practice account", said: who.trim(), at: new Date().toISOString() });

  // 2. market long $50 × 5 with TP/SL, signed by the session key
  await pill(page, "risk", "50");
  await pill(page, "lev", "5");
  const entry = Number((await page.evaluate(() => (window as unknown as { __peo: { state: () => { perps: { quote: { entry: number } } } } }).__peo.state().perps.quote.entry)));
  await page.locator("#ppTpsl summary").click();
  await page.locator("#ppTp").fill(String(Math.round(entry * 1.2)));
  await page.locator("#ppSl").fill(String(Math.round(entry * 0.85)));
  await confirm(page);
  await said(page, "#perpStep", "market long + TP/SL", /Filled/);
  const card = page.locator("#venueAcct");
  await expect(card.locator("tr[data-perp-pos='ETH-PERP']")).toContainText("Long", { timeout: 60_000 });
  await expect(card.locator("#perpTriggers tbody tr")).toHaveCount(2, { timeout: 60_000 });

  // 3. close half, flip, close
  await card.locator("[data-perp-half='ETH-PERP']").click();
  await said(page, "#venueStep", "close half", /filled/);
  await card.locator("[data-perp-flip='ETH-PERP']").click();
  await said(page, "#venueStep", "flip", /Flipped/);
  await expect(card.locator("tr[data-perp-pos='ETH-PERP']")).toContainText("Short", { timeout: 60_000 });
  await card.locator("[data-perp-close='ETH-PERP']").click();
  await said(page, "#venueStep", "close flipped short", /filled/);
  await expect(card).toContainText("No perp positions.", { timeout: 60_000 });

  // 4. a fresh short, then close it
  await page.locator("#ppDir").click();
  await pill(page, "risk", "25");
  await page.locator("#ppTpsl summary").click();
  await page.locator("#ppTp").fill("");
  await page.locator("#ppSl").fill("");
  await confirm(page);
  await said(page, "#perpStep", "market short", /Filled/);
  await expect(card.locator("tr[data-perp-pos='ETH-PERP']")).toContainText("Short", { timeout: 60_000 });
  await card.locator("[data-perp-close='ETH-PERP']").click();
  await said(page, "#venueStep", "close short", /filled/);
  await expect(card).toContainText("No perp positions.", { timeout: 60_000 });

  // 5. limit long 15% below, cancel it
  await page.locator("#ppDir").click();
  await page.locator("[data-otype=limit]").click();
  await page.locator("#ppLimit").fill(String(Math.round(entry * 0.85)));
  await confirm(page);
  await said(page, "#perpStep", "limit long", /Limit order resting/);
  await expect(page.locator("#venueOrders tbody tr")).toHaveCount(1, { timeout: 60_000 });
  await page.locator("#venueOrders [data-venue-cancel]").click();
  await said(page, "#venueStep", "cancel limit", /Order cancelled/);
  await expect(page.locator("#venueOrders")).toHaveCount(0, { timeout: 60_000 });

  // 6. history in the app and from Veranta's own history API; account flat
  await expect(card.locator("#venuePnl")).toContainText("ETH-PERP", { timeout: 120_000 });
  const c = new Veranta({ network: "testnet", env: {} });
  const hist = (await c.info.tradeHistory(trader as `0x${string}`, 0, 50)) as { trades: { type: string; side: string; orderId: number; txHash: string; collateral: number; leverage: number; openPrice: number; closePrice: number | null; netPnl: number | null; isPartialClose: boolean }[] };
  const types = hist.trades.map((t) => t.type);
  expect(types.filter((t) => t === "MARKET_OPEN").length).toBeGreaterThanOrEqual(3); // long, flipped short, short
  expect(types.filter((t) => t === "MARKET_CLOSE").length).toBeGreaterThanOrEqual(4); // half, rest, flipped short, short
  const ud = (await c.account.positions(trader as `0x${string}`)) as unknown as { positions: unknown[]; limitOrders: unknown[] };
  expect(ud.positions.length).toBe(0);
  expect(ud.limitOrders.length).toBe(0);

  // 7. disconnect revokes the session key
  await card.locator("#venueDisconnect").click();
  await expect(page.locator("#perpVenueConnect")).toBeVisible({ timeout: 120_000 });
  expect(errors).toEqual([]);

  writeFileSync(
    new URL("../../docs/live-veranta-testnet.json", import.meta.url),
    JSON.stringify({ at: new Date().toISOString(), how: "npm run test:live:browser (production build in Chromium, veranta-sdk 0.3.1, Veranta testnet fork of Base)", practiceTrader: trader, ui: steps, veranta: hist.trades.map((t) => ({ type: t.type, side: t.side, orderId: t.orderId, txHash: t.txHash, collateral: t.collateral, leverage: t.leverage, openPrice: t.openPrice, closePrice: t.closePrice, netPnl: t.netPnl, partial: t.isPartialClose })), flatAfter: { positions: ud.positions.length, limitOrders: ud.limitOrders.length } }, null, 1),
  );
});
