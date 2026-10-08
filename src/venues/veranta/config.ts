// Veranta (formerly Avantis) v2 perpetuals on Base, through the official
// veranta-sdk (https://www.npmjs.com/package/veranta-sdk, 0.3.1).
//
// Network facts checked on 2026-10-08:
//   - tx-builder https://tx-builder(-testnet).veranta.xyz, gateway
//     https://prod-api / staging-api.veranta.xyz, history https://api / testnet-api.veranta.xyz,
//     feed https://feed-v3(-testnet).veranta.xyz: every endpoint the SDK calls answers
//     CORS preflights with Access-Control-Allow-Origin: * (the SDK sends no User-Agent
//     from a browser, so its requests fit the allowed headers).
//   - The testnet is a private fork of Base with the SAME chain id (8453) and the same
//     contracts. A browser wallet cannot point at it safely (its "Base" is the real
//     Base), and an EIP-712 signature made for the fork is also valid on mainnet. So the
//     app never asks the user's wallet to sign for Veranta testnet: it uses a practice
//     account created in the tab.
//   - Minimum position (collateral × leverage) and fees come from the live pair catalogue
//     (`markets.pairs()`: minLevPosUSDC, additionalPairParams2.open/closeTaker/MakerFeeP),
//     e.g. ETH/USD: $100 minimum position, 0.045% taker / 0.01% maker, 1–50×.

import type { NetworkId } from "../../config.ts";

export interface VerantaNetwork {
  id: NetworkId;
  name: string;
  /** veranta-sdk network profile */
  sdk: "testnet" | "mainnet";
  explorer: string;
}

export const VERANTA_NETWORKS: Record<NetworkId, VerantaNetwork> = {
  testnet: { id: "testnet", name: "Testnet", sdk: "testnet", explorer: "https://devnet-explorer.veranta.xyz" },
  mainnet: { id: "mainnet", name: "Mainnet", sdk: "mainnet", explorer: "https://basescan.org" },
};

/** One-tap (session) key lifetime: 30 days, Veranta's own default. */
export const VERANTA_SESSION_TTL_S = 30 * 86_400;
/** Worst price for market orders, as a fraction (the SDK's default slippagePercent is 1). */
export const VERANTA_SLIPPAGE = 0.01;
/** A position is liquidated when its loss reaches 85% of its collateral (veranta-sdk compute.LIQ_THRESHOLD_P). */
export const VERANTA_LIQ_THRESHOLD = 0.85;
/** Practice-account funding on the testnet fork. */
export const VERANTA_PRACTICE_USDC = 1000;

/**
 * Base USDC holders on the testnet fork the faucet can draw from when the SDK's own
 * faucet whale runs dry (seen 2026-10-08: 0x6c56…4372 held 0.42 USDC). Uses the fork's
 * dev_impersonateTransaction, exactly like the SDK's fundTestnetWallet; fork only.
 */
export const VERANTA_FORK_USDC_HOLDERS = ["0xcdac0d6c6c59727a65f871236188350531885c43", "0x20FE51A9229EEf2cF8Ad9E89d91CAb9312cF3b7A"];

export interface VenueStatus {
  tag: string;
  detail: string;
  usable: boolean;
}

/** What the app can honestly claim for Veranta on each network (shown in the picker and table). */
export const VERANTA_STATUS: Record<NetworkId, VenueStatus> = {
  testnet: {
    tag: "testnet practice account",
    detail:
      "Veranta's testnet is a copy of Base with the same chain id, so your wallet is never asked to sign there. The app creates a practice account in this tab, funds it with test USDC from Veranta's testnet faucet and trades it through Veranta's own SDK. This in-browser flow passed a live test on Veranta testnet on 2026-10-08 (open, close, flip, limit and cancel, ended flat with allowance 0).",
    usable: true,
  },
  mainnet: {
    tag: "coming soon",
    detail: "Trading on Base mainnet with your own wallet is not built or tested yet.",
    usable: false,
  },
};
