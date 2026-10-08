// The perp venue adapter contract. The Perps tab, perp positions in Portfolio
// and perp P&L in History only talk to a PerpVenue, never to an exchange API, so
// another venue (Hyperliquid, a Base-chain venue, Sui/Solana…) plugs in by
// implementing this interface and registering in src/venues/index.ts.
//
// Venue-neutral data shapes come from the pure modules:
//   PerpMarket / PerpTicker / PerpQuote   (src/lib/perp.ts)   markets, live quotes, the order builder
//   Position / OpenOrder                  (src/lib/ticker.ts) account state
//   TradeRow, FundingEvent                (src/lib/history.ts, perpHistory.ts)
// Sizing, rounding, fee, funding and liquidation maths are shared (quotePerp);
// each venue only supplies its markets' rules (tick, step, minimum, fees, margin fractions).

import type { PerpMarket, PerpQuote, PerpTicker } from "../lib/perp.ts";
import type { OpenOrder, Position } from "../lib/ticker.ts";
import type { TradeRow } from "../lib/history.ts";
import type { FundingEvent } from "../lib/perpHistory.ts";
import type { OrderOutcome } from "../net/trader.ts";

export interface VenueCapabilities {
  /** Take-profit / stop-loss trigger orders. */
  triggers: boolean;
  /** Post-only (maker-only) limit orders. */
  postOnly: boolean;
  /** A delegated key that signs orders without a wallet prompt. */
  oneTap: boolean;
  /** Exchange-side signature check without placing an order. */
  dryRun: boolean;
  /** Deposit / withdraw flows inside the app. */
  deposit: boolean;
  withdraw: boolean;
  /** One collateral pool backs every position of an account. */
  crossMargin: boolean;
}

/** An account that can hold perp positions (Derive: a subaccount in a risk universe). */
export interface VenueAccount {
  id: number;
  value: number; // account value, USD
  initialMargin: number; // NET: value − initial requirement (free margin)
  maintenanceMargin: number; // NET: value − maintenance requirement (≤ 0 = liquidatable)
  underLiquidation: boolean;
  positions: Position[];
  openOrders: OpenOrder[];
}

export interface VenueSignerInfo {
  /** Orders are signed without a wallet prompt (one-tap key live for perps). */
  oneTap: boolean;
  /** Trigger orders always need the wallet (they outlive one-tap keys). */
  triggersNeedWallet: boolean;
}

export interface VenueMarginCheck {
  valid: boolean;
  postIM: number | null;
  postMM: number | null;
}

export interface VenueOpenResult {
  entry: OrderOutcome;
  triggers: OrderOutcome[];
  message: string;
}

export interface VenueFlipResult {
  close: OrderOutcome;
  open: OrderOutcome | null;
  message: string;
}

export interface VenueTrigger {
  orderId: string;
  instrument: string;
  direction: "buy" | "sell";
  amount: number;
  triggerType: string;
  triggerPrice: number;
  limitPrice: number;
  status: string;
}

export interface PerpVenue {
  readonly id: string; // "derive"
  readonly name: string; // "Derive"
  readonly caps: VenueCapabilities;
  /** Worst-price protection for market orders, as a fraction through the touch. */
  readonly slippage: number;
  /**
   * How far this adapter has been proven, shown next to its name. Absent = proven
   * end to end with real testnet orders. `usable: false` = listed as "coming soon"
   * and cannot be picked (no data, no trading).
   */
  readonly status?: { tag: string; detail: string; usable: boolean };

  // ---- network / connection ----
  networkName(): string; // "Testnet" | "Mainnet"
  isMainnet(): boolean;
  isLive(): boolean; // market data connection open

  // ---- markets ----
  markets(): Promise<PerpMarket[]>;
  tickers(): Promise<Record<string, PerpTicker>>;

  // ---- accounts ----
  connected(): boolean;
  /** Accounts allowed to trade this market (Derive: subaccounts in the market's risk universe). */
  accountsFor(market: string): VenueAccount[];
  /** Human words for where this market trades ("risk universe 1 (PRIME)"); null while unknown. */
  accountScope(market: string): string | null;
  /** The account orders for this market go to (selecting one if the current one cannot trade it). */
  selectedAccount(market: string): VenueAccount | null;
  selectAccount(id: number): void;
  /** Start the venue's onboarding/deposit flow for an account that can trade this market. */
  newAccount(market: string): void;
  /** Add collateral to an existing account (venue's own flow; only when caps.deposit). */
  deposit(acct: VenueAccount): void;
  /** Take collateral out of an account (venue's own flow; only when caps.withdraw). */
  withdraw(acct: VenueAccount): void;
  refreshAccounts(): Promise<void>;
  signer(): VenueSignerInfo | null;

  // ---- trading ----
  marginCheck(acct: VenueAccount, q: PerpQuote): Promise<VenueMarginCheck>;
  open(acct: VenueAccount, q: PerpQuote, onStep?: (s: string) => void): Promise<VenueOpenResult>;
  /** Zero-risk signature check (never places an order). */
  checkOrder(acct: VenueAccount, q: PerpQuote): Promise<{ ok: boolean; message: string }>;
  close(acct: VenueAccount, market: string, position: number, fraction: number, label?: string): Promise<OrderOutcome>;
  flip(acct: VenueAccount, market: string, position: number): Promise<VenueFlipResult>;
  triggers(acct: VenueAccount): Promise<VenueTrigger[]>;
  cancelTrigger(acct: VenueAccount, orderId: string): Promise<void>;
  /** Cancel resting orders AND triggers (and algos) of the account. */
  cancelAll(acct: VenueAccount): Promise<void>;

  // ---- history ----
  history(acct: VenueAccount): Promise<{ trades: TradeRow[]; funding: FundingEvent[] }>;
  isPerp(instrument: string): boolean;

  // ---- optional: venues with their own wallet connection (Hyperliquid, Veranta) ----
  /** Connect the injected wallet to this venue (Derive uses the app's own sign-in instead). */
  connect?(): Promise<void>;
  /** Revoke/expire the one-tap key and forget the wallet. */
  disconnect?(): Promise<void>;
  /** The market on screen (venues that fetch a book per market). */
  focus?(market: string): void;
  /** Margin modes for new positions; absent = cross only. */
  readonly marginModes?: readonly MarginMode[];
  marginMode?(): MarginMode;
  setMarginMode?(m: MarginMode): void;
  /** Words for the risk checkbox (what backs the trade, who liquidates). */
  riskWords?(): string;
  /** Where the collateral lives, in plain words ("USDC deposited on Hyperliquid (from Arbitrum)"). */
  collateralWords?(): string;
  /** Leverage the venue will actually use for a requested one (Hyperliquid: whole numbers). */
  effectiveLeverage?(market: string, lev: number): number;
  /** Orders that are open (resting limits) for the account, when the venue tracks them separately. */
  openOrders?(acct: VenueAccount): Promise<{ orderId: string; instrument: string; direction: "buy" | "sell"; amount: number; limitPrice: number }[]>;
  cancelOrder?(acct: VenueAccount, orderId: string, instrument: string): Promise<void>;
}

export type MarginMode = "cross" | "isolated";
