// The concept-video polish: pill popovers (live cost, sparklines, target badge, expiry
// chances), motion that respects reduced-motion, number roll on token switch, the
// two-column review, empty states, and the perps venue picker. Against the mock exchange.
import { expect, test, type Page } from "@playwright/test";
import { connectWallet, openApp, toReview } from "./helpers.ts";

/** Every text #id showed during `ms` after `act` (to see a count-up happen). */
async function textsDuring(page: Page, id: string, act: () => Promise<void>, ms = 900): Promise<string[]> {
  await page.evaluate((id) => {
    const el = document.getElementById(id)!;
    const seen: string[] = [el.textContent ?? ""];
    (window as unknown as { __seen: string[] }).__seen = seen;
    new MutationObserver(() => seen.push(el.textContent ?? "")).observe(el, { childList: true, characterData: true, subtree: true });
  }, id);
  await act();
  await page.waitForTimeout(ms);
  return page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
}

test.describe("builder popovers", () => {
  test("amount shows live cost; asset list has price, 24h % and real sparklines; target badge; expiry kinds and chances @mobile", async ({ page }) => {
    await openApp(page);
    await expect(page.locator("#qCost")).toContainText("It costs $");

    // amount: type or drag, live cost under the slider
    await page.locator("[data-pop=amt]").click();
    await expect(page.locator("#pop")).toHaveClass(/is-in/); // springs in
    await expect(page.locator("#amtCap")).toHaveText(/^costs \$[\d,]+$/);
    const cost1 = await page.locator("#amtCap").textContent();
    await page.locator("#popRg").fill("3000");
    await expect(page.locator("#pAmt")).toHaveText("$3,000");
    await expect(page.locator("#amtCap")).not.toHaveText(cost1!);
    expect(await page.locator(".x-rangewrap").evaluate((e) => getComputedStyle(e).getPropertyValue("--pn").trim())).not.toBe("");
    await page.keyboard.press("Escape");
    await expect(page.locator("#pop")).toBeHidden();

    // asset list: every token with price, 24h % and a sparkline drawn from the recorded index candles
    await page.locator("[data-pop=asset]").click();
    const rows = page.locator("#pop .x-list--assets button");
    await expect(rows).toHaveCount(7);
    await expect(page.locator("#pop")).toContainText("Choose an options token");
    await expect(rows.first()).toContainText("ETH");
    await expect(rows.first()).toContainText("-1.6%");
    await expect(page.locator("#pop .x-spark")).toHaveCount(7);
    await expect(page.locator('#pop [aria-current="true"]')).toContainText("ETH");

    // switching token rolls the numbers to the new spot
    const seen = await textsDuring(page, "spotTag", () => page.locator("#pop button", { hasText: "BTC" }).click());
    await expect(page.locator("#spotTag")).toHaveText(/^BTC \$\d{2},\d{3}$/);
    expect(new Set(seen.filter((t) => t.startsWith("BTC $"))).size).toBeGreaterThan(3); // counted up, not jumped
    await page.locator("[data-pop=asset]").click();
    await page.locator("#pop button", { hasText: "ETH" }).click();

    // target: badge over the thumb and the chance line
    await page.locator("[data-pop=tgt]").click();
    await expect(page.locator("#tgtBadge")).toHaveText(/^[+-]\d+%$/);
    await expect(page.locator("#tgtCap")).toHaveText(/^\d+% chance · [+-]\d+% from now$/);
    await page.locator("#popIn").fill("3000");
    await page.locator("#popIn").press("Enter");
    await expect(page.locator("#tgtBadge")).toHaveText("+16%");
    await page.keyboard.press("Escape");

    // dates: day, days left, kind, and a chance pill per expiry
    await page.locator("[data-pop=date]").click();
    const dates = page.locator("#pop .x-list--dates button");
    await expect(dates.first()).toBeVisible();
    const n = await dates.count();
    await expect(page.locator("#pop [data-chance]")).toHaveCount(n);
    await expect(page.locator("#pop .x-list--dates")).toContainText(/\d+ days · (Weekly|Monthly|Quarterly)/);
    await expect(page.locator('#pop [aria-current="true"] .x-chance')).toHaveText(/^\d+%$/);
    await expect(dates.filter({ hasText: "Oct 30" })).toContainText("Monthly");
  });

  test("reduced motion: no spring, numbers jump straight to the answer", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openApp(page);
    await page.locator("[data-pop=asset]").click();
    await expect(page.locator("#pop")).toBeVisible();
    await expect(page.locator("#pop")).not.toHaveClass(/is-in/);
    const seen = await textsDuring(page, "spotTag", () => page.locator("#pop button", { hasText: "BTC" }).click());
    // at most the perp-ticker spot and then the option-book spot: no counting in between
    expect(new Set(seen.filter((t) => t.startsWith("BTC $") && !t.endsWith("…"))).size).toBeLessThanOrEqual(2);
  });
});

test.describe("review", () => {
  test("position card, outcomes, chart tooltips, collapsible contracts, details list, countdown ring", async ({ page }) => {
    await openApp(page);
    await connectWallet(page);
    await page.locator("[data-pop=amt]").click();
    await page.locator("#popIn").fill("100");
    await page.locator("#popIn").press("Enter");
    await page.keyboard.press("Escape");
    await toReview(page);
    const left = page.locator("#review .x-pos-card");
    await expect(left).toContainText("Your position");
    await expect(left.locator(".x-rh mark")).toHaveCount(3);
    await expect(left.locator(".x-out")).toHaveCount(3);
    await expect(left.locator(".x-axis span")).toHaveCount(4);
    // hover a bar (desktop) shows the tooltip
    await page.locator("#chart rect").nth(12).hover();
    await expect(page.locator("#tip")).toBeVisible();
    await expect(page.locator("#tip")).toContainText("+$");
    // contracts collapsed by default, open on tap
    await expect(page.locator("#contracts")).not.toHaveAttribute("open", "");
    await page.locator("#contracts summary").click();
    await expect(page.locator("#contracts")).toHaveAttribute("open", "");
    await expect(page.locator("#contracts")).toContainText("Buy");
    await expect(page.locator("#contracts")).toContainText("-C");
    // details list on the right: wallet first, settlement last
    const rows = page.locator("#review .x-det-card .x-rows > div");
    await expect(rows.first()).toContainText("Wallet");
    await expect(rows.first()).toContainText("0x");
    await expect(rows.last()).toContainText("Cash settled · Derive margin rules");
    // two columns side by side on desktop
    const [a, b] = await Promise.all([left.boundingBox(), page.locator("#review .x-rcol").boundingBox()]);
    expect(b!.x).toBeGreaterThan(a!.x + a!.width - 1);
    await page.locator("#agree").check();
    await expect(page.locator("#confirm")).toContainText("Confirm and pay $");
    await expect(page.locator("#confirm .x-ring__fg")).toHaveCount(1);
    await expect(page.locator("#confirm .x-ring b")).toHaveText(/^\d+$/);
  });

  test("stacks on a phone @mobile", async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) > 700, "phone layout only");
    await openApp(page);
    await toReview(page);
    const [a, b] = await Promise.all([page.locator("#review .x-pos-card").boundingBox(), page.locator("#review .x-rcol").boundingBox()]);
    expect(b!.y).toBeGreaterThanOrEqual(a!.y + a!.height - 1);
    await expect(page.locator("#confirm")).toHaveText("Connect wallet to trade");
  });
});

test.describe("portfolio and history without a wallet", () => {
  test("one empty state each, with a Connect wallet button that opens the wallet sheet @mobile", async ({ page }) => {
    await openApp(page);
    await page.locator("[data-view=portfolio]").click();
    await expect(page.locator("#portfolio .x-card")).toHaveCount(1);
    await expect(page.locator("#history")).toBeHidden();
    await expect(page.locator("#portfolioEmpty")).toContainText("Connect a wallet");
    await page.locator("[data-view=history]").click();
    await expect(page.locator("#portfolio")).toBeHidden();
    await expect(page.locator("#history .x-card")).toHaveCount(1);
    await expect(page.locator("main .x-card:visible")).toHaveCount(1);
    await page.locator("#historyEmpty [data-connect]").click();
    await expect(page.locator("#signIn")).toBeVisible();
  });
});

test.describe("perps venue picker", () => {
  test("segmented picker with status dots, status one tap away, no placeholder text, dock clears the cards @mobile", async ({ page }) => {
    await openApp(page);
    await page.locator("[data-view=perps]").click();
    await expect(page.locator("#perpMarkets tbody tr").first()).toBeVisible({ timeout: 10_000 });
    const btns = page.locator("#venuePick button");
    await expect(btns).toHaveCount(3);
    await expect(page.locator("#venuePick .x-dot")).toHaveCount(3);
    await expect(btns.nth(0).locator(".x-dot")).toHaveClass(/is-ok/);
    await expect(btns.nth(1).locator(".x-dot")).toHaveClass(/is-warn/);
    // labels stay on one line
    for (let i = 0; i < 3; i++) {
      const bb = await btns.nth(i).boundingBox();
      expect(bb!.height).toBeLessThan(44);
    }
    await expect(page.locator("#venueStatus")).toBeHidden(); // Derive: nothing to warn about
    await expect(page.locator("#perpLoss")).toContainText("Connect a wallet to see where Derive would liquidate.");
    await expect(page.locator("#perps")).not.toContainText("${");
    await btns.nth(1).click();
    await expect(page.locator("#venueStatus")).toBeVisible();
    await expect(page.locator("#venueStatus summary")).toContainText("Hyperliquid is not live-tested");
    await expect(page.locator("#venueStatus details p")).toBeHidden();
    await page.locator("#venueStatus summary").click();
    await expect(page.locator("#venueStatus details p")).toBeVisible();
    await expect(page.locator("#perpLoss")).not.toContainText("${");
    // at the bottom of the page the dock sits below the last card
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(200);
    const dockTop = (await page.locator(".x-dock").boundingBox())!.y;
    const lastCard = await page.locator("#perps .x-card:visible").last().boundingBox();
    expect(lastCard!.y + lastCard!.height).toBeLessThanOrEqual(dockTop);
  });
});
