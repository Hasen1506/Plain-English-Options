# Plain English Options

Say what you think a coin will do, in plain English, and get a defined-risk options spread on [Derive](https://derive.xyz):

> I want to make **$1,000** if **ETH** **hits** **$3,000** by **Nov 27**

The app turns that sentence into a listed debit spread, prices it from the live Derive v3 order book, shows the payoff, and places it with your own wallet.

**Live app:** https://hasen1506.github.io/plain-english-options/

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
- **Mainnet.** Switching to Mainnet shows a "real money" banner, and Confirm stays disabled until you type `REAL MONEY`. Tests never trade mainnet.
- Confirm is disabled whenever there is no live price, the quote is older than 60 s, a leg has no book, the book is too thin, your balance is short, or the subaccount is in the wrong universe.

## Develop

```bash
npm ci
npm run dev            # http://localhost:5173/plain-english-options/
npm run build          # static site in dist/
```

## Tests

```bash
npm run lint && npm run typecheck
npm test               # unit + property (fast-check) + differential, no network
npm run test:e2e       # Playwright against a mock Derive server replaying recorded testnet frames
npm run test:live      # opt-in, real testnet orders, see below
```

- **Property tests** (`tests/unit`): probability bounds and monotonicity, strike bracketing, never using dead instruments, cost ≥ 0, size on step and ≥ minimum, tick-aligned limits, max loss = debit + fees, payoff ≤ width − debit, Confirm never enabled without a live price / with a short balance / in the wrong universe, ticker parsing round-trips and never throws, EIP-712 typed data hashes to the exchange digest, leg-2 failure always leaves you flat or flagged.
- **Differential tests** (`tests/diff`): the old single-file prototype's pricing code is extracted verbatim from `tests/fixtures/old-prototype.html` and compared with the new modules on thousands of random inputs. Intentional differences are asserted and documented in the test file.
- **E2E** (`tests/e2e`): real user flows in Chromium (desktop and mobile) against `tests/mock/server.ts`, which replays frames recorded from testnet (`npm run record`) and verifies every login and order signature. An injected EIP-1193 mock wallet signs with a fixed test key.
- **Live smoke** (`tests/live`, never in CI): logs in on testnet, places a minimum-size ETH call spread on subaccount 87139 (or `DERIVE_SUBACCOUNT_ID`), checks fills and positions, then closes it.

  ```bash
  DERIVE_PRIVATE_KEY=0x… DERIVE_SUBACCOUNT_ID=87139 npm run test:live
  ```

  The last run's order ids and fills are in `docs/live-smoke-testnet.json`.

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
    signer.ts          raw-key and injected-wallet signers
    trader.ts          spread placement with unwind, close, cancel, pre-trade check
  ui/                  DOM controller and HTML views
tests/                 unit, diff, e2e, live, mock server, recorded fixtures
```

## Known limits

- One wallet signature per order (three per spread, so the unwind is ready). A Derive session key would remove the prompts; not built yet.
- RFQ execution is not used: testnet makers do not quote RFQs. `private/rfq_get_best_quote` is used as a no-signature margin and fee check before you confirm.
- The wallet must own the Derive v3 account, or be a session key registered for it on derive.xyz (enter the owner address in the sign-in sheet).
