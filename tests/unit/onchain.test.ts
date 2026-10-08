import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { AbiCoder, Interface } from "ethers";
import { NETWORKS, WITHDRAW_MODULE } from "../../src/config.ts";
import { keySigner, type Eip1193 } from "../../src/net/signer.ts";
import {
  buildWithdraw,
  calldata,
  checkDepositAmount,
  collateralFor,
  depositRoute,
  estimateDepositGas,
  fromUnits,
  parseRiskUniverses,
  planDeposit,
  riskUniverseForOptions,
  toUnits,
  waitForNewSubaccount,
  waitReceipt,
  withdraw,
} from "../../src/net/onchain.ts";
import testnetRU from "../fixtures/testnet-risk-universes.json" with { type: "json" };

const OWNER = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // Hardhat #1, test-only
const net = NETWORKS.testnet;
const U = parseRiskUniverses(testnetRU);

/** A fake wallet provider that answers balance/allowance reads and records sends. */
function fakeProvider(balance: bigint, allowance: bigint, opts: { estimateFails?: boolean } = {}) {
  const sent: { to: string; data: string }[] = [];
  const p: Eip1193 = {
    async request({ method, params }) {
      const a = (params ?? []) as Record<string, string>[];
      if (method === "eth_call") {
        const sel = a[0]!.data!.slice(0, 10);
        if (sel === calldata.balanceOf(net.actionManager).slice(0, 10)) return "0x" + balance.toString(16);
        return "0x" + allowance.toString(16);
      }
      if (method === "eth_chainId") return "0xaa36a7";
      if (method === "eth_estimateGas") {
        if (opts.estimateFails && a[0]!.to === net.actionManager) throw new Error("execution reverted: allowance");
        return "0xea60";
      }
      if (method === "eth_gasPrice") return "0x3b9aca00"; // 1 gwei
      if (method === "eth_sendTransaction") {
        sent.push(a[0] as { to: string; data: string });
        return "0x" + "ab".repeat(32);
      }
      throw new Error("unexpected " + method);
    },
  };
  return { p, sent };
}

describe("risk universes and deposit routing", () => {
  it("maps option assets to universes from the live answer (ETH/BTC → 1, HYPE → 2, alts → 3)", () => {
    expect(riskUniverseForOptions(U, "ETH")).toBe(1);
    expect(riskUniverseForOptions(U, "BTC")).toBe(1);
    expect(riskUniverseForOptions(U, "HYPE")).toBe(2);
    for (const a of ["ADA", "SOL", "LIT", "CC"]) expect(riskUniverseForOptions(U, a)).toBe(3);
    expect(riskUniverseForOptions(U, "NOPE")).toBeNull();
  });

  it("routes a new ETH-options deposit to the SM manager of universe 1 with testnet USDC", () => {
    const r = depositRoute(U, net, 1);
    expect(r.managerId).toBe(1);
    expect(r.collateral.erc20).toBe(net.usdc);
    expect(r.collateral.decimals).toBe(6);
    expect(r.collateral.minDepositUsd).toBe(5);
  });

  it("refuses a USDC address other than the network's (a tampered API answer cannot redirect funds)", () => {
    expect(() => collateralFor(U, NETWORKS.mainnet, 1)).toThrow(/Unexpected USDC/);
    expect(() => depositRoute(U, net, 99)).toThrow(/No risk universe/);
  });
});

describe("deposit amounts and decimals (properties)", () => {
  const decArb = fc.tuple(fc.bigInt({ min: 0n, max: 10n ** 12n }), fc.integer({ min: 0, max: 18 })).chain(([w, d]) =>
    fc.integer({ min: 0, max: d }).chain((fd) => fc.bigInt({ min: 0n, max: 10n ** BigInt(fd) - 1n }).map((f) => ({ s: fd ? `${w}.${f.toString().padStart(fd, "0")}` : `${w}`, d, w, f, fd }))),
  );

  it("toUnits is exact: units = whole × 10^d + fraction, and fromUnits round-trips", () => {
    fc.assert(
      fc.property(decArb, ({ s, d, w, f, fd }) => {
        const u = toUnits(s, d);
        return u === w * 10n ** BigInt(d) + f * 10n ** BigInt(d - fd) && toUnits(fromUnits(u, d), d) === u;
      }),
      { numRuns: 3000 },
    );
  });

  it("rejects more decimals than the token has, negatives, exponents and junk", () => {
    expect(() => toUnits("1.0000001", 6)).toThrow(/6 decimals/);
    for (const bad of ["-1", "1e3", "", " ", "abc", "1.", ".5", "0x10"]) expect(() => toUnits(bad, 6)).toThrow();
  });

  it("deposit checks: minimum, wallet balance and zero (property over cents)", () => {
    const c = { decimals: 6, minDepositUsd: 5 };
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), fc.integer({ min: 0, max: 10_000_000 }), (cents, walletCents) => {
        const amt = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
        const r = checkDepositAmount(amt, c, BigInt(walletCents) * 10_000n);
        const expectOk = cents >= 500 && cents <= walletCents;
        return r.ok === expectOk && (!r.ok || r.units === BigInt(cents) * 10_000n);
      }),
      { numRuns: 2000 },
    );
  });
});

describe("deposit plans", () => {
  const route = depositRoute(U, net, 1);
  const owner = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

  it("new subaccount: approve the exact amount, then depositToNewSubaccount(asset, units, managerId, owner)", async () => {
    const { p } = fakeProvider(10_000n * 10n ** 6n, 0n);
    const plan = await planDeposit(p, net, owner, route.collateral, route.managerId, "25.5", { kind: "new", managerId: 1, owner });
    expect(plan.steps.map((s) => s.kind)).toEqual(["approve", "deposit"]);
    expect(calldata.decode(plan.steps[0]!.data)).toEqual({ name: "approve", args: [net.actionManager, 25_500_000n] });
    expect(plan.steps[0]!.to).toBe(net.usdc);
    expect(plan.steps[1]!.to).toBe(net.actionManager);
    expect(calldata.decode(plan.steps[1]!.data)).toEqual({ name: "depositToNewSubaccount", args: [route.collateral.assetAddress, 25_500_000n, 1n, owner] });
  });

  it("existing subaccount with enough allowance: one deposit(asset, units, subaccountId, fallback) step", async () => {
    const { p } = fakeProvider(100n * 10n ** 6n, 10n ** 12n);
    const plan = await planDeposit(p, net, owner, route.collateral, 1, "10", { kind: "existing", subaccountId: 87139, fallback: owner });
    expect(plan.steps.map((s) => s.kind)).toEqual(["deposit"]);
    expect(calldata.decode(plan.steps[0]!.data)).toEqual({ name: "deposit", args: [route.collateral.assetAddress, 10_000_000n, 87139n, owner] });
  });

  it("refuses below the minimum or above the wallet balance before any transaction", async () => {
    const { p, sent } = fakeProvider(7n * 10n ** 6n, 0n);
    await expect(planDeposit(p, net, owner, route.collateral, 1, "4.99", { kind: "new", managerId: 1, owner })).rejects.toThrow(/Minimum/);
    await expect(planDeposit(p, net, owner, route.collateral, 1, "8", { kind: "new", managerId: 1, owner })).rejects.toThrow(/only 7 USDC/);
    expect(sent).toHaveLength(0);
  });

  it("gas estimate falls back for a deposit that cannot be simulated before its approve, and says so", async () => {
    const { p } = fakeProvider(10n ** 9n, 0n, { estimateFails: true });
    const plan = await planDeposit(p, net, owner, route.collateral, 1, "10", { kind: "new", managerId: 1, owner });
    const g = await estimateDepositGas(p, plan);
    expect(g.approximate).toBe(true);
    expect(g.perStep).toEqual([60_000n, 400_000n]);
    expect(g.totalWei).toBe(460_000n * 1_000_000_000n);
  });

  it("waits for a receipt and fails loudly on a reverted transaction", async () => {
    let n = 0;
    const p: Eip1193 = { request: async () => (++n < 3 ? null : { status: "0x1", blockNumber: "0x10" }) };
    await expect(waitReceipt(p, "0x" + "1".repeat(64), { sleep: async () => {} })).resolves.toEqual({ status: "success", blockNumber: 16 });
    const bad: Eip1193 = { request: async () => ({ status: "0x0" }) };
    await expect(waitReceipt(bad, "0x" + "1".repeat(64), { sleep: async () => {} })).rejects.toThrow(/failed/);
  });

  it("finds the new subaccount id after crediting", async () => {
    let n = 0;
    const rpc = { call: async <T,>() => ({ subaccount_ids: ++n < 3 ? [5] : [5, 9, 10] }) as T };
    await expect(waitForNewSubaccount(rpc, "0x1", [5], { sleep: async () => {} })).resolves.toEqual([9, 10]);
  });
});

describe("withdraw", () => {
  const coll = depositRoute(U, net, 1).collateral;
  it("signs (asset, maxFee e18, recipient, native units, forceBatch) with the withdraw module", async () => {
    const s = keySigner(OWNER, net);
    const p = await buildWithdraw(s, { subaccountId: 87139, collateral: coll, amount: "5.25", recipient: s.owner, maxFeeUsd: "1" }, Date.UTC(2026, 9, 8));
    expect(p.amount_in_underlying).toBe("5.25");
    expect(p.asset_name).toBe("USDC");
    const [asset, fee, rcpt, units, fb] = AbiCoder.defaultAbiCoder().decode(["address", "uint256", "address", "uint256", "bool"], new Interface([]).getAbiCoder().encode(["address", "uint256", "address", "uint256", "bool"], [coll.assetAddress, 10n ** 18n, s.owner, 5_250_000n, false]));
    expect([asset, fee, rcpt, units, fb]).toEqual([coll.assetAddress, 10n ** 18n, s.owner, 5_250_000n, false]);
    expect(WITHDRAW_MODULE).toBe("0x9d0E8f5b25384C7310CB8C6aE32C8fbeb645d083");
  });

  it("refuses a session-key signer (withdrawals always need the wallet)", async () => {
    const s = { ...keySigner(OWNER, net), signer: "0x0000000000000000000000000000000000000001" };
    await expect(withdraw({ call: async () => ({}) as never }, s, { subaccountId: 1, collateral: coll, amount: "5", recipient: s.owner, maxFeeUsd: "1" }, 0)).rejects.toThrow(/wallet/);
  });
});
