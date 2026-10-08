# Plain English Options

Say what you think a coin will do, in plain English, and get a defined-risk options spread on [Derive](https://derive.xyz):

> I want to make **$1,000** if **ETH** **hits** **$3,000** by **Nov 27**

The app turns that sentence into a listed debit spread, prices it from the live Derive v3 order book, shows the payoff, and places it with your own wallet.

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

## Trading safety

- **Your wallet signs everything.** Login is an EIP-191 signature; every order is an EIP-712 `Action` signed with `eth_signTypedData_v4`. The digest is byte-identical to what Derive verifies (checked against `private/order_debug` and covered by tests).
- **Leg risk.** Testnet RFQs get no maker quotes, so a spread is two fill-or-kill limit orders. The long leg, the short leg *and* an unwind of the long leg are all signed before anything is sent. If the short leg fails, the pre-signed unwind goes out immediately.
- **Price protection.** Entry limits are capped at 2% worse than the quoted book; fills happen at the best available price. Confirm checks your balance against that worst case.
- **Risk universes.** Derive v3 subaccounts belong to one risk universe (RU1 BTC/ETH, RU2 HYPE, RU3 alts). The app only lets you trade from a subaccount in the asset's universe, and tells you how to create one if you have none.
- **Mainnet.** Switching to Mainnet shows a "real money" banner and a red REAL MONEY chip on the balance; Confirm, deposits and withdrawals stay disabled until you type `REAL MONEY`. Tests never trade or deposit on mainnet.
- **One-tap trading (session key).** After sign-in the app offers to create a session key in the tab's memory, registered with one wallet signature (`private/set_session_key`, scope `trade:orderbook:option`, the chosen subaccounts, 24 h). Orders are then signed by the key, so a spread is one tap. It cannot withdraw, transfer or create keys. Disconnect revokes it (re-registers it with the earliest expiry Derive allows, now + 6 min); closing the tab forgets it.
- **Check order (no trade).** Signs both legs and sends them only to `private/order_debug`, which returns the hash Derive would verify. The app compares it with its own digest and recovers the signer. `ReadOnlyRpc` refuses `private/order` and every other state-changing method.
- **Kill switch.** *Cancel all orders* (`private/cancel_all`) in Portfolio and in the subaccount sheet.
- **Optional per-trade limit.** Portfolio → Safety: a USD limit on the worst-case cost of one mainnet trade. Off by default.
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
npm run check:mainnet  # read-only mainnet signature check (order_debug only), needs env
npm run record:mainnet # re-record the read-only mainnet fixtures
```

- **Property tests** (`tests/unit`): probability bounds and monotonicity, strike bracketing, never using dead instruments, cost ≥ 0, size on step and ≥ minimum, tick-aligned limits, max loss = debit + fees, payoff ≤ width − debit, Confirm never enabled without a live price / with a short balance / in the wrong universe, ticker parsing round-trips and never throws, EIP-712 typed data hashes to the exchange digest, leg-2 failure always leaves you flat or flagged.
- **Differential tests** (`tests/diff`): the old single-file prototype's pricing code is extracted verbatim from `tests/fixtures/old-prototype.html` and compared with the new modules on thousands of random inputs. Intentional differences are asserted and documented in the test file.
- **E2E** (`tests/e2e`): real user flows in Chromium (desktop and mobile) against `tests/mock/server.ts`, which replays frames recorded from testnet (`npm run record`) and verifies every login and order signature. An injected EIP-1193 mock wallet signs with a fixed test key.
- **Live smoke** (`tests/live`, never in CI): logs in on testnet, places a minimum-size ETH call spread on subaccount 87139 (or `DERIVE_SUBACCOUNT_ID`), checks fills and positions, then closes it.

  ```bash
  DERIVE_PRIVATE_KEY=0x… DERIVE_SUBACCOUNT_ID=87139 npm run test:live
  ```

  The last run's order ids and fills are in `docs/live-smoke-testnet.json`.
- **Live onboarding** (`tests/live/onboarding.test.ts`, never in CI): from a fresh testnet wallet, "Account not found" → approve + `depositToNewSubaccount` into risk universe 1 → credited, deposit into the existing subaccount, withdraw, register a session key, `order_debug` both legs, open and close a spread signed only by the session key, `cancel_all`, history P&L, revoke. Results: `docs/live-onboarding-testnet.json`.

  ```bash
  DERIVE_PRIVATE_KEY=0x… npm run test:live -- tests/live/onboarding.test.ts
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
    account.ts         "no Derive account yet" detection
  lib/history.ts       order/trade history and realised P&L per closed spread
  ui/                  DOM controller and HTML views
tests/                 unit, diff, e2e, live, mock server, recorded fixtures
```

## Fund mainnet

See "Funding mainnet" in `docs/qa-mainnet.md` sections 5–7. In short: hold USDC (Circle, `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`) and a little ETH for gas in your wallet on Ethereum mainnet, switch the app to Mainnet, sign in, and use the deposit sheet. ETH and BTC options need a subaccount in risk universe 1 (PRIME, standard-margin manager 1). The minimum deposit is $5; the app's ETH spreads start at 0.1 contracts.

## Known limits

- Without one-tap trading, a spread is three wallet signatures (so the unwind is ready).
- History counts trades only: a spread held to expiry settles in cash and is not a trade, so it stays out of the realised P&L table.
- WalletConnect is not built (needs a project id); use an injected wallet such as the MetaMask in-app browser.
- RFQ execution is not used: testnet makers do not quote RFQs. `private/rfq_get_best_quote` is used as a no-signature margin and fee check before you confirm.
- The wallet must own the Derive v3 account, or be a session key registered for it on derive.xyz (enter the owner address in the sign-in sheet).
