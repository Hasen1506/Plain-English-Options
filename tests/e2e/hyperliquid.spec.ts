// Hyperliquid in the Perps tab, end to end against the mock exchange
// (tests/mock/hyperliquid.ts over tests/mock/venues-server.ts): recorded
// mainnet/testnet markets, real signature recovery for the agent approval,
// every agent-signed order, withdraw3 and the CCTP deposit authorization.
import { expect, test, type Page } from "@playwright/test";
import { connectWallet, openApp, VENUES } from "./helpers.ts";

const toHl = async (page: Page) => {
  await page.locator("[data-view=perps]").click();
  await expect(page.locator("#venuePick")).toBeVisible();
  await page.locator("#venuePick button", { hasText: "Hyperliquid" }).click();
  await expect(page.locator("#perpLiveTxt")).toContainText("Live · Hyperliquid testnet", { timeout: 15_000 });
  await expect(page.locator("#perpMarkets tbody tr").first()).toContainText("ETH");
};
const pill = async (page: Page, kind: "risk" | "lev", v: string) => {
  await page.locator(`[data-ppop=${kind}]`).click();
  await page.locator("#ppIn").fill(v);
  await page.locator("#ppIn").press("Enter");
  await page.keyboard.press("Escape");
};
type S = { perps: { venue: string; quote: { amount: string; n: number; entry: number; leverage: number; notional: number } | null; marginMode: string; compare: { venue: string; listed: boolean; mark: number | null; taker: number | null }[] } };
const state = (page: Page) => page.evaluate(() => (window as unknown as { __peo: { state: () => S } }).__peo.state());
const mockState = async (sid: string, net = "testnet") => (await fetch(`${VENUES}/hl/${net}/${sid}/mock/state`)).json() as Promise<{ agents: [string, { user: string; name: string; until: number }][]; log: { type: string; signer: string; ok: boolean }[]; withdrawals: { amount: string }[]; balance: Record<string, number>; lev: Record<string, Record<string, { type: string; value: number }>> }>;
const connect = async (page: Page) => {
  await page.locator("#perpVenueConnect").click();
  await expect(page.locator("#perpAcct")).toContainText("$1,000", { timeout: 10_000 });
  await expect(page.locator("#venueAcct")).toBeVisible();
};

test.describe("hyperliquid: markets, comparison, sizing", () => {
  test("venue picker + side-by-side comparison; Hyperliquid sizes in whole-number leverage with the $10 minimum @mobile", async ({ page }) => {
    await openApp(page);
    await page.locator("[data-view=perps]").click();
    await expect(page.locator("#venuePick button")).toHaveCount(2);
    // the comparison lists ETH on both venues with price, funding and fees
    await expect(page.locator("#venueCompare tbody tr")).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator("#venueCompare tr[data-cmp='1']")).toContainText("Hyperliquid", { timeout: 15_000 });
    await expect(page.locator("#venueCompare tr[data-cmp='1']")).toContainText("0.045% / 0.015%", { timeout: 15_000 });
    await expect(page.locator("#venueCompare tr[data-cmp='1']")).toContainText("$10");
    // pick Hyperliquid from the comparison table
    await page.locator("[data-cmp-pick='1']").click();
    await expect(page.locator("#perpLiveTxt")).toContainText("Live · Hyperliquid testnet", { timeout: 15_000 });
    expect((await state(page)).perps.venue).toBe("hyperliquid");
    // honesty: Hyperliquid has not placed a real order yet, and the app says so
    await expect(page.locator("#venuePick button", { hasText: "Hyperliquid" })).toContainText("not live-tested");
    await expect(page.locator("#venueStatus")).toBeVisible();
    await expect(page.locator("#venueStatus")).toContainText("has not yet placed a real Hyperliquid order");
    await expect(page.locator("#perpMarkets tbody tr")).not.toHaveCount(0);
    await pill(page, "risk", "100");
    await pill(page, "lev", "2.5");
    const q = (await state(page)).perps.quote!;
    expect(q.leverage).toBe(2); // Hyperliquid leverage is a whole number: 2.5× becomes 2×
    expect(q.n).toBeCloseTo(Math.floor((200 / q.entry) * 10000) / 10000, 9); // ETH szDecimals = 4
    await expect(page.locator("#perpVenueConnect")).toHaveText("Connect wallet to Hyperliquid");
    await expect(page.locator("#perpConfirm")).toHaveText("Connect wallet to trade");
    // $5 at 1× is under the $10 minimum: sized up to it, and said so
    await pill(page, "risk", "5");
    await pill(page, "lev", "1");
    await expect(page.locator("#perpNotes")).toContainText("Smallest order is");
    expect((await state(page)).perps.quote!.notional).toBeGreaterThanOrEqual(10);
  });
});

test.describe("hyperliquid: trading", () => {
  test("one agent approval, then one-tap: market long with TP/SL → account card → close ½ → flip → cancel all → close all → history → disconnect revokes @mobile", async ({ page }) => {
    const app = await openApp(page);
    await toHl(page);
    await connect(page);
    await pill(page, "risk", "100");
    await pill(page, "lev", "3");
    const entry = (await state(page)).perps.quote!.entry;
    await page.locator("#ppTpsl summary").click();
    await page.locator("#ppTp").fill(String(Math.round(entry * 1.2)));
    await page.locator("#ppSl").fill(String(Math.round(entry * 0.85)));
    await page.locator("#perpAgree").check();
    await expect(page.locator("#perpConfirm")).toBeEnabled();
    await page.locator("#perpConfirm").click();
    await expect(page.locator("#perpStep")).toContainText("Filled", { timeout: 15_000 });
    await expect(page.locator("#perpStep")).toContainText("2 of 2 TP/SL placed");
    // exactly ONE wallet signature: the agent approval (orders, leverage, TP/SL are signed by the agent)
    expect(app.wallet!.typedData.length).toBe(1);
    expect((app.wallet!.typedData[0] as { primaryType: string }).primaryType).toBe("HyperliquidTransaction:ApproveAgent");
    const ms = await mockState(app.sid);
    expect(ms.agents).toHaveLength(1);
    expect(ms.agents[0]![1].name).toBe("peo");
    expect(ms.log.filter((l) => l.type === "order" || l.type === "updateLeverage").every((l) => l.signer === ms.agents[0]![0])).toBe(true);
    expect(ms.lev[app.wallet!.address]!.ETH).toEqual({ type: "cross", value: 3 });

    const card = page.locator("#venueAcct");
    const row = card.locator("tr[data-perp-pos='ETH-PERP']");
    await expect(row).toContainText("Long", { timeout: 10_000 });
    await expect(card.locator("#perpTriggers tbody tr")).toHaveCount(2, { timeout: 10_000 });
    await expect(card.locator("#venueWho")).toContainText("one-tap key");
    await card.locator("[data-perp-half='ETH-PERP']").click();
    await expect(card.locator("#venueStep")).toContainText("filled", { timeout: 10_000 });
    await card.locator("[data-perp-flip='ETH-PERP']").click();
    await expect(card.locator("#venueStep")).toContainText("Flipped", { timeout: 10_000 });
    await expect(row).toContainText("Short", { timeout: 10_000 });
    await card.locator("#venueCancelAll").click();
    await expect(card.locator("#venueStep")).toContainText("All open orders cancelled", { timeout: 10_000 });
    await expect(card.locator("#perpTriggers")).toHaveCount(0, { timeout: 10_000 });
    page.on("dialog", (d) => void d.accept());
    await card.locator("#venueCloseAll").click();
    await expect(card.locator("#venueStep")).toContainText("ETH-PERP filled", { timeout: 10_000 });
    await expect(card).toContainText("No perp positions.", { timeout: 10_000 });
    await expect(card.locator("#venuePnl")).toContainText("ETH-PERP", { timeout: 10_000 });
    expect(app.wallet!.typedData.length).toBe(1); // still only the approval
    // disconnect revokes: the named slot now holds a burned key, the session agent is gone
    const agent = ms.agents[0]![0];
    await card.locator("#venueDisconnect").click();
    await expect(page.locator("#perpVenueConnect")).toBeVisible({ timeout: 10_000 });
    const after = await mockState(app.sid);
    expect(after.agents.map((a) => a[0])).not.toContain(agent);
    expect(app.wallet!.typedData.length).toBe(2);
  });

  test("post-only limit rests and is cancelled from the card; Check order proves the signature without trading", async ({ page }) => {
    const app = await openApp(page);
    await toHl(page);
    await connect(page);
    await pill(page, "risk", "100");
    await page.locator("#perpCheck").click();
    await expect(page.locator("#perpCheckStep")).toContainText("recovered our signature exactly", { timeout: 10_000 });
    expect(app.wallet!.typedData.length).toBe(0); // the dry run needs no wallet at all
    const mark = (await state(page)).perps.quote!.entry;
    await page.locator("[data-otype=limit]").click();
    await page.locator("#ppPostOnly").check();
    await page.locator("#ppLimit").fill(String(Math.round(mark * 1.05)));
    await page.locator("#perpAgree").check();
    await expect(page.locator("#perpNotes")).toContainText("Post-only buy must be below the ask");
    await expect(page.locator("#perpConfirm")).toBeDisabled();
    await page.locator("#ppLimit").fill(String(Math.round(mark * 0.95)));
    await expect(page.locator("#perpConfirm")).toBeEnabled();
    await page.locator("#perpConfirm").click();
    await expect(page.locator("#perpStep")).toContainText("resting on the book", { timeout: 15_000 });
    await expect(page.locator("#venueOrders tbody tr")).toHaveCount(1, { timeout: 10_000 });
    await page.locator("#venueOrders [data-venue-cancel]").click();
    await expect(page.locator("#venueStep")).toContainText("Order cancelled", { timeout: 10_000 });
    await expect(page.locator("#venueOrders")).toHaveCount(0, { timeout: 10_000 });
  });

  test("isolated margin: the leverage is set isolated and the risk words change", async ({ page }) => {
    const app = await openApp(page);
    await toHl(page);
    await connect(page);
    await page.locator("#perpMode").selectOption("isolated");
    await expect(page.locator("#perpAgree + span")).toContainText("isolated-margin");
    await pill(page, "risk", "50");
    await pill(page, "lev", "4");
    await expect(page.locator("#perpLiq")).not.toContainText("None"); // isolated: only the margin backs it
    await page.locator("#perpAgree").check();
    await page.locator("#perpConfirm").click();
    await expect(page.locator("#perpStep")).toContainText("Filled", { timeout: 15_000 });
    expect((await mockState(app.sid)).lev[app.wallet!.address]!.ETH).toEqual({ type: "isolated", value: 4 });
  });
});

test.describe("hyperliquid: money in and out", () => {
  test("deposit: Arbitrum Sepolia is added and selected, one exact-amount authorization + one tx, credited on Hyperliquid", async ({ page }) => {
    const app = await openApp(page, "hlempty");
    await toHl(page);
    await page.locator("#perpVenueConnect").click();
    await expect(page.locator("#perpAcct")).toContainText("$0.00", { timeout: 10_000 });
    await page.locator("#perpDeposit").click();
    await expect(page.locator("#sheetBody")).toContainText("Arbitrum Sepolia");
    await page.locator("#hlDepAmt").fill("4");
    await expect(page.locator("#hlDepGo")).toBeDisabled(); // under the 5 USDC minimum
    await page.locator("#hlDepAmt").fill("25");
    await page.locator("#hlDepGo").click();
    await expect(page.locator("#hlDepStep")).toContainText("Deposit sent", { timeout: 15_000 });
    await expect(page.locator("#hlDepStep")).toContainText("24.80 USDC");
    expect(app.wallet!.calls).toContain("wallet_addEthereumChain");
    expect(app.wallet!.calls).toContain("cctp:25000000");
    expect(app.wallet!.calls).not.toContain("eth_sendTransaction:approve"); // never an approval
    const td = app.wallet!.typedData.at(-1) as { primaryType: string; message: { value: string; to: string } };
    expect(td.primaryType).toBe("ReceiveWithAuthorization");
    expect(td.message.value).toBe("25000000");
    expect(td.message.to.toLowerCase()).toBe("0x8e4e3d0e95c1bec4f3ec7f69aa48473e0ab6eb8d"); // CctpExtension (Arbitrum Sepolia)
    expect((await mockState(app.sid)).balance[app.wallet!.address]).toBeCloseTo(24.8, 6);
  });

  test("testnet deposit is refused for an address with no Hyperliquid mainnet account (it would be lost)", async ({ page }) => {
    const app = await openApp(page, "hlnomain");
    await toHl(page);
    await page.locator("#perpVenueConnect").click();
    await expect(page.locator("#perpAcct")).toContainText("$0.00", { timeout: 10_000 });
    await page.locator("#perpDeposit").click();
    await page.locator("#hlDepAmt").fill("25");
    await page.locator("#hlDepGo").click();
    await expect(page.locator("#hlDepStep")).toContainText("Deposit was not sent", { timeout: 15_000 });
    expect(app.wallet!.calls).not.toContain("cctp:25000000");
    expect(app.wallet!.typedData.some((t) => (t as { primaryType: string }).primaryType === "ReceiveWithAuthorization")).toBe(false);
    await expect(page.locator("#hlDepGo")).toBeEnabled();
  });

  test("withdraw: signed by the wallet (withdraw3), paid to the same address", async ({ page }) => {
    const app = await openApp(page);
    await toHl(page);
    await connect(page);
    await page.locator("#perpWithdraw").click();
    await expect(page.locator("#sheetBody")).toContainText("cannot withdraw");
    await page.locator("#hlWdAmt").fill("10");
    await page.locator("#hlWdGo").click();
    await expect(page.locator("#hlWdStep")).toContainText("Withdrawal accepted", { timeout: 10_000 });
    expect((app.wallet!.typedData.at(-1) as { primaryType: string }).primaryType).toBe("HyperliquidTransaction:Withdraw");
    expect((await mockState(app.sid)).withdrawals).toEqual([{ user: app.wallet!.address, amount: "10", destination: app.wallet!.address }]);
  });

  test("mainnet: REAL MONEY is required, the per-trade limit applies, deposits need the phrase too", async ({ page }) => {
    await openApp(page);
    await page.locator("#builder [data-net=mainnet]").click();
    await expect(page.locator("#liveTxt")).toContainText("Live · Derive mainnet", { timeout: 15_000 });
    await connectWallet(page); // the per-trade limit lives in Portfolio settings
    await page.locator("[data-view=portfolio]").click();
    await page.locator("#maxCostIn").fill("50");
    await page.locator("#maxCostSave").click();
    await page.locator("[data-view=perps]").click();
    await page.locator("#venuePick button", { hasText: "Hyperliquid" }).click();
    await page.locator("#perps [data-net=mainnet]").click();
    await expect(page.locator("#perpLiveTxt")).toContainText("Live · Hyperliquid mainnet", { timeout: 15_000 });
    await expect(page.locator("#perpNetNote")).toBeVisible();
    await page.locator("#perpVenueConnect").click();
    await expect(page.locator("#perpAcct")).toContainText("$1,000", { timeout: 10_000 });
    await expect(page.locator("#perpReal")).toBeVisible();
    await pill(page, "risk", "100");
    await page.locator("#perpAgree").check();
    await expect(page.locator("#perpConfirm")).toHaveAttribute("data-reason", "cap");
    await pill(page, "risk", "40");
    await expect(page.locator("#perpConfirm")).toHaveAttribute("data-reason", "phrase");
    await page.locator("#perpReal").fill("REAL MONEY");
    await expect(page.locator("#perpConfirm")).toContainText("Real money: Go long");
    await page.locator("#perpDeposit").click();
    await expect(page.locator("#sheetBody")).toContainText("Arbitrum One");
    await page.locator("#hlDepAmt").fill("25");
    await expect(page.locator("#hlDepGo")).toBeDisabled();
    await page.locator("#hlDepReal").fill("REAL MONEY");
    await expect(page.locator("#hlDepGo")).toBeEnabled();
  });
});
