// Network and protocol constants for Derive v3.
// Domain separators and the action typehash match derive-py config/contracts.py
// and derive-ts src/signing/eip712.ts; tests/unit/signing.test.ts recomputes them.

export type NetworkId = "testnet" | "mainnet";

export interface Network {
  id: NetworkId;
  name: string;
  wsUrl: string;
  chainId: number;
  domainSeparator: string;
  tradeModule: string;
  /** OnchainActionManager (deposits), per docs.derive.xyz/getting-started/contracts (checked 2026-10-08). */
  actionManager: string;
  /** The ERC-20 USDC the deposit must pull. The live risk-universe answer is checked against it. */
  usdc: string;
  explorer: string;
  appUrl: string;
}

export const ACTION_TYPEHASH = "0x4d7a9f27c403ff9c0f19bce61d76d82f9aa29f8d6d4b0c5474607d9770d1af17";
export const MATCHING_VERIFYING_CONTRACT = "0xeB8d770ec18DB98Db922E9D83260A585b9F0DeAD";
export const TRADE_MODULE = "0xB8D20c2B7a1Ad2EE33Bc50eF10876eD3035b5e7b";
// Module addresses are chain-independent (docs.derive.xyz/authentication/action-signing#modules).
export const WITHDRAW_MODULE = "0x9d0E8f5b25384C7310CB8C6aE32C8fbeb645d083";
export const SET_SESSION_KEY_MODULE = "0xe330CF64ff6EbF41699aad344Cb21d78db1D2bb6";

export const NETWORKS: Record<NetworkId, Network> = {
  testnet: {
    id: "testnet",
    name: "Testnet",
    wsUrl: "wss://testnet.api.derive.xyz/v3/ws",
    chainId: 11155111,
    domainSeparator: "0x24d674cd5f2b9d564691c51e9d88f649b99246a2244dd74ce27b96578d773e85",
    tradeModule: TRADE_MODULE,
    actionManager: "0xd3625eCf97E5554C62A48Ac1c9284C9dCeFceB68",
    usdc: "0x73Efab09362052D26FB93A730Be4F8a5EdC833af", // public mint(address,uint256)
    explorer: "https://sepolia.etherscan.io",
    appUrl: "https://testnet.app.derive.xyz",
  },
  mainnet: {
    id: "mainnet",
    name: "Mainnet",
    wsUrl: "wss://api.derive.xyz/v3/ws",
    chainId: 1,
    domainSeparator: "0xda616dfabb88681b08e1592820a41d55ddc62d68de110e327ae99d734506fe19",
    tradeModule: TRADE_MODULE,
    actionManager: "0xE366CcA474968e33b777E13905829A3b800CFAD3",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Circle USDC on Ethereum
    explorer: "https://etherscan.io",
    appUrl: "https://app.derive.xyz",
  },
};

/** Assets offered in the sentence builder (those with listed options on v3). */
export const ASSETS = ["ETH", "BTC", "SOL", "HYPE", "ADA", "LIT", "CC"] as const;
export type Asset = (typeof ASSETS)[number];

/** Ticker sets older than this are refetched; quotes older than QUOTE_MAX_AGE_MS block Confirm. */
export const TICKER_REFRESH_MS = 10_000;
export const QUOTE_MAX_AGE_MS = 60_000;
/** Expiries closer than this are hidden (too little time for a "by <date>" view). */
export const MIN_EXPIRY_MS = 2 * 86_400_000;
/** Price protection on entry orders: fill-or-kill limits are this much worse than the quoted book. */
export const SLIPPAGE = 0.02;
/** Typed phrase required to confirm a mainnet trade. */
export const MAINNET_PHRASE = "REAL MONEY";

/** One-tap trading: a browser-held session key that can only place option orders. */
export const SESSION_TTL_SEC = 24 * 3600;
export const SESSION_SCOPES = ["trade:orderbook:option"] as const;
export const SESSION_OFFCHAIN_SCOPES = ["account_info"] as const;
export const SESSION_LABEL = "plain-english-options";
/** Derive rejects a session-key expiry closer than 5 minutes (error 14039); revoke = expire at the earliest allowed time. */
export const SESSION_MIN_LIFETIME_SEC = 300;
export const SESSION_REVOKE_LEAD_SEC = 360;
/** Stop signing with a session key this long before it expires (an order signature must verify after it is sent). */
export const SESSION_SAFETY_SEC = 120;
/** Localstorage key of the optional mainnet per-trade cost limit (off when absent). */
export const MAX_COST_STORAGE_KEY = "peo.mainnetMaxCost";
