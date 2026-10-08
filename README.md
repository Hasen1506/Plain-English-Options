# Plain English Options

Say what you think a coin will do, in plain English, and get a defined-risk options spread on [Derive](https://derive.xyz):

> I want to make **$1,000** if **ETH** **hits** **$3,000** by **Nov 27**

The app turns that sentence into a listed debit spread, prices it from the live Derive v3 order book, shows the payoff, and places it with your own wallet.

The **Perps** tab does the same for perpetual futures:

> I think **ETH** goes **UP**, risking **$100** at **5×**

It shows the size, expected entry, liquidation price, fees, funding (per hour and annualised) and the most you can lose before you confirm.

**Live app:** https://hasen1506.github.io/Plain-English-Options/

Concept: the @rightclcksaveas video. Not financial advice.

## How the sentence becomes a trade

| Sentence | Spread | Long leg (bought) | Short leg (sold) |
| --- | --- | --- | --- |
| "hits" a target above spot | bull call spread | highest listed call strike ≤ spot | listed call strike > spot nearest the target |
| "drops to" a target below spot | bear put spread | lowest listed put strike ≥ spot | listed put strike < spot nearest the target |

- Prices are the real book: the ask for the leg you buy, the bid for the leg you sell, tick-aligned.
- Size is chosen so the payout **after Derive fees** reaches the amount you asked for, rounded up to the instrument's `amount_step` and at least its `minimum_amount`.
- Max loss = net debit + fees. Max profit = contracts × width − debit − fees.
- "Chance it happens" is the risk-neutral probability of ending beyond your exact target, from the listed IV smile (monotone in the target by construction).
- Only active, not-yet-deactivated, unexpired instruments are ever used.

## Perpetuals

- **Markets:** every live Derive perp (`public/get_all_instruments`, `instrument_type: perp`) with mark, index, 24h change, funding rate and open interest. ETH and BTC first.
- **Sizing:** notional = risk × leverage; contracts = notional ÷ entry, rounded **down** to `amount_step` so you never put in more than you asked. Below `minimum_amount` the minimum is used and the app says how much that puts in.
- **Orders:** *Market* = `order_type: market`, IOC, signed with a worst price 0.5% through the touch (inside the exchange price band, on the tick). *Limit* = GTC, or *post-only* (`time_in_force: post_only`, `reject_post_only`), blocked before signing if it would cross. Resting orders sign for 7 days (or until the one-tap key expires).
- **Take-profit / stop-loss:** reduce-only market trigger orders on the mark price, sized to what filled. Derive requires trigger signatures to live 30–90 days, longer than a one-tap key, so they are always signed by your wallet.
- **Close:** reduce-only market IOC for all or half a position; **Flip** signs the close and the opposite open first and only opens the new side after a full close.
- **Risk universe:** a perp trades only from a subaccount whose manager lists it (`public/get_risk_universes`; ETH-PERP and BTC-PERP are universe 1, PRIME). The tab lists only those subaccounts, with Deposit / Withdraw buttons and "Deposit into a new one" when there is none.
- **Margin:** Derive subaccounts are cross-margined. Liquidation price is estimated from the subaccount's own maintenance headroom (exact for a one-perp account, shown as "near" otherwise); before Confirm, `private/get_margin` simulates the trade on the exchange. Fees = notional × taker (or maker) rate + base fee.
- **Portfolio:** perp positions with size, entry, mark, uPnL, funding (settled + pending), liquidation price (Derive's own figure), take-profit / stop-loss triggers with Cancel, Close / Close ½ / Flip, and a margin-usage warning from 50% (danger from 80%). **History:** per perp market, the number of trades, average-cost realised P&L, fees, funding and the net; the total equals Derive's own `realized_pnl` (checked on live testnet fills).
- **Venue adapters:** the Perps tab, Portfolio and History only talk to the `PerpVenue` interface (`src/venues/types.ts`: markets/tickers, account routing, sizing rules via `PerpMarket`, open/close/flip/triggers/cancel-all, history, one-tap signer, deposit/withdraw, dry run). Adapters: Derive (`src/venues/derive.ts`), Hyperliquid (`src/venues/hyperliquid/`) and Veranta (`src/venues/veranta/`), registered in `src/venues/index.ts`. A venue picker and a side-by-side comparison table (price, funding, taker/maker fee, max leverage, minimum order) appear once there are two. Each adapter carries an honest `status`: a venue that has not completed a real testnet round trip is labelled in the picker, the comparison table and a banner.

## Trading categories (Perps)

The Perps market list (tap the coin in the sentence) has a category row: **Crypto, Commodities, Stocks, Indices, FX**, in the same pills, rows (price, 24h change, sparkline), black selected row and motion as the options asset list. A venue only shows the categories it really lists, and every category comes from the venue's own data:

| Venue | Where the category comes from | What it lists (checked 2026-10-08) |
|---|---|---|
| Hyperliquid | Its own validator-operated perps are all crypto. Non-crypto markets come from the HIP-3 builder dex **xyz** (trade.xyz; `perpDexs` → index 1 on mainnet, 65 on testnet), classified by the deployer's own on-chain annotation (`perpConciseAnnotations`: category + display name). Pre-IPO and un-annotated coins are left out. | Mainnet xyz: commodities (GOLD, SILVER, COPPER, PLATINUM, PALLADIUM, WTIOIL, BRENTOIL, NATGAS, DIESEL), US/Asian stocks, indices (S&P500, XYZ100, JP225, KR200…), FX (EURUSD, GBPUSD, USDJPY). Testnet xyz (a different deployer) lists a smaller set with thin books. |
| Veranta | The pair's price feed `assetType` (crypto, metal, commodity, fx, equity); US500/US100 are indices. | XAU, XAG, WTI, BRENT; NVDA, AAPL, MSFT and other US stocks (most close with the US market); US500 (SPY feed), US100; EUR, GBP, AUD, NZD against USD. Pairs quoted in another currency (USD/JPY…) are left out. Testnet WTI/BRENT had no live price. |
| Derive | All perps are crypto except **XAUT-PERP** (Tether Gold, a gold-backed token), which the app files under Commodities. This is the app's classification, not Derive's. | 14 crypto perps + XAUT. |

Builder (HIP-3) markets are labelled with their dex and deployer ("xyz · trade.xyz builder market") and a plain-English note: deployed by a third party on Hyperliquid, can trade 24/7 while the underlying market is closed, own leverage caps, isolated margin. Order placement for them is wired from Hyperliquid's docs and **untested with real orders** (see "Not verified for Hyperliquid"): the order asset id is `100000 + dex_index × 10000 + index_in_meta`; the app trades them isolated only (several are isolated-only on the exchange too); each perp dex margins separately, so before an order the one-tap agent moves exactly the missing margin (+1%) from the main USDC balance to the dex with `agentSendAsset` (skipped when the account has Hyperliquid's unified / portfolio / dex abstraction on); HIP-3 fees are 2× the base rate (deployerFeeScale 1.0), ×0.1 with growth mode. Hyperliquid's real testnet recovered our throwaway signer for a builder order, an isolated leverage change and the `agentSendAsset` transfer (byte-exact hashing; nothing can execute from a key without an account).

## Hyperliquid (not live-tested yet)

Status: **built and tested against a mock exchange and Hyperliquid's own signature check, but no real Hyperliquid order has been placed by this app yet, not even on testnet.** The app labels Hyperliquid "not live-tested" in the venue picker, the comparison table and a banner. See "What is verified" below.

- **API:** `POST https://api.hyperliquid.xyz/info` and `/exchange` (testnet `api.hyperliquid-testnet.xyz`), CORS open, called straight from the browser. Order books per market from `l2Book`.
- **One-tap agent key:** Connect asks the wallet for one EIP-712 `HyperliquidTransaction:ApproveAgent` signature for a fresh key generated in the tab (named `peo valid_until <ms>`, 24 h). Orders, cancels and leverage changes are L1 actions (msgpack + phantom-agent EIP-712) signed by that key with no wallet prompt. The key cannot withdraw. Disconnect revokes it: the wallet approves a throwaway key under the same agent name (which replaces the old key) that expires a minute later.
- **Orders:** market = IOC limit 0.5% through the touch, rounded to Hyperliquid's 5-significant-figure / `szDecimals` rules; limit = GTC or post-only (ALO, blocked before signing if it would cross); TP/SL = reduce-only trigger orders placed in the same `normalTpsl` group as the entry. Close / Close ½ = reduce-only IOC; Flip = close, then open the other side only after a full close. Leverage is whole-number (2.5× becomes 2×), cross or isolated.
- **Minimums and fees (official docs):** $10 minimum order notional; base fees 0.045% taker / 0.015% maker (your own tier is read from `userFees`).
- **Deposit:** USDC on Arbitrum through Circle CCTP v2 (`CctpExtension.batchDepositForBurnWithAuth`, the route Hyperliquid's docs recommend): one EIP-3009 `ReceiveWithAuthorization` for the exact amount (no ERC-20 approval ever), one transaction, Circle's ~0.20 USDC forwarding fee, minimum 5 USDC. On **testnet** the app first asks Hyperliquid mainnet whether the address has an account and refuses the deposit if not, because Hyperliquid testnet only opens accounts for addresses that exist on mainnet and anything else is lost (it happened to our own test deposit, below).
- **Withdraw:** a wallet-signed `withdraw3` to the same address on Arbitrum; Hyperliquid charges $1.
- **Dry run (Check order):** signs the exact order with a throwaway key that has no account and sends it to `/exchange`; Hyperliquid answers "User or API Wallet 0x… does not exist" with the address it recovered. A match proves our hashing and signing are byte-exact; nothing can trade.

### What is verified for Hyperliquid
- Signature dry run against the **real** testnet and mainnet `/exchange` (`npm run test:live -- tests/live/hyperliquid.test.ts`): passed 2026-10-08 on both.
- Sign vectors, rounding against the official SDK's formula (600 samples), liquidation and funding against the documented formulas, parsers on recorded mainnet and testnet frames (unit + differential tests).
- E2E against `tests/mock/hyperliquid.ts`, which verifies every agent approval, L1 order signature and withdraw3 signature.

### Not verified for Hyperliquid
- **Builder (HIP-3) markets:** no real order, leverage change or `agentSendAsset` collateral move has been accepted by Hyperliquid for a funded account; only the signatures were checked against the real testnet. What `userAbstraction: "default"` means for collateral is not confirmed; the app treats it like "disabled" (it moves the margin itself).
- **No real order, TP/SL, close, flip or cancel has been sent with a funded account.** The live round trip in `tests/live/hyperliquid.test.ts` needs a funded testnet key (`HL_TESTNET_KEY_FILE`).
- Our test address `0xEAA4…7D81` sent a 19 USDC CCTP deposit on 2026-10-08 (Arbitrum Sepolia tx `0x65c15cbd…7a7e`, HyperEVM forward tx `0xfa6018b4…09d6`). Circle minted and forwarded 18.8 USDC to the CoreDepositWallet, but Hyperliquid testnet never created the account (`userRole: missing`, `coreUserExists` false), the known testnet behaviour in hyperliquid-dex/node#138. Unlocking testnet needs that address to have a Hyperliquid **mainnet** account (a ≥5 USDC mainnet deposit), which this project's rules do not allow. Details: `docs/live-hyperliquid-testnet.json`.
- The deposit and withdraw flows have only run against the mock (the deposit's Arbitrum Sepolia transaction did go through on-chain).

## Veranta on Base (testnet practice account; mainnet coming soon)

Status: **live-tested once in the browser on Veranta testnet (2026-10-08) with a practice account; mainnet is coming soon and cannot be picked.** The app's own UI, as a production build in Chromium, opened, closed, flipped and cancelled real testnet orders through Veranta's SDK. Nothing has run on mainnet.

- **Why a practice account:** Veranta's testnet is a private fork of Base with the **same chain id (8453)** and the same contracts. A browser wallet cannot point at it safely (its "Base" is the real Base), and an EIP-712 signature made for the fork is also valid on mainnet. So on testnet the app **never asks your wallet to sign**: Start creates a trader key and a session key in the tab (memory only, gone on reload), funds the trader with test USDC from Veranta's fork faucet (falling back to another fork USDC holder through the fork's own `dev_impersonateTransaction` when the faucet runs dry), and registers the session key for 30 days (Veranta's default). Mainnet Veranta is shown as **coming soon** and cannot be picked.
- **SDK:** the official `veranta-sdk` 0.3.1 (with `viem` 2.57.4), pinned, lazy-loaded only when Veranta is picked. Every endpoint it calls answers CORS with `*`, so it runs in the static app.
- **Orders:** no order book: market orders fill at the oracle price ± the pair spread, signed by the session key and relayed gaslessly (`trade.marketOpen` / `limitOpen` / `marketClose` / `cancelLimitOrder` / `updateTpSl`). 1% worst-price slippage. TP/SL sit on the position itself (Veranta stores a take-profit on every position; an "empty" one is the pair's maximum gain). Close / Close ½ close collateral; Flip closes in full, then reopens the other way with what came back. Veranta keeps every trade separate, so the app refuses a second position in the same market.
- **USDC approvals:** always for **exactly** the next trade's collateral, never unlimited; the trade uses it up. Disconnect sets any leftover allowance back to 0 and revokes the session key.
- **Minimums, fees, liquidation** (live pair catalogue, `markets.pairs()`): minimum position = money put in × leverage ≥ `minLevPosUSDC` (ETH/USD: $100); the default order is raised above the minimum if needed. Open fee = maker (0.01%) when the trade moves open interest toward balance, taker (0.045%) when it adds to the heavier side, a blend when it crosses the middle; it is taken from the collateral. Isolated margin; liquidation when the loss reaches 85% of the margin.

### What is verified for Veranta
- **SDK round trip on the real testnet** (Node, the same calls the app makes, 2026-10-08): faucet, 30-day session key, exact approvals, market long 40 × 5 with TP/SL (order 6445226), partial close (6445227), close (6445228), short (6445229), close (6445230), limit −15% placed and cancelled, flat, allowance 0, session key revoked. Every tx hash: `docs/live-veranta-sdk-testnet.json`.
- **Browser round trip on the real testnet, once** (`npm run test:live:browser`, the production build in Chromium using only the app's UI, 2026-10-08): practice account from the faucet with a 30-day session key, market long $50 × 5 with TP/SL (order 6445257), close ½ (6445259), flip (6445261 close, 6445262 short), close (6445263), a fresh short (6445264) and its close (6445265), a limit order 15% below placed and cancelled; ended flat (0 positions, 0 limit orders), USDC allowance 0 and the session key unable to sign after Disconnect. Order ids and tx hashes come from Veranta's history API: `docs/live-veranta-testnet.json`. In that record the UI text saved for the "market short" step is stale (it repeats the long's message); the order itself (6445264) is in the history. The limit order's UI message showed `order 0:0` rather than a real index.
- Unit + fast-check properties (`tests/unit/veranta-rules.test.ts`): catalogue → markets on the recorded testnet and mainnet catalogues, sizing never below the minimum, fee always between maker and taker, liquidation loss exactly 85% of margin, USDC rounding never above what was asked, position / limit / history parsers.
- Differential (`tests/diff/veranta-reference.test.ts`): the app's open-fee rule and liquidation price against the SDK's own `compute.pairOpenMakerTakerFeeP` and `compute.estimateLiquidationPrice` on random inputs and every recorded pair's real open interest.
- E2E (`tests/e2e/veranta.spec.ts`, desktop + mobile) against `tests/mock/veranta.ts`: picker and honesty text, the default above the minimum, mainnet disabled, the full practice flow with exact approvals, no wallet signature at all, Disconnect revoking the key and leaving allowance 0.

### Not verified for Veranta
- Anything on **mainnet** (not built: it would need the user's own wallet on Base and is shown as coming soon).
- Liquidations, funding and borrowing fees over time, TP/SL actually triggering, and the faucet fallback path (the SDK faucet worked on every run so far).

## Trading safety

- **Your wallet signs everything.** Login is an EIP-191 signature; every order is an EIP-712 `Action` signed with `eth_signTypedData_v4`. The digest is byte-identical to what Derive verifies (checked against `private/order_debug` and covered by tests).
- **Leg risk.** Testnet RFQs get no maker quotes, so a spread is two fill-or-kill limit orders. The long leg, the short leg *and* an unwind of the long leg are all signed before anything is sent. If the short leg fails, the pre-signed unwind goes out immediately.
- **Price protection.** Entry limits are capped at 2% worse than the quoted book; fills happen at the best available price. Confirm checks your balance against that worst case.
- **Risk universes.** Derive v3 subaccounts belong to one risk universe (RU1 BTC/ETH, RU2 HYPE, RU3 alts). The app only lets you trade from a subaccount in the asset's universe, and tells you how to create one if you have none.
- **Mainnet.** Switching to Mainnet shows a "real money" banner and a red REAL MONEY chip on the balance; Confirm, deposits and withdrawals stay disabled until you type `REAL MONEY`. Tests never trade or deposit on mainnet.
- **One-tap trading (session key).** After sign-in the app offers to create a session key in the tab's memory, registered with one wallet signature (`private/set_session_key`, scopes `trade:orderbook:option` and `trade:orderbook:perp`, the chosen subaccounts, 24 h). An older options-only key is not used for perps (the wallet signs instead). Orders are then signed by the key, so a spread is one tap. It cannot withdraw, transfer or create keys. Disconnect revokes it (re-registers it with the earliest expiry Derive allows, now + 6 min); closing the tab forgets it.
- **Check order (no trade).** Signs both legs and sends them only to `private/order_debug`, which returns the hash Derive would verify. The app compares it with its own digest and recovers the signer. `ReadOnlyRpc` refuses `private/order` and every other state-changing method.
- **Kill switches.** *Cancel all orders* (`private/cancel_all` with trigger and algo orders) in Portfolio and in the subaccount sheet. *Close all positions* cancels everything first, then closes option shorts, option longs and perps with reduce-only orders.
- **Optional per-trade limit.** Portfolio → Safety: a USD limit on the worst-case cost of one mainnet trade (for perps: the money put in). Off by default.
- **Leverage cap.** Portfolio → Safety: perp leverage cap, 1–10× (default 5×); the exchange maximum (ETH-PERP 15.15×) also applies.
- **Check order (no trade) for perps** signs the exact perp order and sends it only to `private/order_debug`.
- **Deposits** go through your wallet on L1: an exact-amount `approve` of USDC to the ActionManager, then `depositToNewSubaccount(asset, amount, managerId, owner)` or `deposit(asset, amount, subaccountId, fallback)`. The manager comes from `public/get_risk_universes`; the app refuses a USDC address other than the network's. Withdrawals are a wallet-signed `private/withdraw` (the session key cannot sign them).
- Confirm is disabled whenever there is no live price, the quote is older than 60 s, a leg has no book, the book is too thin, your balance is short, or the subaccount is in the wrong universe.

## Develop

```bash
npm ci
npm run dev            # http://localhost:5173/
npm run build          # static site in dist/
```

## Tests

```bash
npm run lint && npm run typecheck
npm test               # unit + property (fast-check) + differential, no network
npm run test:e2e       # Playwright against a mock Derive server replaying recorded testnet frames
npm run test:live      # opt-in, real testnet orders, see below
npm run check:mainnet  # read-only mainnet signature check (order_debug only): ETH spread + ETH-PERP market and post-only; needs env
npm run record:perps   # re-record the public perp fixtures (mainnet + testnet)
npm run record:mainnet # re-record the read-only mainnet fixtures
npm run record:sparks  # re-record 24 h of hourly index candles per asset (asset-list sparklines in the e2e mock)
npm run test:live:browser # opt-in: Veranta testnet in Chromium through the UI (production build)
```

- **Property tests** (`tests/unit`): probability bounds and monotonicity, strike bracketing, never using dead instruments, cost ≥ 0, size on step and ≥ minimum, tick-aligned limits, max loss = debit + fees, payoff ≤ width − debit, Confirm never enabled without a live price / with a short balance / in the wrong universe, ticker parsing round-trips and never throws, EIP-712 typed data hashes to the exchange digest, leg-2 failure always leaves you flat or flagged.
- **Differential tests** (`tests/diff`): the app's maths against independent references: perp sizing, P&L and liquidation against an exact-rational reference (`perp-reference`), Hyperliquid rounding, liquidation and funding against the official SDK formula and docs (`hl-reference`), and the old single-file prototype's pricing code is extracted verbatim from `tests/fixtures/old-prototype.html` and compared with the new modules on thousands of random inputs. Intentional differences are asserted and documented in the test file.
- **UI** (`tests/e2e/ui.spec.ts`): the concept-video polish: popovers (live cost under the amount slider; price, 24h % and a sparkline per token from Derive's `public/get_index_chart_data`, none drawn when there is no data; target badge and chance; expiries tagged weekly / monthly / quarterly with a chance pill each), spring-in popovers and number roll that switch off under `prefers-reduced-motion`, the two-column review (stacked on phones), one empty state per tab without a wallet, and the perps venue picker with status dots.
- **E2E** (`tests/e2e`): real user flows in Chromium (desktop and mobile) against `tests/mock/server.ts` (Derive) and `tests/mock/venues-server.ts` (Hyperliquid and Veranta, port 8788), which replay frames recorded from testnet (`npm run record`) and verifies every login and order signature. An injected EIP-1193 mock wallet signs with a fixed test key.
- **Live smoke** (`tests/live`, never in CI): logs in on testnet, places a minimum-size ETH call spread on subaccount 87139 (or `DERIVE_SUBACCOUNT_ID`), checks fills and positions, then closes it.

  ```bash
  DERIVE_PRIVATE_KEY=0x… DERIVE_SUBACCOUNT_ID=87139 npm run test:live
  ```

  The last run's order ids and fills are in `docs/live-smoke-testnet.json`.
- **Live onboarding** (`tests/live/onboarding.test.ts`, never in CI): from a fresh testnet wallet, "Account not found" → approve + `depositToNewSubaccount` into risk universe 1 → credited, deposit into the existing subaccount, withdraw, register a session key, `order_debug` both legs, open and close a spread signed only by the session key, `cancel_all`, history P&L, revoke. Results: `docs/live-onboarding-testnet.json`.

  ```bash
  DERIVE_PRIVATE_KEY=0x… npm run test:live -- tests/live/onboarding.test.ts
  ```
- **Perps** (`tests/unit/perp*.test.ts`, `tests/diff/perp-reference.test.ts`): parsers on recorded mainnet + testnet perp frames; fast-check properties for sizing (on step, ≥ minimum, never more than asked), market protection prices (on tick, in band), post-only, leverage cap, margin checks, fees, funding sign, partial close never exceeding the position, average-cost P&L conservation, and the liquidation root. A differential test compares sizing, P&L and liquidation with an independent exact-rational reference (BigInt fractions, cost-basis ledger, bisection on subaccount equity). Recorded live testnet fills check our realised P&L per fill against Derive's `realized_pnl_excl_fees`. A fake exchange verifies every perp order signature (market, limit, post-only, TP/SL, close, flip, Close all, dry run).
- **Live perps** (`tests/live/perps.test.ts`, never in CI): on testnet subaccount 87142 with a one-tap key scoped to perps: long 0.101 ETH-PERP with take-profit and stop-loss, close; short, close half, close the rest; flip long → short, close; post-only limit resting then cancelled; trade history and funding read; position back to baseline; key revoked. Order ids: `docs/live-perps-testnet.json`.

  ```bash
  DERIVE_PRIVATE_KEY=0x… DERIVE_SUBACCOUNT_ID=87142 npm run test:live -- tests/live/perps.test.ts
  ```
- **Live Veranta in the browser** (`tests/live/veranta.browser.ts`, never in CI): the production build in Chromium (`playwright.live.config.ts`) trades Veranta's real testnet through the UI only: practice account, long with TP/SL, Close ½, Flip, Close, short, Close, limit placed and cancelled, history, flat, Disconnect (allowance 0, session key revoked, both checked with the SDK). Writes `docs/live-veranta-testnet.json`.

  ```bash
  npm run test:live:browser
  ```
- **Mainnet fixtures** (`tests/fixtures/mainnet-public.json`, recorded read-only): risk-universe mapping, USDC route, per-instrument minimum / step / tick, fee rules and chain-1 signing are unit-tested against real mainnet frames.

## Layout

```
src/
  config.ts            networks (Derive v3 testnet + mainnet), domain separators, constants
  lib/                 pure, tested logic
    math.ts            normal CDF, Black-Scholes
    pricing.ts         IV smile, probability at the exact target
    spread.ts          target → listed strikes, sizing, fees, limits
    payoff.ts          expiry payoff and chart points
    state.ts           the sentence builder state machine + view model
    guards.ts          when Confirm may be pressed
    ticker.ts          parsers for v3 frames (slim tickers, instruments, subaccounts)
    market.ts          expiries, spot, live quote
    units.ts           exact decimal ↔ e18 maths
  net/
    client.ts          JSON-RPC over WebSocket: ids, timeouts, reconnect, pagination
    signing.ts         EIP-712 trade actions (ported from derive-py / derive-ts)
    signer.ts          raw-key and injected-wallet signers, chain switching, wallet errors
    trader.ts          spread placement with unwind, close, cancel, pre-trade check
    sessionKey.ts      one-tap session keys: register, sign, revoke
    onchain.ts         risk universes, deposit plans (approve + ActionManager), withdraw
    dryrun.ts          ReadOnlyRpc and private/order_debug checks
    perpTrader.ts      perp orders on Derive: open (+TP/SL), close, flip, Close all, margin check
    account.ts         "no Derive account yet" detection
  lib/history.ts       order/trade history and realised P&L per closed spread
  lib/perp.ts          perp parsers, sizing, fees, funding, liquidation, the order builder
  lib/perpHistory.ts   perp realised P&L (average cost), fees, funding
  venues/              PerpVenue interface, the Derive adapter, hyperliquid/ (client, signing, msgpack, orders, rules, parse, deposit)
  ui/                  DOM controller and HTML views
tests/                 unit, diff, e2e, live, mock server, recorded fixtures
```

## Fund mainnet

See "Funding mainnet" in `docs/qa-mainnet.md` sections 5–7. In short: hold USDC (Circle, `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`) and a little ETH for gas in your wallet on Ethereum mainnet, switch the app to Mainnet, sign in, and use the deposit sheet. ETH and BTC options need a subaccount in risk universe 1 (PRIME, standard-margin manager 1). The minimum deposit is $5; the app's ETH spreads start at 0.1 contracts. Gas: the approve plus `depositToNewSubaccount` used about 130k + 337k gas on Sepolia (a mainnet USDC approve is usually ~50k); keep roughly 0.005 ETH in the wallet to cover the two transactions with room for a gas spike.

## Known limits

- Without one-tap trading, a spread is three wallet signatures (so the unwind is ready).
- History counts trades only: a spread held to expiry settles in cash and is not a trade, so it stays out of the realised P&L table.
- WalletConnect is not built (needs a project id); use an injected wallet such as the MetaMask in-app browser.
- RFQ execution is not used: testnet makers do not quote RFQs. `private/rfq_get_best_quote` is used as a no-signature margin and fee check before you confirm.
- Perp liquidation price is an estimate from the subaccount's maintenance headroom assuming only that perp moves; options and other perps in the same subaccount move it too. Derive's own figure is shown in Portfolio when it reports one.
- Take-profit / stop-loss always need a wallet signature (Derive requires 30–90-day trigger signatures).
- Hyperliquid is wired but not live-tested (see above).
- Veranta runs on testnet with a practice account only; mainnet is coming soon (see above).
- The wallet must own the Derive v3 account, or be a session key registered for it on derive.xyz (enter the owner address in the sign-in sheet).
