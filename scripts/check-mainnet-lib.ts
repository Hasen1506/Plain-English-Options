// Core of `npm run check:mainnet`: proves on MAINNET that this app's order
// signatures verify, with zero risk. It reads the subaccount, quotes the
// smallest ETH call spread, signs both legs and sends them ONLY to
// private/order_debug. The connection it is given must be a ReadOnlyRpc, which
// refuses private/order (and anything else that could trade) before sending.

import { NETWORKS } from "../src/config.ts";
import { ReadOnlyRpc, debugSpread, type DebugReport } from "../src/net/dryrun.ts";
import type { ActionSigner } from "../src/net/signer.ts";
import { parseRiskUniverses, riskUniverseForOptions } from "../src/net/onchain.ts";
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
  ok: boolean;
}

export async function checkMainnet(o: { rpc: ReadOnlyRpc; signer: ActionSigner; subaccountId: number; now: number; asset?: string }): Promise<MainnetCheck> {
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
  return {
    subaccount: sub,
    ethOptionsUniverse: ru,
    rightUniverse: ru !== null && sub.riskUniverse === ru,
    legs: [q.legs.long.instrument.name, q.legs.short.instrument.name],
    amount: q.amount,
    reports,
    ok: reports.every((r) => r.ok),
  };
}
