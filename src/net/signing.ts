// EIP-712 signing of Derive v3 trade actions, ported from derive-py
// (_web3/action_signing) and derive-ts (src/signing). The same digest can be
// signed two ways: with a raw key (tests, live smoke) or by an injected wallet
// through eth_signTypedData_v4, whose typed data hashes to the identical digest.

import { AbiCoder, concat, getAddress, keccak256, SigningKey, TypedDataEncoder, zeroPadValue, toBeHex } from "ethers";
import { ACTION_TYPEHASH, MATCHING_VERIFYING_CONTRACT, type Network } from "../config.ts";
import { toE18 } from "../lib/units.ts";

export interface TradeData {
  assetAddress: string;
  subId: string;
  limitPrice: string; // decimal
  amount: string; // decimal
  maxFee: string; // decimal, per unit
  recipientId: number;
  isBid: boolean;
}

export interface ActionFields {
  subaccountId: number;
  nonce: string; // decimal string (ns timestamp)
  module: string;
  data: string; // 0x ABI-encoded module data
  expiry: number; // unix seconds
  owner: string;
  signer: string;
}

const coder = AbiCoder.defaultAbiCoder();
const E12 = 10n ** 6n; // protocol runs at 1e12 precision: e18 words must be multiples of 1e6

function word(v: bigint, signed: boolean): string {
  if (!signed && v < 0n) throw new Error("negative value in unsigned field");
  if (v % E12 !== 0n) throw new Error("more than 12 decimals");
  return zeroPadValue(toBeHex(BigInt.asUintN(256, v)), 32);
}

export function encodeTradeData(d: TradeData): string {
  return concat([
    zeroPadValue(getAddress(d.assetAddress), 32),
    zeroPadValue(toBeHex(BigInt(d.subId)), 32),
    word(toE18(d.limitPrice), true),
    word(toE18(d.amount), true),
    word(toE18(d.maxFee), false),
    zeroPadValue(toBeHex(BigInt(d.recipientId)), 32),
    zeroPadValue(d.isBid ? "0x01" : "0x00", 32),
  ]);
}

/** Same bytes as encodeTradeData, via the generic ABI encoder (used as a cross-check in tests). */
export function encodeTradeDataAbi(d: TradeData): string {
  return coder.encode(
    ["address", "uint256", "int256", "int256", "uint256", "uint256", "bool"],
    [getAddress(d.assetAddress), BigInt(d.subId), toE18(d.limitPrice), toE18(d.amount), toE18(d.maxFee), BigInt(d.recipientId), d.isBid],
  );
}

export function actionHash(a: ActionFields): string {
  return keccak256(
    coder.encode(
      ["bytes32", "uint256", "uint256", "address", "bytes32", "uint256", "address", "address"],
      [ACTION_TYPEHASH, BigInt(a.subaccountId), BigInt(a.nonce), getAddress(a.module), keccak256(a.data), BigInt(a.expiry), getAddress(a.owner), getAddress(a.signer)],
    ),
  );
}

export function digest(a: ActionFields, net: Pick<Network, "domainSeparator">): string {
  return keccak256(concat(["0x1901", net.domainSeparator, actionHash(a)]));
}

export function domainSeparatorFor(chainId: number): string {
  return TypedDataEncoder.hashDomain(eip712Domain(chainId));
}

export const eip712Domain = (chainId: number) => ({ name: "Matching", version: "1.0", chainId, verifyingContract: MATCHING_VERIFYING_CONTRACT });

export const ACTION_TYPES = {
  Action: [
    { name: "subaccountId", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "module", type: "address" },
    { name: "data", type: "bytes" },
    { name: "expiry", type: "uint256" },
    { name: "owner", type: "address" },
    { name: "signer", type: "address" },
  ],
};

/** JSON for eth_signTypedData_v4. Hashes to exactly `digest(a, net)`. */
export function typedDataFor(a: ActionFields, net: Pick<Network, "chainId">) {
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ...ACTION_TYPES,
    },
    primaryType: "Action" as const,
    domain: eip712Domain(net.chainId),
    message: {
      subaccountId: String(a.subaccountId),
      nonce: a.nonce,
      module: getAddress(a.module),
      data: a.data,
      expiry: String(a.expiry),
      owner: getAddress(a.owner),
      signer: getAddress(a.signer),
    },
  };
}

export function signDigestWithKey(privateKey: string, d: string): string {
  return new SigningKey(privateKey).sign(d).serialized;
}

/** Nanosecond nonce, random in the sub-ms digits (orders do not need strictly increasing nonces). */
export function makeNonce(now = Date.now()): string {
  return (BigInt(now) * 1_000_000n + BigInt(Math.floor(Math.random() * 1e6))).toString();
}
