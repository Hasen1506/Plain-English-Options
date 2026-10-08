// Deposits (L1, through the user's own wallet) and withdrawals (a signed
// Derive action). Mirrors derive-py _web3/deposits.py:
//   new subaccount:      approve(ACTION_MANAGER, amount) → depositToNewSubaccount(asset, amount, managerId, owner)
//   existing subaccount: approve(ACTION_MANAGER, amount) → deposit(asset, amount, subaccountId, fallbackRecipient)
// `asset` is the protocol spot asset (collaterals[].address), NOT the ERC-20;
// amounts are in the ERC-20's native decimals (USDC = 6). Every chain call goes
// through the injected EIP-1193 provider, so the app needs no RPC of its own.

import { getAddress, Interface } from "ethers";
import { WITHDRAW_MODULE, type Network } from "../config.ts";
import { ensureChain, type ActionSigner, type Eip1193 } from "./signer.ts";
import { increasingNonce, type ActionFields } from "./signing.ts";
import type { Rpc } from "./trader.ts";
import { toE18 } from "../lib/units.ts";

// ---------- risk universes ----------
export interface ManagerCollateral {
  name: string;
  assetAddress: string; // protocol spot asset
  erc20: string | null; // underlying ERC-20 the wallet approves and sends
  decimals: number;
  minDepositUsd: number;
}
export interface Manager {
  managerId: number;
  marginType: string; // SM | PM2
  instruments: string[]; // e.g. ETH-OPTION
  collaterals: ManagerCollateral[];
}
export interface RiskUniverse {
  id: number;
  name: string;
  managers: Manager[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ADDR = /^0x[0-9a-fA-F]{40}$/;

export function parseRiskUniverses(raw: unknown): RiskUniverse[] {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.risk_universes) ? raw.risk_universes : [];
  const out: RiskUniverse[] = [];
  for (const u of list) {
    if (!isObj(u) || !Number.isInteger(Number(u.risk_universe_id)) || !Array.isArray(u.managers)) continue;
    const managers: Manager[] = [];
    for (const m of u.managers) {
      if (!isObj(m) || !Number.isInteger(Number(m.manager_id))) continue;
      const collaterals: ManagerCollateral[] = [];
      for (const c of Array.isArray(m.collaterals) ? m.collaterals : []) {
        if (!isObj(c) || typeof c.name !== "string" || typeof c.address !== "string" || !ADDR.test(c.address)) continue;
        const e = isObj(c.erc20) ? c.erc20 : {};
        const dec = Number(e.decimals);
        if (!Number.isInteger(dec) || dec < 0 || dec > 36) continue;
        collaterals.push({
          name: c.name,
          assetAddress: getAddress(c.address),
          erc20: typeof e.underlying_erc20 === "string" && ADDR.test(e.underlying_erc20) ? getAddress(e.underlying_erc20) : null,
          decimals: dec,
          minDepositUsd: Number.isFinite(Number(c.min_deposit_usd)) ? Number(c.min_deposit_usd) : 0,
        });
      }
      managers.push({
        managerId: Number(m.manager_id),
        marginType: String(m.margin_type ?? ""),
        instruments: Array.isArray(m.instruments) ? m.instruments.map(String) : [],
        collaterals,
      });
    }
    out.push({ id: Number(u.risk_universe_id), name: typeof u.name === "string" ? u.name : `RU${u.risk_universe_id}`, managers });
  }
  return out;
}

/** The risk universe whose managers list `${asset}-OPTION` (fetched per network, never assumed). */
export function riskUniverseForOptions(universes: RiskUniverse[], asset: string): number | null {
  const want = `${asset}-OPTION`;
  const u = universes.find((x) => x.managers.some((m) => m.instruments.includes(want)));
  return u ? u.id : null;
}

export interface DepositRoute {
  riskUniverseId: number;
  managerId: number;
  marginType: string;
  collateral: ManagerCollateral & { erc20: string };
}

/** (universe, SM margin, USDC) → manager and collateral, refusing an ERC-20 other than the network's USDC. */
export function depositRoute(universes: RiskUniverse[], net: Pick<Network, "usdc">, riskUniverseId: number, marginType = "SM", asset = "USDC"): DepositRoute {
  const u = universes.find((x) => x.id === riskUniverseId);
  if (!u) throw new Error(`No risk universe ${riskUniverseId}`);
  const m = u.managers.find((x) => x.marginType === marginType);
  if (!m) throw new Error(`Risk universe ${riskUniverseId} has no ${marginType} manager`);
  return { riskUniverseId, managerId: m.managerId, marginType, collateral: collateralFor(universes, net, m.managerId, asset) };
}

export function collateralFor(universes: RiskUniverse[], net: Pick<Network, "usdc">, managerId: number, asset = "USDC"): ManagerCollateral & { erc20: string } {
  const m = universes.flatMap((u) => u.managers).find((x) => x.managerId === managerId);
  if (!m) throw new Error(`No manager ${managerId}`);
  const c = m.collaterals.find((x) => x.name === asset);
  if (!c || !c.erc20) throw new Error(`Manager ${managerId} does not take ${asset} deposits`);
  if (asset === "USDC" && getAddress(c.erc20) !== getAddress(net.usdc)) throw new Error(`Unexpected USDC token ${c.erc20}; refusing to deposit`);
  return { ...c, erc20: c.erc20 };
}

export function managerRU(universes: RiskUniverse[], managerId: number): number | null {
  return universes.find((u) => u.managers.some((m) => m.managerId === managerId))?.id ?? null;
}

// ---------- amounts ----------
/** Exact decimal → integer token units. Rejects more decimals than the token has, negatives and junk. */
export function toUnits(amount: string, decimals: number): bigint {
  const s = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Enter an amount like 25 or 25.50");
  const [w, f = ""] = s.split(".");
  if (f.length > decimals) throw new Error(`At most ${decimals} decimals`);
  return BigInt(w!) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function fromUnits(v: bigint, decimals: number): string {
  const neg = v < 0n, a = neg ? -v : v, base = 10n ** BigInt(decimals);
  const frac = decimals ? (a % base).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  return (neg ? "-" : "") + (a / base).toString() + (frac ? "." + frac : "");
}

export interface AmountCheck {
  ok: boolean;
  units: bigint;
  reason: string | null;
}

export function checkDepositAmount(amount: string, c: Pick<ManagerCollateral, "decimals" | "minDepositUsd">, walletUnits: bigint | null): AmountCheck {
  let units: bigint;
  try {
    units = toUnits(amount, c.decimals);
  } catch (e) {
    return { ok: false, units: 0n, reason: (e as Error).message };
  }
  if (units <= 0n) return { ok: false, units, reason: "Enter an amount above zero" };
  if (units < toUnits(String(c.minDepositUsd), c.decimals)) return { ok: false, units, reason: `Minimum deposit is $${c.minDepositUsd} (smaller deposits are not credited)` };
  if (walletUnits !== null && units > walletUnits) return { ok: false, units, reason: `Your wallet has only ${fromUnits(walletUnits, c.decimals)} USDC` };
  return { ok: true, units, reason: null };
}

// ---------- calldata ----------
const ERC20 = new Interface(["function approve(address spender, uint256 amount) returns (bool)", "function allowance(address owner, address spender) view returns (uint256)", "function balanceOf(address owner) view returns (uint256)"]);
const ACTION_MANAGER = new Interface([
  "function deposit(address asset, uint256 amount, uint64 subaccountId, address fallbackRecipient) returns (uint256)",
  "function depositToNewSubaccount(address asset, uint256 amount, uint32 managerId, address owner) returns (uint256)",
]);

export const calldata = {
  approve: (spender: string, units: bigint) => ERC20.encodeFunctionData("approve", [getAddress(spender), units]),
  allowance: (owner: string, spender: string) => ERC20.encodeFunctionData("allowance", [getAddress(owner), getAddress(spender)]),
  balanceOf: (owner: string) => ERC20.encodeFunctionData("balanceOf", [getAddress(owner)]),
  deposit: (asset: string, units: bigint, subaccountId: number, fallback: string) => ACTION_MANAGER.encodeFunctionData("deposit", [getAddress(asset), units, BigInt(subaccountId), getAddress(fallback)]),
  depositNew: (asset: string, units: bigint, managerId: number, owner: string) => ACTION_MANAGER.encodeFunctionData("depositToNewSubaccount", [getAddress(asset), units, managerId, getAddress(owner)]),
  decode: (data: string) => {
    for (const i of [ERC20, ACTION_MANAGER]) {
      try {
        const d = i.parseTransaction({ data });
        if (d) return { name: d.name, args: d.args.toArray() as unknown[] };
      } catch {
        /* try the next ABI */
      }
    }
    return null;
  },
};

// ---------- planning ----------
export type DepositTarget = { kind: "new"; managerId: number; owner: string } | { kind: "existing"; subaccountId: number; fallback: string };

export interface TxStep {
  kind: "approve" | "deposit";
  to: string;
  data: string;
  label: string;
}

export interface DepositPlan {
  from: string;
  units: bigint;
  walletUnits: bigint;
  allowance: bigint;
  steps: TxStep[];
  route: { managerId: number; collateral: ManagerCollateral & { erc20: string } };
}

const hexBig = (v: unknown): bigint => (typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v) ? BigInt(v === "0x" ? 0 : v) : 0n);

export async function readToken(p: Eip1193, token: string, data: string): Promise<bigint> {
  return hexBig(await p.request({ method: "eth_call", params: [{ to: getAddress(token), data }, "latest"] }));
}

export async function planDeposit(p: Eip1193, net: Network, from: string, c: ManagerCollateral & { erc20: string }, managerId: number, amount: string, target: DepositTarget): Promise<DepositPlan> {
  const walletUnits = await readToken(p, c.erc20, calldata.balanceOf(from));
  const chk = checkDepositAmount(amount, c, walletUnits);
  if (!chk.ok) throw new Error(chk.reason!);
  const allowance = await readToken(p, c.erc20, calldata.allowance(from, net.actionManager));
  const steps: TxStep[] = [];
  const human = fromUnits(chk.units, c.decimals);
  if (allowance < chk.units) steps.push({ kind: "approve", to: c.erc20, data: calldata.approve(net.actionManager, chk.units), label: `Approve ${human} USDC for Derive` });
  steps.push(
    target.kind === "new"
      ? { kind: "deposit", to: net.actionManager, data: calldata.depositNew(c.assetAddress, chk.units, target.managerId, target.owner), label: `Deposit ${human} USDC into a new subaccount` }
      : { kind: "deposit", to: net.actionManager, data: calldata.deposit(c.assetAddress, chk.units, target.subaccountId, target.fallback), label: `Deposit ${human} USDC into subaccount #${target.subaccountId}` },
  );
  return { from: getAddress(from), units: chk.units, walletUnits, allowance, steps, route: { managerId, collateral: c } };
}

export interface GasEstimate {
  perStep: bigint[];
  gasPriceWei: bigint;
  totalWei: bigint;
  approximate: boolean; // a step could not be simulated yet (deposit before approve is mined)
}

/** Gas limit fallbacks when a step cannot be simulated (e.g. deposit before its approve is mined). */
export const GAS_FALLBACK: Record<TxStep["kind"], bigint> = { approve: 70_000n, deposit: 250_000n };

export async function estimateDepositGas(p: Eip1193, plan: DepositPlan): Promise<GasEstimate> {
  let approximate = false;
  const perStep: bigint[] = [];
  for (const s of plan.steps) {
    try {
      perStep.push(hexBig(await p.request({ method: "eth_estimateGas", params: [{ from: plan.from, to: s.to, data: s.data, value: "0x0" }] })));
    } catch {
      approximate = true;
      perStep.push(GAS_FALLBACK[s.kind]);
    }
  }
  const gasPriceWei = hexBig(await p.request({ method: "eth_gasPrice", params: [] }));
  return { perStep, gasPriceWei, totalWei: perStep.reduce((a, b) => a + b, 0n) * gasPriceWei, approximate };
}

export async function sendStep(p: Eip1193, net: Network, from: string, s: TxStep): Promise<string> {
  await ensureChain(p, net.chainId);
  const h = await p.request({ method: "eth_sendTransaction", params: [{ from: getAddress(from), to: getAddress(s.to), data: s.data, value: "0x0" }] });
  if (typeof h !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(h)) throw new Error("The wallet did not return a transaction hash");
  return h;
}

export async function waitReceipt(p: Eip1193, hash: string, opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ status: "success"; blockNumber: number }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
  for (;;) {
    const r = (await p.request({ method: "eth_getTransactionReceipt", params: [hash] })) as { status?: string; blockNumber?: string } | null;
    if (r && r.status !== undefined) {
      if (hexBig(r.status) !== 1n) throw new Error(`Transaction ${hash} failed on-chain`);
      return { status: "success", blockNumber: Number(hexBig(r.blockNumber)) };
    }
    if (Date.now() > deadline) throw new Error(`Still waiting for ${hash}; check it on the explorer`);
    await sleep(opts.pollMs ?? 3000);
  }
}

/** Poll until a subaccount id that was not there before appears (crediting takes ~2 minutes after mining). */
export async function waitForNewSubaccount(rpc: Rpc, wallet: string, before: number[], opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<number[]> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.timeoutMs ?? 900_000);
  for (;;) {
    const r = await rpc.call<{ subaccount_ids?: number[] }>("private/get_subaccounts", { wallet });
    const fresh = (r?.subaccount_ids ?? []).filter((id) => !before.includes(id));
    if (fresh.length) return fresh;
    if (Date.now() > deadline) throw new Error("Deposit mined but not credited yet. It can take a few minutes; reconnect later.");
    await sleep(opts.pollMs ?? 10_000);
  }
}

// ---------- withdraw (signed action, owner wallet only) ----------
export interface WithdrawRequest {
  subaccountId: number;
  collateral: ManagerCollateral;
  amount: string; // human units
  recipient: string; // L1 address paid out (the owner wallet)
  maxFeeUsd: string;
}

export function encodeWithdrawData(asset: string, maxFeeUsd: string, recipient: string, units: bigint, forceBatch = false): string {
  if (units <= 0n) throw new Error("withdrawal amount must be above zero");
  return new Interface([]).getAbiCoder().encode(["address", "uint256", "address", "uint256", "bool"], [getAddress(asset), toE18(maxFeeUsd), getAddress(recipient), units, forceBatch]);
}

export async function buildWithdraw(signer: ActionSigner, w: WithdrawRequest, nowMs: number) {
  const units = toUnits(w.amount, w.collateral.decimals);
  const a: ActionFields = {
    subaccountId: w.subaccountId,
    nonce: increasingNonce(nowMs),
    module: WITHDRAW_MODULE,
    data: encodeWithdrawData(w.collateral.assetAddress, w.maxFeeUsd, w.recipient, units),
    expiry: Math.floor(nowMs / 1000) + 600,
    owner: signer.owner,
    signer: signer.signer,
  };
  const signature = await signer.signAction(a);
  return {
    subaccount_id: w.subaccountId,
    asset_name: w.collateral.name,
    amount_in_underlying: fromUnits(units, w.collateral.decimals),
    max_fee_usd: w.maxFeeUsd,
    force_batch: false,
    recipient: getAddress(w.recipient),
    nonce: a.nonce,
    signer: a.signer,
    signature,
    signature_expiry_sec: a.expiry,
  };
}

export async function withdraw(rpc: Rpc, signer: ActionSigner, w: WithdrawRequest, nowMs: number): Promise<unknown> {
  if (signer.signer !== signer.owner) throw new Error("Withdrawals are signed by your wallet, not the one-tap key");
  return rpc.call("private/withdraw", await buildWithdraw(signer, w, nowMs));
}
