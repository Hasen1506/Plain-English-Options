// USDC → Hyperliquid perps balance via Circle CCTP v2 (CctpExtension on Arbitrum).
// Follows https://developers.circle.com/cctp/howtos/transfer-usdc-from-arbitrum-to-hypercore :
//   1. fee from Circle's API (flat 0.20 USDC forwarding fee to HyperCore)
//   2. the wallet signs an EIP-3009 ReceiveWithAuthorization for EXACTLY the
//      amount, to = CctpExtension (no ERC-20 approval is ever given)
//   3. the wallet sends batchDepositForBurnWithAuth(auth, burn) to CctpExtension
//      with mintRecipient = destinationCaller = CctpForwarder (else funds are stuck),
//      destinationDomain 19 (HyperEVM), fast finality 1000, and hook data that
//      names the user's own address and the perps dex (0)
// The amount is credited to the same address on Hyperliquid, minus the fee.

import { AbiCoder, Interface, TypedDataEncoder, getAddress, hexlify, randomBytes, Signature, zeroPadValue, toUtf8Bytes } from "ethers";
import { ensureChain, walletRequest, type Eip1193 } from "../../net/signer.ts";
import type { HlNetwork } from "./config.ts";
import { HL_MIN_DEPOSIT } from "./config.ts";
import { toUnits } from "../../net/onchain.ts";

export const CCTP_EXTENSION_ABI = [
  "function batchDepositForBurnWithAuth((uint256 amount,uint256 authValidAfter,uint256 authValidBefore,bytes32 authNonce,uint8 v,bytes32 r,bytes32 s) _receiveWithAuthorizationData,(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold,bytes hookData) _depositForBurnData)",
];
const EXT = new Interface(CCTP_EXTENSION_ABI);
const ERC20 = new Interface(["function balanceOf(address) view returns (uint256)", "function DOMAIN_SEPARATOR() view returns (bytes32)", "function name() view returns (string)", "function version() view returns (string)"]);

export const RECEIVE_WITH_AUTH_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

/** Circle's forwarder hook data: "cctp-forward" magic (24 bytes) ‖ version 0 ‖ length 24 ‖ recipient (20) ‖ dex (u32, 0 = perps). */
export function forwardHookData(recipient: string, dex = 0): string {
  const magic = hexlify(toUtf8Bytes("cctp-forward")).slice(2).padEnd(48, "0");
  const addr = getAddress(recipient).slice(2).toLowerCase();
  const d = (dex >>> 0).toString(16).padStart(8, "0");
  return `0x${magic}00000000${"00000018"}${addr}${d}`;
}

export const bytes32Address = (a: string) => zeroPadValue(getAddress(a), 32);

export interface DepositPlan {
  amount: bigint; // 6 decimals
  maxFee: bigint;
  credited: bigint; // amount − fee
  validAfter: bigint;
  validBefore: bigint;
  nonce: string; // bytes32
  typed: { domain: { name: string; version: string; chainId: number; verifyingContract: string }; types: typeof RECEIVE_WITH_AUTH_TYPES; primaryType: "ReceiveWithAuthorization"; message: Record<string, string> };
}

export function planDeposit(n: HlNetwork, from: string, amountUsd: string, feeUnits: bigint, nowSec: number, nonce = hexlify(randomBytes(32))): DepositPlan {
  const amount = toUnits(amountUsd, 6);
  if (amount < toUnits(String(HL_MIN_DEPOSIT), 6)) throw new Error(`Deposit at least ${HL_MIN_DEPOSIT} USDC`);
  if (feeUnits < 0n || feeUnits >= amount) throw new Error("The deposit does not cover Circle's forwarding fee");
  const validAfter = BigInt(nowSec - 60), validBefore = BigInt(nowSec + 3600);
  return {
    amount,
    maxFee: feeUnits,
    credited: amount - feeUnits,
    validAfter,
    validBefore,
    nonce,
    typed: {
      domain: { name: "USD Coin", version: "2", chainId: n.depositChainId, verifyingContract: getAddress(n.usdc) },
      types: RECEIVE_WITH_AUTH_TYPES,
      primaryType: "ReceiveWithAuthorization",
      message: { from: getAddress(from), to: getAddress(n.cctpExtension), value: amount.toString(), validAfter: validAfter.toString(), validBefore: validBefore.toString(), nonce },
    },
  };
}

export function depositCalldata(n: HlNetwork, p: DepositPlan, sig: string, recipient: string): string {
  const s = Signature.from(sig);
  return EXT.encodeFunctionData("batchDepositForBurnWithAuth", [
    { amount: p.amount, authValidAfter: p.validAfter, authValidBefore: p.validBefore, authNonce: p.nonce, v: s.v, r: s.r, s: s.s },
    { amount: p.amount, destinationDomain: n.hyperEvmDomain, mintRecipient: bytes32Address(n.cctpForwarder), destinationCaller: bytes32Address(n.cctpForwarder), maxFee: p.maxFee, minFinalityThreshold: 1000, hookData: forwardHookData(recipient, 0) },
  ]);
}

export const decodeDeposit = (data: string) => EXT.decodeFunctionData("batchDepositForBurnWithAuth", data);

/** Circle's fee for Arbitrum → HyperCore (fast transfer), in USDC units (6 decimals). */
export async function forwardFee(n: HlNetwork, fetchFn: (u: string) => Promise<{ ok: boolean; json(): Promise<unknown> }> = (u) => globalThis.fetch(u)): Promise<bigint> {
  const r = await fetchFn(n.feeApi);
  if (!r.ok) throw new Error("Circle's fee service did not answer");
  const list = (await r.json()) as { finalityThreshold?: number; minimumFee?: number; forwardFee?: { high?: number } }[];
  const fast = Array.isArray(list) ? list.find((x) => x.finalityThreshold === 1000) : null;
  const fee = fast ? Number(fast.forwardFee?.high ?? 0) + Number(fast.minimumFee ?? 0) : NaN;
  if (!Number.isFinite(fee) || fee < 0 || fee > 5_000_000) throw new Error("Unexpected fee from Circle");
  return BigInt(Math.ceil(fee));
}

async function call(p: Eip1193, to: string, data: string): Promise<string> {
  return String(await walletRequest(p, "eth_call", [{ to, data }, "latest"]));
}

export async function usdcBalance(p: Eip1193, n: HlNetwork, who: string): Promise<bigint> {
  return BigInt(await call(p, n.usdc, ERC20.encodeFunctionData("balanceOf", [who])));
}

/** The token's own EIP-712 domain must equal the one we are about to sign: a wrong chain/token never reaches the wallet prompt. */
export async function checkUsdcDomain(p: Eip1193, n: HlNetwork, plan: DepositPlan): Promise<void> {
  const onChain = String(ERC20.decodeFunctionResult("DOMAIN_SEPARATOR", await call(p, n.usdc, ERC20.encodeFunctionData("DOMAIN_SEPARATOR", [])))[0]).toLowerCase();
  const ours = TypedDataEncoder.hashDomain(plan.typed.domain).toLowerCase();
  if (onChain !== ours) throw new Error("USDC on this network does not match the expected contract; deposit stopped");
}

export interface DepositResult {
  txHash: string;
  credited: string; // USDC, human
}

/** The whole flow, from the wallet: switch to Arbitrum, sign the exact-amount authorization, send the burn. */
export async function depositUsdc(o: { p: Eip1193; n: HlNetwork; user: string; amountUsd: string; nowSec: number; fee?: bigint; onStep?: (s: string) => void; waitMs?: number }): Promise<DepositResult> {
  const step = o.onStep ?? (() => {});
  step(`Switching your wallet to ${o.n.depositChainName}…`);
  await ensureChain(o.p, o.n.depositChainId);
  const fee = o.fee ?? (await forwardFee(o.n));
  const plan = planDeposit(o.n, o.user, o.amountUsd, fee, o.nowSec);
  const bal = await usdcBalance(o.p, o.n, o.user);
  if (bal < plan.amount) throw new Error(`Your wallet has ${(Number(bal) / 1e6).toFixed(2)} USDC on ${o.n.depositChainName}`);
  await checkUsdcDomain(o.p, o.n, plan);
  step(`Sign the ${o.amountUsd} USDC authorization (exact amount, no approval)…`);
  const td = { ...plan.typed, types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], ...plan.typed.types } };
  const sig = String(await walletRequest(o.p, "eth_signTypedData_v4", [getAddress(o.user), JSON.stringify(td)]));
  step("Confirm the deposit transaction in your wallet…");
  const data = depositCalldata(o.n, plan, sig, o.user);
  const tx = String(await walletRequest(o.p, "eth_sendTransaction", [{ from: getAddress(o.user), to: getAddress(o.n.cctpExtension), data, value: "0x0" }]));
  step("Waiting for the transaction…");
  const deadline = Date.now() + (o.waitMs ?? 120_000);
  while (Date.now() < deadline) {
    const r = (await walletRequest(o.p, "eth_getTransactionReceipt", [tx])) as { status?: string } | null;
    if (r && r.status) {
      if (r.status !== "0x1") throw new Error(`Deposit transaction failed (${tx})`);
      return { txHash: tx, credited: (Number(plan.credited) / 1e6).toFixed(2) };
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  return { txHash: tx, credited: (Number(plan.credited) / 1e6).toFixed(2) };
}

export const abi = AbiCoder.defaultAbiCoder();
