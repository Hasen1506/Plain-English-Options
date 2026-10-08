// Trading categories in the Perps market popover, against the mock exchange with recorded
// frames: Derive (crypto + its XAUT gold perp), Hyperliquid (own crypto perps + the xyz
// builder dex: commodities, stocks, indices, FX) and Veranta (feed asset types).
import { expect, test, type Page } from "@playwright/test";
import { openApp, VENUES } from "./helpers.ts";

const toPerps = async (page: Page) => {
  await page.locator("[data-view=perps]").click();
  await expect(page.locator("#perpMarkets tbody tr").first()).toBeVisible({ timeout: 10_000 });
};
const toVenue = async (page: Page, name: string) => {
  await page.locator("#venuePick button", { hasText: name }).click();
  await expect(page.locator("#perpLiveTxt")).toContainText(`Live · ${name} testnet`, { timeout: 15_000 });
};
const openList = async (page: Page) => {
  await page.locator("[data-ppop=market]").click();
  await expect(page.locator("#perpPop #ppMarketList")).toBeVisible();
};
const cats = (page: Page) => page.locator("#perpPop [data-cat]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.cat));
const rows = (page: Page) => page.locator("#ppMarketList button").evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim()));
type S = { perps: { name: string; venue: string; marginMode: string; quote: { inst: { name: string } } | null } };
const state = (page: Page) => page.evaluate(() => (window as unknown as { __peo: { state: () => S } }).__peo.state());

test.describe("perps: trading categories", () => {
  test("Derive: Crypto and Commodities (XAUT); rows have prices, 24h change and sparklines; picking switches the table @mobile", async ({ page }) => {
    await openApp(page);
    await toPerps(page);
    await openList(page);
    expect(await cats(page)).toEqual(["crypto", "commodities"]);
    await expect(page.locator('#perpPop [data-cat="crypto"]')).toHaveAttribute("aria-pressed", "true");
    // same rows as the options asset list: name, price, change, sparkline box; the selected one is the black row
    await expect(page.locator("#ppMarketList.x-list--assets")).toBeVisible();
    await expect(page.locator("#ppMarketList button.is-sel")).toContainText("ETH");
    await expect(page.locator("#ppMarketList button").first().locator(".x-sparkbox")).toHaveCount(1);
    expect((await rows(page)).every((r) => /\$\d/.test(r))).toBe(true);
    await page.locator('#perpPop [data-cat="commodities"]').click();
    await expect(page.locator('#perpPop [data-cat="commodities"]')).toHaveAttribute("aria-pressed", "true");
    expect((await rows(page)).map((r) => r.split(" ")[0])).toEqual(["XAUT"]);
    await expect(page.locator("#ppBuilderNote")).toHaveCount(0); // not a builder market
    await page.locator("#ppMarketList button").first().click();
    await expect(page.locator("#ppMarket")).toHaveText("XAUT");
    await expect(page.locator("#perpMarkets tbody tr")).toHaveCount(1); // the table follows the category
    await expect(page.locator("#perpMarkets")).toContainText("XAUT");
    await expect(page.locator("#perpBuilder")).toHaveCount(0);
  });

  test("Hyperliquid: five categories from the xyz builder dex, each row tagged, builder note, isolated-only FX @mobile", async ({ page }) => {
    await openApp(page);
    await toPerps(page);
    await toVenue(page, "Hyperliquid");
    await expect(page.locator("#venueStatus")).toContainText("not live-tested");
    await openList(page);
    expect(await cats(page)).toEqual(["crypto", "commodities", "stocks", "indices", "fx"]);
    const crypto = await rows(page);
    expect(crypto[0]).toMatch(/^ETH \$/);
    expect(crypto.some((r) => r.includes("xyz"))).toBe(false); // Hyperliquid's own perps are not builder markets
    await expect(page.locator("#ppBuilderNote")).toHaveCount(0);
    for (const [c, has] of [["commodities", "GOLD"], ["stocks", "TSLA"], ["indices", "XYZ100"], ["fx", "USDJPY"]] as const) {
      await page.locator(`#perpPop [data-cat="${c}"]`).click();
      await expect(page.locator(`#perpPop [data-cat="${c}"]`)).toHaveAttribute("aria-pressed", "true");
      const r = await rows(page);
      expect(r.length).toBeGreaterThan(0);
      expect(r.every((x) => /^\S+ xyz \$/.test(x))).toBe(true); // every row: name, xyz tag, price
      expect(r.some((x) => x.startsWith(has + " "))).toBe(true);
      await expect(page.locator("#ppBuilderNote")).toContainText("xyz · builder market");
      await expect(page.locator("#ppBuilderNote")).toContainText("may trade 24/7 while the underlying market is closed");
      await expect(page.locator("#ppBuilderNote")).toContainText("own leverage caps and isolated margin");
    }
    // the list stays open while switching; picking a row closes it and selects the market
    await page.locator("#ppMarketList button", { hasText: "USDJPY" }).click();
    await expect(page.locator("#perpPop")).toBeHidden();
    await expect(page.locator("#ppMarket")).toHaveText("USDJPY");
    expect((await state(page)).perps.name).toBe("xyz:JPY-PERP");
    expect((await state(page)).perps.marginMode).toBe("isolated");
    await expect(page.locator("#perpBuilder")).toContainText("xyz · builder market");
    await expect(page.locator("#perpBuilder")).toContainText("allows isolated margin only");
    await expect(page.locator("#perpMode")).toHaveCount(0); // isolated only: no cross option offered
    await expect(page.locator("#perpAgree + span")).toContainText("builder (HIP-3) market");
    // back to crypto: the table shows crypto again
    await openList(page);
    await page.locator('#perpPop [data-cat="crypto"]').click();
    await page.locator("#ppMarketList button").first().click();
    await expect(page.locator("#ppMarket")).toHaveText("ETH");
    await expect(page.locator("#perpBuilder")).toHaveCount(0);
    await expect(page.locator("#perpMarkets")).not.toContainText("GOLD");
  });

  test("Hyperliquid builder order: collateral moved to the xyz dex, isolated leverage, order on the builder asset id", async ({ page }) => {
    const app = await openApp(page);
    await toPerps(page);
    await toVenue(page, "Hyperliquid");
    await openList(page);
    await page.locator('#perpPop [data-cat="stocks"]').click();
    await page.locator("#ppMarketList button", { hasText: "TSLA" }).first().click();
    await expect(page.locator("#ppMarket")).toHaveText("TSLA");
    await page.locator("#perpVenueConnect").click();
    await expect(page.locator("#perpAcct")).toContainText("$1,000", { timeout: 10_000 });
    await expect(page.locator("#perpAcct")).toContainText("xyz dex");
    await page.locator("#perpAgree").check();
    await expect(page.locator("#perpConfirm")).toBeEnabled();
    await page.locator("#perpConfirm").click();
    await expect(page.locator("#perpStep")).toContainText("Filled", { timeout: 15_000 });
    const st = (await (await fetch(`${VENUES}/hl/testnet/${app.sid}/mock/state`)).json()) as { log: { type: string; ok: boolean; detail?: string }[]; lev: Record<string, Record<string, { type: string; value: number }>> };
    const ok = st.log.filter((l) => l.ok).map((l) => l.type);
    expect(ok).toContain("agentSendAsset");
    expect(ok.indexOf("agentSendAsset")).toBeLessThan(ok.lastIndexOf("order"));
    expect(st.log.find((l) => l.type === "agentSendAsset" && l.detail)?.detail).toMatch(/^main→xyz \d+\.\d\d$/);
    expect(Object.values(st.lev)[0]!["xyz:TSLA"]!.type).toBe("isolated");
    await expect(page.locator("#venueAcct")).toContainText("TSLA");
  });

  test("Veranta: categories from the price feeds (crypto, commodities, FX in the recorded pairs) @mobile", async ({ page }) => {
    await openApp(page);
    await toPerps(page);
    await toVenue(page, "Veranta");
    await openList(page);
    expect(await cats(page)).toEqual(["crypto", "commodities", "fx"]);
    await page.locator('#perpPop [data-cat="commodities"]').click();
    expect((await rows(page)).map((r) => r.split(" ")[0])).toEqual(["XAU"]);
    await page.locator('#perpPop [data-cat="fx"]').click();
    expect((await rows(page)).map((r) => r.split(" ")[0])).toEqual(["EUR"]); // USD/JPY is quoted in yen: left out
    await expect(page.locator("#ppBuilderNote")).toHaveCount(0);
  });
});
