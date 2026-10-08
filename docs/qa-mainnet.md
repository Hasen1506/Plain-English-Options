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

## 5. Mainnet without money (free)
- [ ] Tap **Mainnet**. The banner says orders use real money; the pill has a red **REAL MONEY** chip and a red outline.
- [ ] Signing in with an unfunded wallet opens **Open your Derive mainnet account** (risk universe 1, PRIME, minimum $5). Close it without depositing.
- [ ] MetaMask switches to **Ethereum Mainnet** (chainId 1) when you sign. It never asks for Sepolia while on Mainnet.

## 6. Mainnet funding (real money: see the funding steps in the README)
- [ ] Deposit sheet → amount → **Review deposit** shows the approve + deposit steps, the target `0xE366…CFAD3` (mainnet ActionManager, from docs.derive.xyz/getting-started/contracts) and a network-fee estimate in ETH and USD.
- [ ] The button stays disabled until you type **REAL MONEY**.
- [ ] MetaMask's approve is for **USDC `0xA0b8…eB48`** and exactly your amount.
- [ ] After ~2 minutes the new subaccount appears with your balance and **RU1**.

## 7. Mainnet first trade (real money, after funding)
- [ ] Review → **Check order (no trade)** first → "Derive verified both signatures on mainnet. No order was sent."
- [ ] Optionally set a per-trade limit in Portfolio → Safety.
- [ ] Smallest size you are comfortable with → tick → type **REAL MONEY** → *Pay real money: $…*. Check the amount, then confirm.
- [ ] Result screen shows both legs filled with order ids. Portfolio shows the spread. **Cancel all orders** is available as a kill switch.

## Desktop alternative for section 7's dry run
`DERIVE_SESSION_KEY=… DERIVE_WALLET=… DERIVE_SUBACCOUNT_ID=… npm run check:mainnet` signs a spread and sends it only to `private/order_debug`. The script cannot send `private/order` (enforced by `ReadOnlyRpc` and unit tests).
