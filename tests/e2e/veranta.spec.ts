// Veranta (Base) in the Perps tab, end to end against the mock (tests/mock/veranta.ts over
// tests/mock/venues-server.ts): the recorded pair catalogue, a practice account made in the
// tab (the user's wallet never signs), exact USDC approvals, the $100 minimum position, TP/SL,
// partial close, flip, limit + cancel, history, and Disconnect revoking the one-tap key.
// Desktop and mobile (@mobile).
import { expect, test, type Page } from "@playwright/test";
import { openApp, VENUES } from "./helpers.ts";

const pill = async (page: Page, kind: "risk" | "lev", v: string) => {
  await page.locator(`[data-ppop=${kind}]`).click();
  await page.locator("#ppIn").fill(v);
  await page.locator("#ppIn").press("Enter");
  await page.keyboard.press("Escape");
};
type Q = { amount: string; n: number; entry: number; leverage: number; notional: number; putIn: number; estFee: number; warnings: string[] };
type S = { perps: { venue: string; risk: number; quote: Q | null; compare: { venue: string; listed: boolean; mark: number | null }[] } };
const state = (page: Page) => page.evaluate(() => (window as unknown as { __peo: { state: () => S } }).__peo.state());
type MS = { trader: string | null; session: string | null; revoked: string[]; balance: number; allowance: number; positions: { buy: boolean; collateral: number; leverage: number; tp: number; sl: number }[]; limits: unknown[]; history: { type: string }[]; log: string[] };
const mockState = async (sid: string, net = "testnet") => (await fetch(`${VENUES}/vr/${net}/${sid}/mock/state`)).json() as Promise<MS>;

const toVeranta = async (page: Page) => {
  await page.locator("[data-view=perps]").click();
  await expect(page.locator("#venuePick")).toBeVisible();
  const pick = page.locator("#venuePick button", { hasText: "Veranta" });
  await expect(pick).toContainText("testnet practice account");
  await pick.click();
  await expect(page.locator("#perpLiveTxt")).toContainText("Live · Veranta testnet", { timeout: 15_000 });
  await expect(page.locator("#perpMarkets tbody tr").first()).toContainText("ETH");
};
const start = async (page: Page) => {
  await expect(page.locator("#perpVenueConnect")).toHaveText("Start a Veranta testnet practice account");
  await page.locator("#perpVenueConnect").click();
  await expect(page.locator("#perpAcct")).toContainText("$1,000", { timeout: 15_000 });
  await expect(page.locator("#venueAcct")).toBeVisible();
};
/** Open the take-profit / stop-loss fold (it stays open between orders). */
const openTpsl = async (page: Page) => {
  if (!(await page.locator("#ppTpsl").evaluate((e) => (e as HTMLDetailsElement).open))) await page.locator("#ppTpsl summary").click();
};
const confirm = async (page: Page) => {
  await page.locator("#perpAgree").check();
  await expect(page.locator("#perpConfirm")).toBeEnabled();
  await page.locator("#perpConfirm").click();
};

test.describe("veranta: markets, honesty, sizing", () => {
  test("picker, status and comparison; the default order clears the $100 minimum; mainnet is coming soon and cannot be picked @mobile", async ({ page }) => {
    const app = await openApp(page);
    await page.locator("[data-view=perps]").click();
    await expect(page.locator("#venuePick button")).toHaveCount(3);
    await expect(page.locator("#venueCompare tr[data-cmp='2']")).toContainText("Veranta", { timeout: 15_000 });
    await toVeranta(page);
    // honesty: practice account, wallet never signs, and what was (not) tested is said plainly
    await expect(page.locator("#venueStatus")).toContainText("your wallet is never asked to sign");
    await expect(page.locator("#venueStatus")).toContainText("practice account");
    // the default ($100 at 3×) is a valid Veranta order: above the $100 minimum position
    const s = await state(page);
    expect(s.perps.venue).toBe("veranta");
    expect(s.perps.quote!.notional).toBeGreaterThanOrEqual(100);
    expect(s.perps.quote!.notional).toBeLessThanOrEqual(300);
    await expect(page.locator("#perpFee")).toContainText("%");
    // $5 at 1× is under the minimum: sized up to it, and said so
    await pill(page, "risk", "5");
    await pill(page, "lev", "1");
    await expect(page.locator("#perpNotes")).toContainText("Smallest order is");
    expect((await state(page)).perps.quote!.notional).toBeGreaterThanOrEqual(100);
    // mainnet: Veranta is "coming soon", disabled, and the app falls back to Derive
    await page.locator("#perps [data-net=mainnet]").click();
    await expect(page.locator("#venuePick button", { hasText: "Veranta" })).toBeDisabled({ timeout: 15_000 });
    await expect(page.locator("#venuePick button", { hasText: "Veranta" })).toContainText("coming soon");
    await expect(page.locator("#perpLiveTxt")).toContainText("Derive mainnet", { timeout: 15_000 });
    expect((await state(page)).perps.venue).toBe("derive");
    expect(app.wallet!.typedData.length).toBe(0);
  });
});

test.describe("veranta: trading the practice account", () => {
  test("practice account → long with TP/SL (exact approval) → close ½ → flip → close → short → close → limit + cancel → history → disconnect revokes, allowance 0 @mobile", async ({ page }) => {
    const app = await openApp(page);
    page.on("dialog", (d) => void d.accept());
    await toVeranta(page);
    await start(page);
    let ms = await mockState(app.sid);
    expect(ms.trader).toMatch(/^0x[0-9a-f]{40}$/i);
    expect(ms.session).toMatch(/^0x[0-9a-f]{40}$/i);
    const card = page.locator("#venueAcct");
    await expect(card.locator("#venueWho")).toContainText("one-tap key");
    await expect(card.locator("#venueWho")).toContainText("30 days");

    // 1. market long $50 × 5 with TP/SL
    await pill(page, "risk", "50");
    await pill(page, "lev", "5");
    const q = (await state(page)).perps.quote!;
    expect(q.notional).toBeGreaterThanOrEqual(100);
    await openTpsl(page);
    await page.locator("#ppTp").fill(String(Math.round(q.entry * 1.2)));
    await page.locator("#ppSl").fill(String(Math.round(q.entry * 0.85)));
    await confirm(page);
    await expect(page.locator("#perpStep")).toContainText("Filled", { timeout: 15_000 });
    await expect(page.locator("#perpStep")).toContainText("2 TP/SL set on the position");
    ms = await mockState(app.sid);
    // the approval was for exactly this trade's collateral, and the trade used all of it
    const approve = ms.log.find((l) => l.startsWith("approve "))!;
    expect(Number(approve.split(" ")[1])).toBeCloseTo(q.putIn, 5);
    expect(Number(approve.split(" ")[1])).toBeLessThanOrEqual(q.putIn + 1e-9);
    expect(ms.allowance).toBe(0);
    expect(ms.positions).toHaveLength(1);
    expect(ms.positions[0]!.leverage).toBe(5);
    expect(ms.positions[0]!.sl).toBe(Math.round(q.entry * 0.85));

    const row = card.locator("tr[data-perp-pos='ETH-PERP']");
    await expect(row).toContainText("Long", { timeout: 10_000 });
    await expect(card.locator("#perpTriggers tbody tr")).toHaveCount(2, { timeout: 10_000 });

    // 2. close half, flip, close
    await card.locator("[data-perp-half='ETH-PERP']").click();
    await expect(card.locator("#venueStep")).toContainText("filled", { timeout: 15_000 });
    await card.locator("[data-perp-flip='ETH-PERP']").click();
    await expect(card.locator("#venueStep")).toContainText("Flipped", { timeout: 15_000 });
    await expect(row).toContainText("Short", { timeout: 10_000 });
    await card.locator("[data-perp-close='ETH-PERP']").click();
    await expect(card).toContainText("No perp positions.", { timeout: 15_000 });

    // 3. a fresh short, then close it
    await page.locator("#ppDir").click();
    await pill(page, "risk", "25");
    await openTpsl(page);
    await page.locator("#ppTp").fill("");
    await page.locator("#ppSl").fill("");
    await confirm(page);
    await expect(page.locator("#perpStep")).toContainText("Filled", { timeout: 15_000 });
    await expect(row).toContainText("Short", { timeout: 10_000 });
    await card.locator("[data-perp-close='ETH-PERP']").click();
    await expect(card).toContainText("No perp positions.", { timeout: 15_000 });

    // 4. limit long 15% below, cancel it from the card
    await page.locator("#ppDir").click();
    await page.locator("[data-otype=limit]").click();
    await page.locator("#ppLimit").fill(String(Math.round(q.entry * 0.85)));
    await confirm(page);
    await expect(page.locator("#perpStep")).toContainText("Limit order resting", { timeout: 15_000 });
    await expect(page.locator("#venueOrders tbody tr")).toHaveCount(1, { timeout: 10_000 });
    await page.locator("#venueOrders [data-venue-cancel]").click();
    await expect(page.locator("#venueStep")).toContainText("Order cancelled", { timeout: 15_000 });
    await expect(page.locator("#venueOrders")).toHaveCount(0, { timeout: 10_000 });

    // 5. history, flat, no wallet signature ever
    await expect(card.locator("#venuePnl")).toContainText("ETH-PERP", { timeout: 10_000 });
    ms = await mockState(app.sid);
    expect(ms.positions).toHaveLength(0);
    expect(ms.limits).toHaveLength(0);
    expect(ms.history.filter((h) => h.type === "MARKET_OPEN")).toHaveLength(3);
    expect(ms.history.filter((h) => h.type === "MARKET_CLOSE")).toHaveLength(4);
    expect(app.wallet!.typedData.length).toBe(0);

    // 6. disconnect revokes the one-tap key and leaves no allowance
    const session = ms.session!;
    await card.locator("#venueDisconnect").click();
    await expect(page.locator("#perpVenueConnect")).toBeVisible({ timeout: 10_000 });
    ms = await mockState(app.sid);
    expect(ms.revoked).toEqual([session]);
    expect(ms.session).toBeNull();
    expect(ms.allowance).toBe(0);
    expect(app.wallet!.typedData.length).toBe(0);
  });
});
