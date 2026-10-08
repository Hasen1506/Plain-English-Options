// The Hyperliquid PerpVenue end to end against the deterministic mock exchange
// (tests/mock/hyperliquid.ts: real signature recovery, agents, nonces, rules).
import { describe, expect, it, beforeEach } from "vitest";
import { Wallet, SigningKey, getAddress } from "ethers";
import { createHyperliquidVenue } from "../../src/venues/hyperliquid/index.ts";
import { HlClient, approveNewAgent, withdrawUsdc } from "../../src/venues/hyperliquid/client.ts";
import { HL_NETWORKS } from "../../src/venues/hyperliquid/config.ts";
import { planDeposit, depositCalldata, decodeDeposit, forwardHookData, RECEIVE_WITH_AUTH_TYPES } from "../../src/venues/hyperliquid/deposit.ts";
import { HL_RECORDED_AT, hlCredit, hlFetch, newHlState, type HlMockState } from "../mock/hyperliquid.ts";
import { quotePerp } from "../../src/lib/perp.ts";
import { orderAction } from "../../src/venues/hyperliquid/orders.ts";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // Hardhat #1, test-only
const w = new Wallet(KEY);

function fakeWallet(chain = "0xa4b1") {
  const calls: string[] = [];
  return {
    calls,
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      calls.push(method);
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [w.address];
      if (method === "eth_chainId") return chain;
      if (method === "eth_signTypedData_v4") {
        const td = JSON.parse(String((params as unknown[])[1]));
        if (Number(td.domain.chainId) !== parseInt(chain, 16)) throw new Error("chainId mismatch");
        for (const v of Object.values(td.message)) if (typeof v === "number") throw new Error("mobile wallets want strings");
        const { EIP712Domain: _d, ...types } = td.types;
        return w.signTypedData(td.domain, types, td.message);
      }
      throw new Error("unsupported " + method);
    },
  };
}

let st: HlMockState;
let now = HL_RECORDED_AT + 60_000;
const mk = (wallet = fakeWallet()) => {
  const v = createHyperliquidVenue({ net: () => "mainnet", now: () => now, eth: () => wallet, fetch: hlFetch(st), sheet: { open: () => {}, close: () => {} }, changed: () => {} });
  return { v, wallet };
};

beforeEach(() => {
  now = HL_RECORDED_AT + 60_000;
  st = newHlState("mainnet", () => now);
  hlCredit(st, w.address, 1000);
});

async function quote(v: ReturnType<typeof mk>["v"], o: Partial<Parameters<typeof quotePerp>[0]> = {}) {
  const ms = await v.markets();
  v.focus!("ETH-PERP");
  const tk = await v.tickers();
  const inst = ms.find((m) => m.name === "ETH-PERP")!;
  const acct = v.selectedAccount("ETH-PERP");
  const r = quotePerp({ inst, ticker: tk["ETH-PERP"]!, dir: "long", risk: 50, leverage: 3, orderType: "market", slippage: v.slippage, leverageCap: 10, headroomMM: acct?.maintenanceMargin ?? null, headroomIM: acct?.initialMargin ?? null, existing: acct?.positions.find((p) => p.instrument === "ETH-PERP")?.amount ?? 0, ...o });
  if (!r.ok) throw new Error(r.reason);
  return r.quote;
}

describe("Hyperliquid venue against the mock exchange", () => {
  it("market data: ETH/BTC first, live once loaded, book from l2Book", async () => {
    const { v } = mk();
    const ms = await v.markets();
    expect(ms[0]!.name).toBe("ETH-PERP");
    v.focus!("ETH-PERP");
    const tk = await v.tickers();
    expect(tk["ETH-PERP"]!.askSize).toBeGreaterThan(0);
    expect(v.isLive()).toBe(true);
    expect(v.networkName()).toBe("Mainnet");
  });

  it("one approval, then one-tap: market long with TP/SL → position, triggers → close ½ → flip → cancel all → close", async () => {
    const { v, wallet } = mk();
    await v.connect!();
    expect(v.connected()).toBe(true);
    expect(v.signer()!.oneTap).toBe(false);
    const q0 = await quote(v);
    const q = { ...q0, takeProfit: String(Math.round(q0.entry * 1.1)), stopLoss: String(Math.round(q0.entry * 0.9)) };
    const steps: string[] = [];
    const r = await v.open(v.selectedAccount("ETH-PERP")!, q, (s) => steps.push(s));
    expect(steps[0]).toMatch(/Approve the one-tap key/);
    expect(r.entry.status).toBe("filled");
    expect(r.triggers.map((t) => t.status)).toEqual(["open", "open"]);
    expect(wallet.calls.filter((c) => c === "eth_signTypedData_v4")).toHaveLength(1); // only the agent approval
    expect(v.signer()!.oneTap).toBe(true);
    const acct = v.selectedAccount("ETH-PERP")!;
    const p = acct.positions.find((x) => x.instrument === "ETH-PERP")!;
    expect(p.amount).toBeCloseTo(Number(q.amount), 9);
    expect(p.liquidationPrice).toBeNull(); // $150 long on a $1,000 cross account survives to zero (the exchange says null too)
    expect((await v.triggers(acct)).map((t) => t.triggerType).sort()).toEqual(["stoploss", "takeprofit"]);
    // leverage was set to 3× cross before the order
    expect(st.lev[getAddress(w.address)]!.ETH).toEqual({ type: "cross", value: 3 });
    // close half (reduce-only IOC), then flip, all without the wallet
    const half = await v.close(acct, "ETH-PERP", p.amount, 0.5);
    expect(half.status).toBe("filled");
    const left = v.selectedAccount("ETH-PERP")!.positions[0]!.amount;
    expect(left).toBeCloseTo(p.amount - half.filled, 9);
    const fl = await v.flip(acct, "ETH-PERP", left);
    expect(fl.open!.status).toBe("filled");
    expect(v.selectedAccount("ETH-PERP")!.positions[0]!.amount).toBeCloseTo(-left, 9);
    await v.cancelAll(acct);
    expect(await v.triggers(acct)).toEqual([]);
    const c = await v.close(acct, "ETH-PERP", -left, 1);
    expect(c.status).toBe("filled");
    expect(v.selectedAccount("ETH-PERP")!.positions).toEqual([]);
    expect(wallet.calls.filter((x) => x === "eth_signTypedData_v4")).toHaveLength(1);
    const hist = await v.history(acct);
    expect(hist.trades.length).toBe(5); // open, close ½, flip (close + open), close
  });

  it("post-only limit rests; crossing post-only is refused by the exchange", async () => {
    const { v } = mk();
    await v.connect!();
    const tk = await v.tickers();
    const t = tk["ETH-PERP"]!;
    const rest = await v.open(v.selectedAccount("ETH-PERP")!, await quote(v, { orderType: "limit", limitPrice: t.bid * 0.98, postOnly: true }));
    expect(rest.entry.status).toBe("open");
    const oo = await v.openOrders!(v.selectedAccount("ETH-PERP")!);
    expect(oo).toHaveLength(1);
    const q = await quote(v, { orderType: "limit", limitPrice: t.ask * 1.01, postOnly: false });
    const bad = await v.open(v.selectedAccount("ETH-PERP")!, { ...q, tif: "post_only" });
    expect(bad.entry.status).toBe("rejected");
    expect(bad.entry.error).toMatch(/Post only/);
  });

  it("isolated mode sets isolated leverage; $10 minimum is enforced before signing", async () => {
    const { v } = mk();
    await v.connect!();
    v.setMarginMode!("isolated");
    expect(v.riskWords!()).toMatch(/isolated/);
    await v.open(v.selectedAccount("ETH-PERP")!, await quote(v, { leverage: 2 }));
    expect(st.lev[getAddress(w.address)]!.ETH).toEqual({ type: "isolated", value: 2 });
    const q = await quote(v, { risk: 1, leverage: 1 });
    await expect(v.open(v.selectedAccount("ETH-PERP")!, { ...q, amount: "0.001", n: 0.001 })).rejects.toThrow(/minimum order is \$10/);
  });

  it("dry run: the exchange recovers our throwaway signer and nothing trades", async () => {
    const { v } = mk();
    await v.connect!();
    const before = JSON.stringify(st.pos);
    const r = await v.checkOrder(v.selectedAccount("ETH-PERP")!, await quote(v));
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/nothing was traded/);
    expect(JSON.stringify(st.pos)).toBe(before);
  });

  it("disconnect revokes: the old agent can no longer sign", async () => {
    const { v } = mk();
    await v.connect!();
    await v.open(v.selectedAccount("ETH-PERP")!, await quote(v));
    const oldAgent = v.agentAddress()!;
    expect(st.agents.has(oldAgent)).toBe(true);
    await v.disconnect!();
    expect(st.agents.has(oldAgent)).toBe(false); // the named slot now holds a burned key
    expect(v.connected()).toBe(false);
  });

  it("agents expire on their own (valid_until = 24 h)", async () => {
    const c = new HlClient({ api: "https://x", mainnet: true, now: () => now, fetch: hlFetch(st) });
    const a = await approveNewAgent(c, fakeWallet(), w.address, now);
    expect(a.expiresAt).toBe(now + 24 * 3600_000);
    now += 24 * 3600_000 + 1;
    const r = (await c.l1(orderAction([{ a: 1, b: true, p: "2000", s: "0.01", r: false, t: { limit: { tif: "Gtc" } } }]), a.key)) as { status: string; response: string };
    expect(r.status).toBe("err");
    expect(r.response).toMatch(/does not exist/);
  });

  it("withdraw3 is signed by the wallet (never the agent) and pays the user's own address", async () => {
    const c = new HlClient({ api: "https://x", mainnet: true, now: () => now, fetch: hlFetch(st) });
    await withdrawUsdc(c, fakeWallet(), w.address, "25", now);
    expect(st.withdrawals).toEqual([{ user: w.address, amount: "25", destination: w.address }]);
    expect(st.balance[w.address]).toBe(975);
    // an agent signing a withdraw3 is not even a valid shape: withdraw3 is user-signed only
    const agentKey = new SigningKey(Wallet.createRandom().privateKey);
    const r = (await c.l1({ type: "withdraw3", amount: "5" }, agentKey)) as { status: string };
    expect(r.status).toBe("err");
  });
});

describe("CCTP deposit (Arbitrum → HyperCore)", () => {
  const n = HL_NETWORKS.mainnet;
  it("signs exactly the amount, to the CctpExtension, and burns with the forwarder as recipient AND caller", async () => {
    const plan = planDeposit(n, w.address, "25", 200_000n, 1_790_000_000, "0x" + "11".repeat(32));
    expect(plan.typed.domain).toEqual({ name: "USD Coin", version: "2", chainId: 42161, verifyingContract: getAddress(n.usdc) });
    expect(plan.typed.message.to).toBe(getAddress(n.cctpExtension));
    expect(plan.typed.message.value).toBe("25000000");
    expect(plan.credited).toBe(24_800_000n);
    const sig = await w.signTypedData(plan.typed.domain, RECEIVE_WITH_AUTH_TYPES, plan.typed.message);
    const d = decodeDeposit(depositCalldata(n, plan, sig, w.address));
    expect(d[0].amount).toBe(25_000_000n);
    expect(d[1].amount).toBe(25_000_000n);
    expect(d[1].destinationDomain).toBe(19n);
    expect(d[1].mintRecipient.toLowerCase()).toBe("0x000000000000000000000000" + n.cctpForwarder.slice(2).toLowerCase());
    expect(d[1].destinationCaller).toBe(d[1].mintRecipient);
    expect(d[1].maxFee).toBe(200_000n);
    expect(d[1].minFinalityThreshold).toBe(1000n);
    expect(d[1].hookData).toBe(forwardHookData(w.address, 0));
  });
  it("hook data matches Circle's documented layout", () => {
    expect(forwardHookData("0x000000000000000000000000000000000000dEaD")).toBe("0x636374702d666f72776172640000000000000000000000000000000000000018000000000000000000000000000000000000dead00000000");
  });
  it("refuses below 5 USDC or amounts that do not cover the fee", () => {
    expect(() => planDeposit(n, w.address, "4.99", 200_000n, 1)).toThrow(/at least 5/);
    expect(() => planDeposit(n, w.address, "5", 6_000_000n, 1)).toThrow(/fee/);
  });
});
