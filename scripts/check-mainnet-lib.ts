// Core of `npm run check:mainnet`: proves on MAINNET that this app's order
// signatures verify, with zero risk. It reads the subaccount, quotes the
// smallest ETH call spread, signs both legs and sends them ONLY to
// private/order_debug. The connection it is given must be a ReadOnlyRpc, which
// refuses private/order (and anything else that could trade) before sending.
// Perps: the smallest ETH-PERP market (IOC) long and a post-only limit below the
// bid are signed exactly as Confirm would sign them and sent only to
// private/order_debug; private/get_margin simulates the position (read-only).

import { NETWORKS } from "../src/config.ts";
import { ReadOnlyRpc, debugPerp, debugSpread, type DebugReport } from "../src/net/dryrun.ts";
import { PERP_SLIPPAGE } from "../src/config.ts";
import { minSize, parsePerpInstrument, parsePerpTicker, quotePerp } from "../src/lib/perp.ts";
import { perpMarginCheck, type DeriveQuote, type MarginCheck } from "../src/net/perpTrader.ts";
import type { ActionSigner } from "../src/net/signer.ts";
import { parseRiskUniverses, riskUniverseFor, riskUniverseForOptions } from "../src/net/onchain.ts";
import { parseInstruments, parseSubaccount, parseTickers, type SubaccountInfo } from "../src/lib/ticker.ts";
import { quoteSpread, selectSpread, type SpreadQuote } from "../src/lib/spread.ts";
import { expiriesFor, spotOf } from "../src/lib/market.ts";

export interface MainnetCheck {
  subaccount: SubaccountInfo;
  ethOptionsUniverse: number | null;
  rightUniverse: boolean;
  legs: string[];
  amount: string;
  reports: DebugReport[];
  perps: PerpCheck | null;
  ok: boolean;
}

export interface PerpCheck {
  instrument: string;
  universe: number | null;
  rightUniverse: boolean;
  amount: string;
  market: DebugReport;
  postOnly: DebugReport;
  margin: MarginCheck | null;
  ok: boolean;
}

/** Sign the smallest perp orders (market long, post-only limit) and ask only private/order_debug about them. */
export async function checkMainnetPerps(o: { rpc: ReadOnlyRpc; signer: ActionSigner; subaccountId: number; sub: SubaccountInfo; asset?: string }): Promise<PerpCheck> {
  if (!(o.rpc instanceof ReadOnlyRpc)) throw new Error("checkMainnetPerps needs a ReadOnlyRpc connection");
  const name = `${o.asset ?? "ETH"}-PERP`;
  const inst = parsePerpInstrument(await o.rpc.call("public/get_instrument", { instrument_name: name }));
  const t = parsePerpTicker(await o.rpc.call("public/get_ticker", { instrument_name: name }));
  if (!inst || !t) throw new Error(`no ${name} market data on mainnet`);
  const universe = riskUniverseFor(parseRiskUniverses(await o.rpc.call("public/get_risk_universes", {})), name);
  const ref = t.mark > 0 ? t.mark : t.index;
  const risk = (Number(minSize(inst)) * ref) / 2 + 1; // the exchange minimum at 2×
  const mk = (orderType: "market" | "limit") => {
    const r = quotePerp({ inst, ticker: t, dir: "long", risk, leverage: 2, orderType, limitPrice: orderType === "limit" ? Math.max(t.bid * 0.99, t.minPrice ?? 0) : null, postOnly: orderType === "limit", slippage: PERP_SLIPPAGE, leverageCap: 2 });
    if (!r.ok) throw new Error(`${name} quote failed: ${r.reason}`);
    return r.quote as DeriveQuote;
  };
  const qm = mk("market"), ql = mk("limit");
  const market = await debugPerp(o.rpc, o.signer, NETWORKS.mainnet, o.subaccountId, qm);
  const postOnly = await debugPerp(o.rpc, o.signer, NETWORKS.mainnet, o.subaccountId, ql);
  let margin: MarginCheck | null = null;
  try {
    margin = await perpMarginCheck(o.rpc, o.subaccountId, name, qm.amount);
  } catch {
    margin = null; // an unfunded subaccount: the signature check still stands
  }
  return { instrument: name, universe, rightUniverse: universe !== null && o.sub.riskUniverse === universe, amount: qm.amount, market, postOnly, margin, ok: market.ok && postOnly.ok };
}

export async function checkMainnet(o: { rpc: ReadOnlyRpc; signer: ActionSigner; subaccountId: number; now: number; asset?: string; perps?: boolean }): Promise<MainnetCheck> {
  if (!(o.rpc instanceof ReadOnlyRpc)) throw new Error("checkMainnet needs a ReadOnlyRpc connection");
  const net = NETWORKS.mainnet;
  const asset = o.asset ?? "ETH";
  const sub = parseSubaccount(await o.rpc.call("private/get_subaccount", { subaccount_id: o.subaccountId }));
  if (!sub) throw new Error(`subaccount ${o.subaccountId} not readable`);
  const ru = riskUniverseForOptions(parseRiskUniverses(await o.rpc.call("public/get_risk_universes", {})), asset);
  const raw: unknown[] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await o.rpc.call<{ instruments?: unknown[]; pagination?: { num_pages?: number } }>("public/get_all_instruments", { currency: asset, instrument_type: "option", expired: false, page, page_size: 1000 });
    raw.push(...(r?.instruments ?? []));
    if (!(page < Number(r?.pagination?.num_pages ?? 1))) break;
  }
  const inst = parseInstruments({ instruments: raw });
  let q: SpreadQuote | null = null;
  for (const e of expiriesFor(inst, o.now).filter((x) => x.days >= 3 && x.days <= 60)) {
    const tk = parseTickers(await o.rpc.call("public/get_tickers", { currency: asset, instrument_type: "option", expiry_date: Number(e.key) }));
    const spot = spotOf(tk).spot;
    if (!spot) continue;
    const sel = selectSpread(inst, tk, spot, spot * 1.05, "up", e.key, o.now);
    if (!sel.ok) continue;
    const r = quoteSpread(sel.legs, 1);
    if (r.ok) {
      q = r.quote;
      if (r.quote.priced === "book") break;
    }
  }
  if (!q) throw new Error(`no quotable ${asset} spread on mainnet right now`);
  const reports = await debugSpread(o.rpc, o.signer, net, o.subaccountId, q);
  const perps = o.perps === false ? null : await checkMainnetPerps({ rpc: o.rpc, signer: o.signer, subaccountId: o.subaccountId, sub, asset });
  return {
    subaccount: sub,
    ethOptionsUniverse: ru,
    rightUniverse: ru !== null && sub.riskUniverse === ru,
    legs: [q.legs.long.instrument.name, q.legs.short.instrument.name],
    amount: q.amount,
    reports,
    perps,
    ok: reports.every((r) => r.ok) && (perps === null || perps.ok),
  };
}
