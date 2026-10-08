# Mainnet QA checklist (run on your phone)

Run this in the **MetaMask mobile in-app browser** (Browser tab → open
`https://hasen1506.github.io/Plain-English-Options/`). Every step up to section 5
is free or testnet. Sections 5–7 use real money and should only be run once you
have decided to fund mainnet.

Tick each box. If something does not match, screenshot it and note the step.

## 0. Before you start
- [ ] MetaMask mobile is up to date.
- [ ] You know which account you will use for Derive. The app shows it in the sign-in sheet.
- [ ] For testnet: a little Sepolia ETH in that account (any faucet) and test USDC (testnet.app.derive.xyz → Deposit → Mint).

## 1. Wallet connection (testnet)
- [ ] The page loads, the chip says **Live · Derive testnet**.
- [ ] Tap **Connect wallet** → MetaMask asks to connect → approve.
- [ ] The sign-in sheet shows your address. Tap **Sign in** → MetaMask shows a *Signature request* whose message is a 13-digit number (a timestamp). Sign.
- [ ] If MetaMask did not know Sepolia, it asked to **add** then **switch** to Sepolia. Approve both. (The app handles MetaMask's "Unrecognized chain ID" answer.)
- [ ] Reject the signature once on purpose: the balance pill says *You rejected the request in your wallet* and goes back to **Connect wallet** (no hang).

## 2. Onboarding (testnet, new wallet only)
- [ ] With a wallet that never used Derive testnet, signing in opens **Open your Derive testnet account**, naming risk universe 1 (PRIME).
- [ ] Amount 4 → "Minimum deposit is $5". Amount 100 → **Review deposit** shows two steps (Approve, Deposit into a new subaccount) and a network-fee line.
- [ ] **Approve and deposit** → MetaMask shows an *approve* for exactly 100 USDC (not unlimited), then a contract call to `0xd362…FceB68` (testnet ActionManager).
- [ ] Both steps turn green with explorer links. After ~2 minutes **Sign in to your new account** works and the pill shows $100.00 · RU1.

## 3. One-tap trading (testnet)
- [ ] After sign-in the app offers **Enable one-tap trading?** → tap it → MetaMask shows one *typed-data* request (primary type `Action`, chainId 11155111). Sign.
- [ ] The pill shows **· one-tap**. Build a small ETH spread (e.g. make $10) → Review → *Signed by: One-tap key (no wallet prompt)*.
- [ ] Tick the box → Confirm → **Position opened** with **no** MetaMask prompt.
- [ ] Portfolio → **Close spread** → filled, again no prompt.
- [ ] History → the closed spread appears with a realised P/L after fees.
- [ ] Pill → **Disconnect** → MetaMask asks for one signature (revoking the key). Sign. Pill returns to **Connect wallet**.
- [ ] Reload the page: you must sign in again (the key was only in memory).

## 4. Safety controls (testnet)
- [ ] Review → **Check order (no trade)** → "Derive verified both signatures on testnet. No order was sent." Portfolio shows no new position.
- [ ] Portfolio → **Cancel all orders** works with and without open orders.
- [ ] Portfolio → Safety → set a limit of 1 → switch to Mainnet → Review shows *Above your $1.00 limit per trade*. Clear the field and **Save limit** → the limit is off again (it is off by default).
- [ ] Pill → **Withdraw** 5 → MetaMask typed-data prompt → "Withdrawal accepted · operation …".

## 4b. Perps (testnet)
- [ ] **Perps** tab lists ETH-PERP, BTC-PERP and the rest with mark, index, 24h, funding and OI.
- [ ] "ETH goes UP, risk $30 at 5×": size, entry, liquidation, fees, funding per hour + APR and the max-loss sentence all show. Subaccount picker shows only RU1 subaccounts (with Deposit / Withdraw).
- [ ] Market long with a take-profit and stop-loss → one-tap fills the entry with no prompt; MetaMask asks for the TP/SL signatures (they last 30 days). Portfolio shows the position, liq price, funding and the two triggers.
- [ ] Portfolio → **Close ½**, then **Flip**, then **Close** → flat.
- [ ] Post-only limit above the ask → blocked with "Post-only buy must be below the ask". Below the bid → resting; **Cancel all orders** removes it.
- [ ] **Check order (no trade)** in Perps → "Derive verified the ETH-PERP order signature on testnet. No order was sent."
- [ ] Portfolio → Safety → leverage cap 3 → a 5× quote is blocked with "Leverage is capped at 3× (your setting)".
- [ ] **Close all positions** with a perp and an option open → everything cancelled and closed.
- [ ] History → Perps shows the fills, fees, funding and realised P&L.

## 4c. Hyperliquid (testnet) — NOT live-tested yet
The app labels Hyperliquid "not live-tested". Hyperliquid testnet only opens accounts for
addresses that already have a Hyperliquid **mainnet** account, so this section needs a
wallet that has deposited at least 5 USDC on Hyperliquid mainnet (or used it before).
- [ ] Perps → venue picker shows **Derive** and **Hyperliquid (not live-tested)**; the amber banner explains why. The comparison table lists ETH on both with price, funding, fees ($10 minimum, 0.045% / 0.015% on Hyperliquid).
- [ ] Pick Hyperliquid → chip **Live · Hyperliquid testnet**. **Connect wallet to Hyperliquid** → MetaMask shows one typed-data request, primary type `HyperliquidTransaction:ApproveAgent`. Sign.
- [ ] Deposit with an address that has **no** mainnet Hyperliquid account → "Deposit was not sent" and no MetaMask prompt.
- [ ] Deposit 10 USDC from Arbitrum Sepolia (Circle faucet: faucet.circle.com) → MetaMask adds/switches to Arbitrum Sepolia, asks for one `ReceiveWithAuthorization` for exactly 10 USDC, then one transaction to `0x8E4e…eB8D`. About 9.80 arrives within minutes.
- [ ] ETH goes UP, $10 at 2× with TP and SL → fills with **no** wallet prompt; the card shows the position, liq price and two triggers.
- [ ] Close ½ → Flip → Close → flat. Post-only limit below the bid rests; Cancel removes it.
- [ ] Check order (no trade) → "Hyperliquid recovered our signature exactly … nothing was traded.". History shows the fills.
- [ ] Disconnect → the agent is revoked. Withdraw 5 → one `HyperliquidTransaction:Withdraw` signature; $1 fee.

## 5. Mainnet without money (free)
- [ ] Tap **Mainnet**. The banner says orders use real money; the pill has a red **REAL MONEY** chip and a red outline.
- [ ] Signing in with an unfunded wallet opens **Open your Derive mainnet account** (risk universe 1, PRIME, minimum $5). Close it without depositing.
- [ ] MetaMask switches to **Ethereum Mainnet** (chainId 1) when you sign. It never asks for Sepolia while on Mainnet.

## 6. Mainnet funding (real money: see the funding steps in the README)
- [ ] Deposit sheet → amount → **Review deposit** shows the approve + deposit steps, the target `0xE366…CFAD3` (mainnet ActionManager, from docs.derive.xyz/getting-started/contracts) and a network-fee estimate in ETH and USD.
- [ ] The button stays disabled until you type **REAL MONEY**.
- [ ] MetaMask's approve is for **USDC `0xA0b8…eB48`** and exactly your amount.
- [ ] After ~2 minutes the new subaccount appears with your balance and **RU1**.

## 6b. Hyperliquid mainnet (real money) — only after 4c passes
- [ ] Do not fund Hyperliquid mainnet for trading until section 4c has passed end to end; until then the app correctly says "not live-tested".
- [ ] Mainnet deposit (Arbitrum One USDC `0xaf88…5831`, CctpExtension `0xA95d…4fcE`): the button stays disabled until you type **REAL MONEY**; minimum 5 USDC; Circle's fee ~0.20 USDC; a brand-new Hyperliquid account also pays Hyperliquid's one-time 1 USDC activation fee on its first outbound action.
- [ ] Check order (no trade) on mainnet first. Confirm needs **REAL MONEY**; the per-trade limit and leverage cap apply.

## 7. Mainnet first trade (real money, after funding)
- [ ] Review → **Check order (no trade)** first → "Derive verified both signatures on mainnet. No order was sent." Same in Perps for ETH-PERP.
- [ ] Perps on mainnet: Confirm stays disabled until you type **REAL MONEY**; the per-trade limit (if set) caps the money put in; the leverage cap applies.
- [ ] Optionally set a per-trade limit in Portfolio → Safety.
- [ ] Smallest size you are comfortable with → tick → type **REAL MONEY** → *Pay real money: $…*. Check the amount, then confirm.
- [ ] Result screen shows both legs filled with order ids. Portfolio shows the spread. **Cancel all orders** is available as a kill switch.

## Desktop alternative for section 7's dry run
`DERIVE_SESSION_KEY=… DERIVE_WALLET=… DERIVE_SUBACCOUNT_ID=… npm run check:mainnet` signs a spread plus the smallest ETH-PERP market and post-only orders and sends them only to `private/order_debug` (and simulates the perp with read-only `private/get_margin`; `CHECK_PERPS=0` skips perps). The script cannot send `private/order` (enforced by `ReadOnlyRpc` and unit tests).
