// Visual regression helper (not part of CI): screenshots the options build screen,
// its popovers, the review screen and the perps screen against the mock exchange with
// the clock pinned, so a before/after pair must be pixel-identical.
//   VD_OUT=/abs/dir npx playwright test -c playwright.visual.config.ts
import { test } from "@playwright/test";
import { openApp, toReview } from "../e2e/helpers.ts";

const OUT = process.env.VD_OUT ?? "test-results/visual/";
const still = async (page: import("@playwright/test").Page) => {
  await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
  await page.waitForTimeout(400);
};

test("screens", async ({ page }) => {
  await openApp(page);
  await page.waitForTimeout(1500);
  await still(page);
  await page.screenshot({ path: OUT + "build.png" });
  await page.screenshot({ path: OUT + "build-full.png", fullPage: true });
  for (const pop of ["asset", "date", "amt"]) {
    const b = page.locator(`.x-sent .x-pill[data-pop="${pop}"]`).first();
    if (!(await b.count())) continue;
    await b.click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: OUT + `pop-${pop}.png` });
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5);
    await page.waitForTimeout(300);
  }
  await toReview(page);
  await page.waitForTimeout(800);
  await page.screenshot({ path: OUT + "review.png" });
  await page.screenshot({ path: OUT + "review-full.png", fullPage: true });
  await page.goto("about:blank");
});

test("perps screen", async ({ page }) => {
  await openApp(page);
  await page.locator('[data-view="perps"]').first().click();
  await page.waitForTimeout(2500);
  await still(page);
  await page.screenshot({ path: OUT + "perps.png" });
  await page.screenshot({ path: OUT + "perps-full.png", fullPage: true });
});
