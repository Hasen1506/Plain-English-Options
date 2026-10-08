// Hyperliquid endpoints and the USDC deposit route, per network.
//
// Deposit route: Circle CCTP v2 via CctpExtension on Arbitrum (the Hyperliquid
// docs' USDC page: "CCTP is the preferred method … the legacy bridge is
// deprecated"). One EIP-3009 ReceiveWithAuthorization signature for the exact
// amount (no token approval at all) + one batchDepositForBurnWithAuth
// transaction; Circle mints on HyperEVM and the CctpForwarder credits the
// HyperCore perps balance. Flat 0.20 USDC forwarding fee (Circle fee API).
//
// Addresses, verified 2026-10-08 against:
//   https://developers.circle.com/cctp/references/hypercore-contract-addresses
//   https://developers.circle.com/cctp/howtos/transfer-usdc-from-arbitrum-to-hypercore
//   https://developers.circle.com/stablecoins/usdc-contract-addresses (Arbitrum USDC)
//   https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/usdc
// The app re-checks the USDC EIP-712 domain on chain (DOMAIN_SEPARATOR) before
// asking for a signature, and refuses to continue on a mismatch.

import type { NetworkId } from "../../config.ts";

export interface HlNetwork {
  id: NetworkId;
  name: string;
  api: string; // https base; /info and /exchange
  ws: string;
  appUrl: string;
  /** Arbitrum chain the deposit runs on. */
  depositChainId: number;
  depositChainName: string;
  usdc: string; // native USDC on that chain
  cctpExtension: string; // CctpExtension (Arbitrum)
  cctpForwarder: string; // CctpForwarder (HyperEVM), mintRecipient AND destinationCaller
  hyperEvmDomain: number; // CCTP domain of HyperEVM
  feeApi: string; // Circle fee API (CORS open)
  explorer: string;
}

export const HL_NETWORKS: Record<NetworkId, HlNetwork> = {
  mainnet: {
    id: "mainnet",
    name: "Mainnet",
    api: "https://api.hyperliquid.xyz",
    ws: "wss://api.hyperliquid.xyz/ws",
    appUrl: "https://app.hyperliquid.xyz",
    depositChainId: 42161,
    depositChainName: "Arbitrum One",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    cctpExtension: "0xA95d9c1F655341597C94393fDdc30cf3c08E4fcE",
    cctpForwarder: "0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757",
    hyperEvmDomain: 19,
    feeApi: "https://iris-api.circle.com/v2/burn/USDC/fees/3/19?forward=true&hyperCoreDeposit=true",
    explorer: "https://arbiscan.io",
  },
  testnet: {
    id: "testnet",
    name: "Testnet",
    api: "https://api.hyperliquid-testnet.xyz",
    ws: "wss://api.hyperliquid-testnet.xyz/ws",
    appUrl: "https://app.hyperliquid-testnet.xyz",
    depositChainId: 421614,
    depositChainName: "Arbitrum Sepolia",
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    cctpExtension: "0x8E4e3d0E95C1bEC4F3eC7F69aa48473E0Ab6eB8D",
    cctpForwarder: "0x02e39ECb8368b41bF68FF99ff351aC9864e5E2a2",
    hyperEvmDomain: 19,
    feeApi: "https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/3/19?forward=true&hyperCoreDeposit=true",
    explorer: "https://sepolia.arbiscan.io",
  },
};

/** Legacy Bridge2 (deprecated by the docs, kept for reference/tests only — the app does not send to it). */
export const HL_LEGACY_BRIDGE = { mainnet: "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7", testnet: "0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89" } as const;

/** Smallest deposit the app allows: the docs' 5 USDC minimum (smaller legacy deposits are lost) — and it must cover the 0.20 fee. */
export const HL_MIN_DEPOSIT = 5;
/** Withdrawals (withdraw3) cost a flat $1 on Hyperliquid. */
export const HL_WITHDRAW_FEE = 1;
/** One-tap agent lifetime: the agent expires on its own (valid_until) even if the tab never revokes it. */
export const HL_AGENT_TTL_MS = 24 * 3600_000;
/** Named agent slot the app uses; approving a new key under this name deregisters the previous one. */
export const HL_AGENT_NAME = "peo";
/** Market (IOC) orders fill at most this far through the touch. */
export const HL_SLIPPAGE = 0.005;
/** TP/SL trigger orders execute as market orders bounded this far past the trigger. */
export const HL_TRIGGER_SLIPPAGE = 0.03;
