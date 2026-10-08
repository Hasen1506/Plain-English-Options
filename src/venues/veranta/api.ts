// The calls the Veranta venue makes, behind one small interface so the venue
// logic is the same against the real SDK (SdkVerantaApi, lazy-loaded) and the
// e2e mock (HttpVerantaApi). Keys never leave this module's closure.

import type { NetworkId } from "../../config.ts";
import { VERANTA_FORK_USDC_HOLDERS, VERANTA_NETWORKS, VERANTA_PRACTICE_USDC, VERANTA_SESSION_TTL_S } from "./config.ts";
import type { VHistoryRow, VPair, VRawLimit, VRawPosition } from "./rules.ts";

export interface VReceipt {
  route: string; // batched-market | relayer-passthrough | wallet | mock
  txHash?: string;
  orderId?: number | null;
  trackingId?: string;
  requestId?: string;
}

export interface VPractice {
  trader: string;
  session: string;
  sessionExpiry: number; // unix seconds
  funded: number; // test USDC in the practice wallet
}

export interface VerantaApi {
  pairs(): Promise<VPair[]>;
  price(pairIndex: number): Promise<number>;
  /** Testnet only: a practice trader key + a 30-day session key registered for it, funded from the fork faucet. */
  startPractice(onStep?: (s: string) => void): Promise<VPractice>;
  usdc(): Promise<{ balance: number; allowance: number }>;
  /** Exact-amount USDC approval to Veranta's TradingStorage (never unlimited), signed by the trader key. */
  approveExact(amount: string): Promise<VReceipt>;
  positions(): Promise<{ positions: VRawPosition[]; limits: VRawLimit[] }>;
  marketOpen(symbol: string, side: "long" | "short", a: { collateral: string; leverage: string; takeProfit?: string; stopLoss?: string; slippagePercent: string }): Promise<VReceipt>;
  limitOpen(symbol: string, side: "long" | "short", a: { collateral: string; leverage: string; price: string; takeProfit?: string; stopLoss?: string }): Promise<VReceipt>;
  marketClose(symbol: string, tradeIndex: number, collateralToClose: string): Promise<VReceipt>;
  cancelLimit(symbol: string, orderIndex: number): Promise<VReceipt>;
  updateTpSl(symbol: string, tradeIndex: number, a: { takeProfit?: string; stopLoss?: string }): Promise<VReceipt>;
  history(): Promise<VHistoryRow[]>;
  /** Revoke the session key on Veranta and forget both keys. */
  endPractice(): Promise<VReceipt | null>;
  trader(): string | null;
  session(): string | null;
}

const rec = (r: { route?: string; txHash?: string; orderId?: number; trackingId?: string; requestId?: string }): VReceipt => ({ route: String(r.route ?? ""), txHash: r.txHash, orderId: r.orderId ?? null, trackingId: r.trackingId, requestId: r.requestId });

/**
 * Veranta's history API pages from 1: page 0 answers {success:false, "Unable to get the trade
 * history."} (seen live 2026-10-08), which must surface as an error, never as "no trades".
 */
export async function historyPage(info: { tradeHistory(trader: `0x${string}`, page: number, size: number): Promise<unknown> }, trader: string): Promise<VHistoryRow[]> {
  const r = (await info.tradeHistory(trader as `0x${string}`, 1, 100)) as { success?: boolean; errorMessage?: string; trades?: VHistoryRow[] } | null;
  if (!r || r.success === false) throw new Error(r?.errorMessage ?? "Veranta's history API did not answer");
  return r.trades ?? [];
}

/** The real thing: veranta-sdk 0.3.1 in the browser (loaded only when Veranta is picked). */
export function sdkVerantaApi(net: NetworkId): VerantaApi {
  const N = VERANTA_NETWORKS[net];
  type Sdk = typeof import("veranta-sdk");
  type Client = InstanceType<Sdk["Veranta"]>;
  let sdk: Sdk | null = null;
  let pub: Client | null = null;
  let T: Client | null = null; // trader (practice key): approvals, session key registration
  let S: Client | null = null; // session key: every order
  let traderKey: `0x${string}` | null = null;
  let traderAddr: string | null = null;
  let sessionAddr: string | null = null;

  const load = async (): Promise<Sdk> => (sdk ??= await import("veranta-sdk"));
  const publicClient = async () => (pub ??= new (await load()).Veranta({ network: N.sdk, env: {} }));
  const need = (c: Client | null, what: string): Client => {
    if (!c) throw new Error(`Start the Veranta practice account first (${what})`);
    return c;
  };

  async function fundFromFork(addr: string, onStep?: (s: string) => void) {
    const s = await load();
    // 1) the SDK's own faucet. Its URL guard wants "testnet" in the RPC URL but its own
    //    default fork RPC is devnet-rpc…; a URL fragment satisfies it and never reaches the server.
    try {
      onStep?.("Asking Veranta's testnet faucet for test USDC…");
      const r = await s.fundTestnetWallet(addr as `0x${string}`, { rpcUrl: s.TESTNET_RPC_URL + "#testnet", eth: 0, usdc: VERANTA_PRACTICE_USDC });
      if (Number(r.usdcRaw) >= VERANTA_PRACTICE_USDC * 1e6 * 0.99) return;
    } catch {
      /* the faucet's whale can run dry on the fork; fall through */
    }
    // 2) the same fork-only mechanism from another USDC holder on the fork
    const { encodeFunctionData, parseAbi } = await import("viem");
    const rpc = async (method: string, params: unknown[]) => {
      const r = (await (await fetch(s.TESTNET_RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result?: unknown; error?: { message?: string } };
      if (r.error) throw new Error(r.error.message ?? "fork RPC error");
      return r.result;
    };
    const usdcAddr = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const bal = async (who: string) => BigInt(String(await rpc("eth_call", [{ to: usdcAddr, data: "0x70a08231" + who.slice(2).toLowerCase().padStart(64, "0") }, "latest"])));
    const want = BigInt(VERANTA_PRACTICE_USDC) * 1_000_000n;
    for (const from of VERANTA_FORK_USDC_HOLDERS) {
      if ((await bal(from)) < want) continue;
      onStep?.("Funding the practice account with test USDC…");
      const data = encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256)"]), args: [addr as `0x${string}`, want] });
      const tx = String(await rpc("dev_impersonateTransaction", [{ from, to: usdcAddr, data, value: "0x0" }]));
      for (let i = 0; i < 40; i++) {
        const r = (await rpc("eth_getTransactionReceipt", [tx])) as { status?: string } | null;
        if (r?.status) {
          if (r.status !== "0x1") break;
          return;
        }
        await new Promise((ok) => setTimeout(ok, 1500));
      }
    }
    throw new Error("Veranta's testnet faucet has no test USDC right now");
  }

  return {
    async pairs() {
      const m = await (await publicClient()).markets.pairs();
      return [...m.values()] as unknown as VPair[];
    },
    async price(i) {
      return (await publicClient()).markets.price(i);
    },
    async startPractice(onStep) {
      if (N.sdk !== "testnet") throw new Error("Veranta mainnet is not available in this app yet");
      const s = await load();
      const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
      traderKey = generatePrivateKey(); // memory only, practice funds on the fork
      const sessKey = generatePrivateKey();
      traderAddr = privateKeyToAccount(traderKey).address;
      sessionAddr = privateKeyToAccount(sessKey).address;
      T = new s.Veranta({ network: N.sdk, signer: traderKey, env: {} });
      S = new s.Veranta({ network: N.sdk, signer: sessKey, trader: traderAddr as `0x${string}`, env: {} });
      await fundFromFork(traderAddr, onStep);
      onStep?.("Registering a 30-day one-tap key (it can trade, never withdraw)…");
      const expiry = Math.floor(Date.now() / 1000) + VERANTA_SESSION_TTL_S;
      await T.account.registerDelegate(sessionAddr as `0x${string}`, expiry, s.toSigner(traderKey), { wait: true });
      const st = (await T.account.delegationStatus(sessionAddr as `0x${string}`)) as { canSignIntents?: boolean };
      if (!st?.canSignIntents) throw new Error("Veranta did not accept the one-tap key");
      return { trader: traderAddr, session: sessionAddr, sessionExpiry: expiry, funded: await T.account.usdcBalance() };
    },
    async usdc() {
      const a = (await need(T, "balance").account.allowance()) as { balance?: string; allowance?: string };
      return { balance: Number(a.balance ?? 0) / 1e6, allowance: Number(a.allowance ?? 0) / 1e6 };
    },
    async approveExact(amount) {
      return rec(await need(T, "approve").account.approveUsdc(amount, { wait: true }));
    },
    async positions() {
      const u = (await need(T, "positions").account.positions()) as unknown as { positions: VRawPosition[]; limitOrders: VRawLimit[] };
      return { positions: u.positions ?? [], limits: u.limitOrders ?? [] };
    },
    async marketOpen(symbol, side, a) {
      return rec(await need(S, "trade").trade.marketOpen(symbol, side, { collateral: a.collateral, leverage: a.leverage, takeProfit: a.takeProfit, stopLoss: a.stopLoss, slippagePercent: a.slippagePercent, wait: true }));
    },
    async limitOpen(symbol, side, a) {
      return rec(await need(S, "trade").trade.limitOpen(symbol, side, { collateral: a.collateral, leverage: a.leverage, price: a.price, takeProfit: a.takeProfit, stopLoss: a.stopLoss, wait: true }));
    },
    async marketClose(symbol, idx, coll) {
      return rec(await need(S, "trade").trade.marketClose(symbol, idx, { collateralToClose: coll, wait: true }));
    },
    async cancelLimit(symbol, idx) {
      return rec(await need(S, "trade").trade.cancelLimitOrder(symbol, idx, { wait: true }));
    },
    async updateTpSl(symbol, idx, a) {
      return rec(await need(S, "trade").trade.updateTpSl(symbol, idx, { takeProfit: a.takeProfit, stopLoss: a.stopLoss, wait: true }));
    },
    async history() {
      if (!traderAddr) return [];
      return historyPage((await publicClient()).info, traderAddr);
    },
    async endPractice() {
      const t = T, sa = sessionAddr;
      T = S = null;
      traderKey = null;
      traderAddr = sessionAddr = null;
      return t && sa ? rec(await t.account.revokeDelegate(sa as `0x${string}`, { wait: true })) : null;
    },
    trader: () => traderAddr,
    session: () => sessionAddr,
  };
}

/** e2e builds only: the same calls as JSON POSTs to tests/mock/veranta.ts. */
export function httpVerantaApi(base: string): VerantaApi {
  let trader: string | null = null, session: string | null = null;
  const call = async <T>(m: string, args: unknown[] = []): Promise<T> => {
    const r = (await (await fetch(`${base}/${m}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args, trader, session }) })).json()) as { ok?: boolean; result?: T; error?: string };
    if (!r.ok) throw new Error(r.error ?? "mock error");
    return r.result as T;
  };
  return {
    pairs: () => call("pairs"),
    price: (i) => call("price", [i]),
    async startPractice(onStep) {
      onStep?.("Asking Veranta's testnet faucet for test USDC…");
      const p = await call<VPractice>("startPractice", [VERANTA_SESSION_TTL_S]);
      trader = p.trader;
      session = p.session;
      return p;
    },
    usdc: () => call("usdc"),
    approveExact: (a) => call("approveExact", [a]),
    positions: () => call("positions"),
    marketOpen: (s, side, a) => call("marketOpen", [s, side, a]),
    limitOpen: (s, side, a) => call("limitOpen", [s, side, a]),
    marketClose: (s, i, c) => call("marketClose", [s, i, c]),
    cancelLimit: (s, i) => call("cancelLimit", [s, i]),
    updateTpSl: (s, i, a) => call("updateTpSl", [s, i, a]),
    history: () => call("history"),
    async endPractice() {
      const r = trader ? await call<VReceipt>("endPractice") : null;
      trader = session = null;
      return r;
    },
    trader: () => trader,
    session: () => session,
  };
}
