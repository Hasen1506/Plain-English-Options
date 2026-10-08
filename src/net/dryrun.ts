// Zero-risk checks. private/order_debug takes exactly the params of
// private/order, rebuilds the action and returns the hash it would verify plus
// the signer it recovers, WITHOUT placing anything. ReadOnlyRpc is an allowlist:
// anything that can move funds or place/cancel orders is refused before it is
// sent, so a dry run can never trade, even by mistake.

import { getAddress, recoverAddress } from "ethers";
import type { Network } from "../config.ts";
import type { Instrument, Ticker, Tradable } from "../lib/ticker.ts";
import { signPerpEntry, type DeriveQuote } from "./perpTrader.ts";
import { maxFeePerUnit, type SpreadQuote } from "../lib/spread.ts";
import { digest, encodeTradeData, type ActionFields } from "./signing.ts";
import type { ActionSigner } from "./signer.ts";
import { signOrder, type Rpc, type SignedOrder } from "./trader.ts";

export const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  "public/get_time",
  "public/get_all_currencies",
  "public/get_all_instruments",
  "public/get_instrument",
  "public/get_ticker",
  "public/get_tickers",
  "public/get_risk_universes",
  "private/get_subaccounts",
  "private/get_subaccount",
  "private/order_debug",
  "public/get_funding_rate_history",
  "private/get_margin",
  "private/get_positions",
  "private/get_trigger_orders",
  "private/get_open_orders",
  "private/get_trade_history",
  "private/get_funding_history",
]);

/** Methods that must never pass through a dry-run connection, whatever the allowlist says. */
export const NEVER_IN_DRY_RUN: ReadonlySet<string> = new Set([
  "private/order",
  "private/replace",
  "private/send_rfq",
  "private/execute_quote",
  "private/withdraw",
  "private/transfer_erc20",
  "private/set_session_key",
  "private/cancel",
  "private/cancel_all",
  "private/cancel_trigger_order",
  "private/cancel_all_trigger_orders",
  "private/liquidate",
]);

export class DryRunViolation extends Error {
  constructor(method: string) {
    super(`dry run refused ${method}: only read-only methods and private/order_debug are allowed`);
  }
}

export class ReadOnlyRpc implements Rpc {
  readonly sent: string[] = [];
  private readonly inner: Rpc;
  constructor(inner: Rpc) {
    this.inner = inner;
  }
  call<T = unknown>(method: string, params: object = {}): Promise<T> {
    if (NEVER_IN_DRY_RUN.has(method) || !READ_ONLY_METHODS.has(method)) return Promise.reject(new DryRunViolation(method));
    this.sent.push(method);
    return this.inner.call<T>(method, params);
  }
}

export interface DebugReport {
  instrument: string;
  ok: boolean; // exchange hash == our digest, published domain, and the signature over the exchange hash recovers our signer (= expected_signer)
  ourDigest: string;
  exchangeHash: string | null;
  expectedSigner: string | null;
  recoveredSigner: string | null;
  domainOk: boolean;
  error: string | null;
}

function actionOf(o: SignedOrder, inst: Tradable, owner: string, net: Network): ActionFields {
  return {
    subaccountId: Number(o.subaccount_id),
    nonce: String(o.nonce),
    module: net.tradeModule,
    data: encodeTradeData({
      assetAddress: inst.assetAddress,
      subId: inst.subId,
      limitPrice: String(o.limit_price),
      amount: o.amount,
      maxFee: String(o.max_fee),
      recipientId: Number(o.subaccount_id),
      isBid: o.direction === "buy",
    }),
    expiry: Number(o.signature_expiry_sec),
    owner,
    signer: String(o.signer),
  };
}

/** Sign one order and ask the exchange to check it. Never sends private/order. */
export async function debugOrder(rpc: ReadOnlyRpc, signer: ActionSigner, net: Network, subaccountId: number, inst: Instrument, t: Ticker, side: "buy" | "sell", amount: string, limitPrice: string): Promise<DebugReport> {
  const o = await signOrder(
    { inst, direction: side, amount, limitPrice, maxFee: maxFeePerUnit(inst, t.index, Number(limitPrice), Number(amount)), tif: "gtc", label: "peo-check" },
    { rpc, signer, net, subaccountId },
  );
  return debugSigned(rpc, signer, net, o, inst);
}

/** A perp order exactly as Confirm would send it (market IOC / limit / post-only), checked by private/order_debug only. */
export async function debugPerp(rpc: ReadOnlyRpc, signer: ActionSigner, net: Network, subaccountId: number, q: DeriveQuote): Promise<DebugReport> {
  const o = await signPerpEntry({ rpc, signer, net, subaccountId }, q, "peo-check");
  return debugSigned(rpc, signer, net, o, q.inst);
}

export async function debugSigned(rpc: ReadOnlyRpc, signer: ActionSigner, net: Network, o: SignedOrder, inst: Tradable): Promise<DebugReport> {
  if (!(rpc instanceof ReadOnlyRpc)) throw new Error("order checks need a ReadOnlyRpc connection");
  const ours = digest(actionOf(o, inst, signer.owner, net), net);
  try {
    const r = await rpc.call<Record<string, unknown>>("private/order_debug", o);
    const hash = typeof r?.typed_data_hash === "string" ? r.typed_data_hash : null;
    const rec = typeof r?.recovered_signer === "string" ? r.recovered_signer : null;
    const exp = typeof r?.expected_signer === "string" ? r.expected_signer : null;
    const dom = typeof r?.domain_separator === "string" ? r.domain_separator.toLowerCase() === net.domainSeparator.toLowerCase() : false;
    const same = (a: string | null, b: string) => !!a && getAddress(a) === getAddress(b);
    // order_debug may leave recovered_signer empty; then recover from the exchange's own hash
    let recovered = rec;
    if (!recovered && hash) {
      try {
        recovered = recoverAddress(hash, String(o.signature));
      } catch {
        recovered = null;
      }
    }
    const ok = !!hash && hash.toLowerCase() === ours.toLowerCase() && dom && same(recovered, signer.signer) && (exp === null || same(exp, signer.signer));
    return { instrument: inst.name, ok, ourDigest: ours, exchangeHash: hash, expectedSigner: exp, recoveredSigner: recovered, domainOk: dom, error: null };
  } catch (e) {
    return { instrument: inst.name, ok: false, ourDigest: ours, exchangeHash: null, expectedSigner: null, recoveredSigner: null, domainOk: false, error: (e as Error).message };
  }
}

/** Both legs of a quoted spread, at prices that could never fill (half the bid / double the ask band-limited). */
export async function debugSpread(rpc: ReadOnlyRpc, signer: ActionSigner, net: Network, subaccountId: number, q: SpreadQuote): Promise<DebugReport[]> {
  const L = q.legs.long, S = q.legs.short;
  return [
    await debugOrder(rpc, signer, net, subaccountId, L.instrument, L.ticker, "buy", q.amount, q.longLimit),
    await debugOrder(rpc, signer, net, subaccountId, S.instrument, S.ticker, "sell", q.amount, q.shortLimit),
  ];
}

