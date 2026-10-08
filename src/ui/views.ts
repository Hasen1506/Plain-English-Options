// HTML builders for the review, result and portfolio screens. Pure string
// functions (escaped), so they can be unit-tested without a DOM.

import type { SpreadQuote } from "../lib/spread.ts";
import { chartPoints, profitAt, type PayoffSpec } from "../lib/payoff.ts";
import { escapeHtml as h, money, pct, price, signedMoney, usd2 } from "../lib/format.ts";
import type { SpreadResult, OrderOutcome } from "../net/trader.ts";
import type { OpenOrder, Position, SubaccountInfo } from "../lib/ticker.ts";
import type { ClosedSpread, OrderRow, TradeRow, LegSummary } from "../lib/history.ts";

export const specOf = (q: SpreadQuote): PayoffSpec => ({ dir: q.legs.dir, K1: q.legs.K1, K2: q.legs.K2, n: q.n, cost: q.cost, fees: q.fees });

export function chartSvg(q: SpreadQuote): { svg: string; pts: { x: number; pl: number }[]; from: number; to: number } {
  const spec = specOf(q);
  const pts = chartPoints(spec, 14);
  const maxUp = Math.max(1e-9, ...pts.map((p) => p.pl));
  const maxDn = Math.max(1e-9, ...pts.map((p) => -p.pl));
  const H = 160, mid = H * (maxUp / (maxUp + maxDn)), bw = 600 / pts.length;
  const bars = pts
    .map((p, i) => {
      const hgt = Math.max(3, p.pl >= 0 ? (p.pl / maxUp) * (mid - 6) : (-p.pl / maxDn) * (H - mid - 6));
      const y = p.pl >= 0 ? mid - hgt : mid;
      return `<rect data-i="${i}" style="--i:${i}" x="${(i * bw + 4).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 8).toFixed(1)}" height="${hgt.toFixed(1)}" rx="7" class="${p.pl >= 0 ? "is-up" : "is-dn"}"><title>${h(price(p.x))} · ${h(signedMoney(p.pl))}</title></rect>`;
    })
    .join("");
  const svg = `<svg viewBox="0 0 600 ${H}" role="img" aria-label="Profit or loss by price at expiry">${bars}<line x1="0" x2="600" y1="${mid.toFixed(1)}" y2="${mid.toFixed(1)}" stroke="#151515" stroke-width="2"/></svg>`;
  return { svg, pts, from: pts[0]!.x, to: pts[pts.length - 1]!.x };
}

/** Price labels under the chart, placed under the bars they describe: the range ends and both strikes. */
export function axisHtml(q: SpreadQuote, from: number, to: number, n = 14): string {
  const lo = Math.min(q.legs.K1, q.legs.K2), hi = Math.max(q.legs.K1, q.legs.K2);
  const at = (x: number) => ((((x - from) / (to - from)) * (n - 1) + 0.5) / n) * 100;
  return (
    `<div class="x-axis" aria-hidden="true"><span style="left:0">${h(price(from))}</span>` +
    `<span class="is-mid" style="left:${at(lo).toFixed(1)}%">${h(price(lo))}</span><span class="is-mid" style="left:${at(hi).toFixed(1)}%">${h(price(hi))}</span>` +
    `<span style="right:0">${h(price(to))}</span></div>`
  );
}

export interface ReviewModel {
  q: SpreadQuote;
  asset: string;
  target: number;
  dateLong: string;
  probability: number | null;
  netName: string;
  mainnet: boolean;
  subs: SubaccountInfo[]; // all subaccounts of the wallet
  selectedSub: number | null;
  assetRU: number | null;
  connected: boolean;
  balance: number | null;
  preTrade: { valid: boolean; reason: string | null; estFee: number | null } | null;
  createUrl: string;
  oneTap?: boolean; // orders signed by the one-tap session key
  maxCost?: number | null; // optional mainnet per-trade limit
  wallet?: string | null; // the Derive wallet address, when connected
}

const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const UP_IC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17l6-6 4 4 8-8M15 7h6v6"/></svg>';
const DN_IC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7l6 6 4-4 8 8M15 17h6v-6"/></svg>';
const MID_IC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h15M14 7l5 5-5 5"/></svg>';

export function reviewHtml(m: ReviewModel): string {
  const q = m.q, up = q.legs.dir === "up", spec = specOf(q);
  const midP = (q.legs.K1 + q.legs.K2) / 2;
  const ch = chartSvg(q);
  const li = q.legs.long.instrument.name, si = q.legs.short.instrument.name;
  const inRU = m.subs.filter((s) => s.riskUniverse === m.assetRU);
  const subRow = !m.connected
    ? `<div><dt>Subaccount</dt><dd class="x-muted">Connect your wallet</dd></div>`
    : inRU.length
      ? `<div><dt><label for="subPick">Subaccount</label></dt><dd><select id="subPick" class="x-pick">${inRU
          .map((s) => `<option value="${s.id}"${s.id === m.selectedSub ? " selected" : ""}>#${s.id} · ${h(usd2(s.value))}</option>`)
          .join("")}</select></dd></div>`
      : `<div><dt>Subaccount</dt><dd class="x-dn">None for ${h(m.asset)}</dd></div>`;
  const noSubHint =
    m.connected && !inRU.length
      ? `<p class="x-warn" id="noSubHint">${h(m.asset)} options settle in risk universe ${m.assetRU ?? "?"}. None of your subaccounts is in it. <button type="button" class="x-edit x-small" id="newSubBtn">Deposit into a new ${h(m.asset)} subaccount</button></p>`
      : "";
  const pre = m.preTrade
    ? m.preTrade.valid
      ? `<div><dt>Exchange check</dt><dd class="x-ok">Passes margin${m.preTrade.estFee !== null ? " · fee ≈ " + h(usd2(m.preTrade.estFee)) : ""}</dd></div>`
      : `<div><dt>Exchange check</dt><dd class="x-dn">${h(m.preTrade.reason || "Would be rejected")}</dd></div>`
    : "";
  const short = m.balance !== null && m.balance < q.worstLoss;
  const after = m.connected && m.balance !== null ? `<div data-bal><dt>Balance after</dt><dd${short ? ' class="x-dn"' : ""}>${short ? "Not enough collateral" : h(usd2(m.balance - q.maxLoss))}</dd></div>` : "";
  const midPl = profitAt(spec, midP);
  const slip = Math.round((Number(q.longLimit) / Number(q.longPrice) - 1) * 100);
  const left =
    `<div class="x-card x-pos-card"><div class="x-card__top"><span>Your position</span><button type="button" class="x-edit" id="edit">Edit</button></div>` +
    `<p class="x-rh">Make <mark class="x-m-amt">${h(money(q.maxProfit))}</mark> if ${h(m.asset)} ends ${up ? "above" : "below"} <mark class="x-m-tgt">${h(price(q.legs.K2))}</mark> by <mark class="x-m-date">${h(m.dateLong)}</mark></p>` +
    `<div class="x-outs">` +
    `<div class="x-out"><i class="is-up">${up ? UP_IC : DN_IC}</i>Ends ${up ? "above" : "below"} ${h(price(q.legs.K2))}<b class="x-up">${h(signedMoney(q.maxProfit))}</b></div>` +
    `<div class="x-out"><i class="is-mid">${MID_IC}</i>Ends at ${h(price(midP))}<b${midPl < 0 ? ' class="x-dn"' : ""}>${h(signedMoney(midPl))}</b></div>` +
    `<div class="x-out"><i class="is-dn">${up ? DN_IC : UP_IC}</i>Ends ${up ? "below" : "above"} ${h(price(q.legs.K1))}<b class="x-dn">${h(signedMoney(-q.maxLoss))}</b></div></div>` +
    `<p class="x-chcap">Profit or loss by ${h(m.asset)} price on ${h(m.dateLong)} · hover or tap the bars</p><div class="x-chart" id="chart">${ch.svg}<span class="x-tip" id="tip" role="status" hidden></span></div>` +
    axisHtml(q, ch.from, ch.to) +
    `<details class="x-ctr" id="contracts"><summary>Contracts<i aria-hidden="true"></i></summary>` +
    `<dl class="x-rows x-rows--tight"><div><dt>Buy</dt><dd>${h(q.amount)} <span class="x-mono">${h(li)}</span> @ ${h(usd2(Number(q.longPrice)))} ask</dd></div>` +
    `<div><dt>Sell</dt><dd>${h(q.amount)} <span class="x-mono">${h(si)}</span> @ ${h(usd2(Number(q.shortPrice)))} bid</dd></div>` +
    `<div><dt>Orders</dt><dd>Two fill-or-kill limit orders, one per leg</dd></div>` +
    `<div><dt>Price protection</dt><dd>Fills at the best book price, never above ${h(usd2(q.worstLoss))} (${slip}% slippage cap)</dd></div></dl></details></div>`;
  const rows =
    `<div><dt>Wallet</dt><dd${m.connected && m.wallet ? ' class="x-mono x-addr"' : ' class="x-muted"'}>${m.connected && m.wallet ? h(shortAddr(m.wallet)) : "Not connected"}</dd></div>` +
    subRow +
    `<div><dt>Contracts</dt><dd>${h(q.amount)} per leg</dd></div>` +
    `<div><dt>Premium (net debit)</dt><dd>${h(usd2(q.cost))}</dd></div>` +
    `<div><dt>Maximum profit</dt><dd class="x-up">${h(usd2(q.maxProfit))}</dd></div>` +
    `<div><dt>Maximum loss</dt><dd class="x-dn">${h(usd2(q.maxLoss))}</dd></div>` +
    `<div><dt>Derive fees</dt><dd>${h(usd2(q.fees))} · taker, both legs</dd></div>` +
    `<div><dt>Breakeven</dt><dd>${h(price(q.breakeven))}</dd></div>` +
    `<div><dt>Chance it happens</dt><dd>${m.probability === null ? "—" : h(pct(m.probability))} · at ${h(price(m.target))}</dd></div>` +
    (q.belowMinimum ? `<div><dt>Size</dt><dd>Exchange minimum (${h(q.amount)} contracts), so the payout is ${h(money(q.maxProfit))}</dd></div>` : "") +
    `<div><dt>Expires</dt><dd>${h(m.dateLong)} · 08:00 UTC</dd></div>` +
    (m.connected ? `<div><dt>Signed by</dt><dd id="signedBy">${m.oneTap ? "One-tap key (no wallet prompt)" : "Your wallet (3 prompts)"}</dd></div>` : "") +
    (m.mainnet && m.maxCost ? `<div><dt>Your limit</dt><dd>${h(money(m.maxCost))} per mainnet trade</dd></div>` : "") +
    pre +
    after +
    `<div><dt>Settlement</dt><dd>Cash settled · Derive margin rules</dd></div>`;
  return (
    `<div class="x-review">${left}<div class="x-rcol"><div class="x-card x-det-card"><dl class="x-rows">${rows}</dl>${noSubHint}</div>` +
    (m.mainnet
      ? `<div class="x-real" role="alert">Real money on Derive mainnet. Type <b>REAL MONEY</b> to enable Confirm.<input id="realIn" autocomplete="off" spellcheck="false" aria-label="Type REAL MONEY to confirm"></div>`
      : "") +
    `<label class="x-agree"><input type="checkbox" id="agree"><span>I understand this ${h(m.netName.toLowerCase())} spread settles in cash, the two legs are sent as separate fill-or-kill orders, and it is subject to Derive margin and liquidation rules.</span></label>` +
    `<button type="button" class="x-buy x-confirm" id="confirm" disabled>Tick the box to continue</button><p class="x-step" id="step" role="status"></p>` +
    (m.connected ? `<div class="x-sheet__btns" style="justify-content:center;margin-top:10px"><button type="button" class="x-edit x-small" id="checkOrder">Check order (no trade)</button></div><p class="x-step" id="checkStep" role="status"></p>` : "") +
    `</div></div>`
  );
}

/** The countdown ring inside Confirm: how long until the quote refreshes. */
export function ringHtml(secs: number, total = 10): string {
  const C = 2 * Math.PI * 11;
  const off = C * (1 - Math.max(0, Math.min(total, secs)) / total);
  return `<span class="x-ring" aria-label="Quote refreshes in ${secs} seconds"><svg viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="11" class="x-ring__bg"/><circle cx="13" cy="13" r="11" class="x-ring__fg" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/></svg><b>${secs}</b></span>`;
}

function legRow(label: string, o: OrderOutcome | null): string {
  if (!o) return "";
  const fills = o.fills.length ? o.fills.map((f) => `${f.amount} @ ${usd2(f.price)} (fee ${usd2(f.fee)})`).join("<br>") : "no fill";
  return `<tr><td>${h(label)}<br><span class="x-mono">${h(o.instrument)}</span></td><td>${h(o.direction)} ${o.amount}</td><td>${h(o.status)}${o.error ? `<br><span class="x-dn">${h(o.error)}</span>` : ""}</td><td>${fills}</td><td><code>${h(o.orderId ?? "—")}</code></td></tr>`;
}

export function resultHtml(r: SpreadResult, netName: string): string {
  const title = { filled: "Position opened", "not-filled": "Nothing was bought", unwound: "Order unwound", exposed: "One leg is still open" }[r.status];
  return (
    `<h2>${h(title)}</h2><p id="doneMsg">${h(r.message)} ${h(netName)}.</p>` +
    `<div class="x-card"><table class="x-tbl" id="fills"><thead><tr><th>Leg</th><th>Side</th><th>Status</th><th>Fills</th><th>Order id</th></tr></thead><tbody>` +
    legRow("Buy", r.long) +
    legRow("Sell", r.short) +
    legRow("Unwind", r.unwind) +
    `</tbody></table><dl class="x-rows"><div><dt>Net premium</dt><dd>${h(usd2(r.netDebit))}</dd></div><div><dt>Fees paid</dt><dd>${h(usd2(r.fees))}</dd></div></dl></div>` +
    `<div class="x-sheet__btns" style="justify-content:center"><button type="button" class="x-edit" id="toPort">Portfolio</button><button type="button" class="x-buy" id="again">Build another <span class="x-arr">→</span></button></div>`
  );
}

/** Group positions into spreads (same expiry/type, one long one short, equal size). */
export function pairSpreads(pos: Position[]): { pairs: [Position, Position][]; singles: Position[] } {
  const left = [...pos];
  const pairs: [Position, Position][] = [];
  for (let i = 0; i < left.length; i++) {
    const a = left[i]!;
    const pre = a.instrument.replace(/-[\d_.]+-([CP])$/, "-$1");
    const j = left.findIndex((b, k) => k !== i && b.instrument.replace(/-[\d_.]+-([CP])$/, "-$1") === pre && Math.abs(b.amount + a.amount) < 1e-9 && a.amount > 0);
    if (a.amount > 0 && j >= 0) {
      pairs.push([a, left[j]!]);
      left.splice(Math.max(i, j), 1);
      left.splice(Math.min(i, j), 1);
      i = -1;
    }
  }
  return { pairs, singles: left };
}

const WALLET_IC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7V5.5A1.5 1.5 0 0 0 18.5 4h-13A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V17"/><path d="M15 9h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-5a3 3 0 0 1 0-8z"/><circle cx="15.5" cy="13" r="1"/></svg>';

/** One empty state for Portfolio and History before a wallet is connected. */
export function connectEmptyHtml(what: "portfolio" | "history", netName: string): string {
  const [title, body] =
    what === "portfolio"
      ? ["Your positions live here", `Connect a wallet to see your Derive ${h(netName.toLowerCase())} positions, open orders and safety settings.`]
      : ["Your trade history lives here", `Connect a wallet to see closed spreads, trades and orders on Derive ${h(netName.toLowerCase())}.`];
  return `<div class="x-card x-emptycard" id="${what}Empty"><span class="x-emptyic">${WALLET_IC}</span><h2>${title}</h2><p class="x-empty">${body}</p><button type="button" class="x-buy" data-connect>Connect wallet <span class="x-arr">→</span></button></div>`;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "ETH-20261127-2500-C" → { asset ETH, date "Nov 27", strike 2500, type C }; null for other names. */
export function describeOption(name: string): { asset: string; date: string; strike: number; type: "C" | "P" } | null {
  const m = /^([A-Z0-9]+)-(\d{4})(\d{2})(\d{2})-([\d_.]+)-([CP])$/.exec(name);
  if (!m) return null;
  const mo = MON[Number(m[3]) - 1];
  if (!mo) return null;
  return { asset: m[1]!, date: `${mo} ${Number(m[4])}`, strike: Number(m[5]!.replace("_", ".")), type: m[6] as "C" | "P" };
}

export function portfolioHtml(sub: SubaccountInfo | null, netName: string, connected: boolean, o: { mainnet?: boolean; maxCost?: number | null; leverageCap?: number; leverageMax?: number; hasPositions?: boolean } = {}): string {
  if (!connected) return connectEmptyHtml("portfolio", netName);
  if (!sub) return `<div class="x-card"><h2>Portfolio</h2><p class="x-empty">No subaccount selected.</p></div>`;
  const { pairs, singles } = pairSpreads(sub.positions);
  const pnlB = (v: number) => `<b class="${v < 0 ? "x-dn" : "x-up"}">${h(v < 0 ? usd2(v) : "+" + usd2(v))}</b>`;
  const leg = (p: Position) =>
    `<div class="x-leg" data-leg><span><span class="x-mono">${h(p.instrument)}</span><small>${p.amount > 0 ? "Long" : "Short"} ${Math.abs(p.amount)} · avg ${h(usd2(p.averagePrice))} · mark ${h(usd2(p.markPrice))}</small></span>${pnlB(p.unrealizedPnl)}</div>`;
  const spreadCard = ([a, b]: [Position, Position]) => {
    const da = describeOption(a.instrument), db = describeOption(b.instrument);
    const name = da && db ? `${h(da.asset)} ${da.type === "C" ? "call" : "put"} spread · ${h(price(da.strike))} → ${h(price(db.strike))}` : "Spread";
    const pl = a.unrealizedPnl + b.unrealizedPnl;
    return `<article class="x-pos"><header><span><b>${name}</b><small>${da ? "Expires " + h(da.date) : ""} · ${Math.abs(a.amount)} per leg</small></span>${pnlB(pl)}</header>${leg(a)}${leg(b)}<div class="x-pos__acts"><button type="button" class="x-edit x-small" data-close-spread="${h(a.instrument)}|${h(b.instrument)}">Close spread</button></div></article>`;
  };
  const singleCard = (p: Position) => {
    const d = describeOption(p.instrument);
    const name = d ? `${h(d.asset)} ${h(price(d.strike))} ${d.type === "C" ? "call" : "put"}` : h(p.instrument);
    return `<article class="x-pos"><header><span><b>${name}</b><small>${d ? "Expires " + h(d.date) : ""}</small></span>${pnlB(p.unrealizedPnl)}</header>${leg(p)}<div class="x-pos__acts"><button type="button" class="x-edit x-small" data-close="${h(p.instrument)}">Close</button></div></article>`;
  };
  const rows = pairs.map(spreadCard).join("") + singles.map(singleCard).join("");
  const orders = sub.openOrders.length
    ? `<table class="x-tbl" id="orders"><thead><tr><th>Instrument</th><th>Side</th><th>Filled</th><th>Limit</th><th></th></tr></thead><tbody>${sub.openOrders
        .map(
          (o: OpenOrder) =>
            `<tr><td><span class="x-mono">${h(o.instrument)}</span></td><td>${h(o.direction)} ${o.amount}</td><td class="n">${o.filled}</td><td class="n">${h(usd2(o.limitPrice))}</td><td><button type="button" class="x-edit x-small" data-cancel="${h(o.orderId)}|${h(o.instrument)}">Cancel</button></td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="x-empty">No open orders.</p>`;
  return (
    `<div class="x-card"><h2>Positions · #${sub.id} · ${h(netName)}</h2>` +
    (sub.positions.length
      ? `<div class="x-poslist" id="positions">${rows}</div>`
      : `<p class="x-empty">No open positions.</p>`) +
    `</div><div class="x-card"><h2>Open orders</h2>${orders}<div class="x-sheet__btns" style="margin-top:10px;flex-wrap:wrap"><button type="button" class="x-edit x-kill" id="cancelAll">Cancel all orders</button><button type="button" class="x-edit x-kill" id="closeAllPos"${o.hasPositions ? "" : " disabled"}>Close all positions</button></div><p class="x-step">Cancel all also removes take-profits and stop-losses. Close all cancels everything first, then closes every option and perp position with reduce-only orders.</p></div>` +
    `<div class="x-card"><h2>Safety</h2><label for="maxCostIn">Optional limit per mainnet trade (USD). Empty = no limit. For perps it limits the money you put in.</label><input id="maxCostIn" class="x-in" inputmode="decimal" autocomplete="off" value="${o.maxCost ? h(String(o.maxCost)) : ""}" placeholder="No limit"><div class="x-sheet__btns" style="margin-top:8px"><button type="button" class="x-edit" id="maxCostSave">Save limit</button></div>` +
    `<label for="levCapIn">Perp leverage cap (1–${o.leverageMax ?? 10}×)</label><input id="levCapIn" class="x-in" inputmode="decimal" autocomplete="off" value="${h(String(o.leverageCap ?? 5))}"><div class="x-sheet__btns" style="margin-top:8px"><button type="button" class="x-edit" id="levCapSave">Save cap</button></div>` +
    `<p class="x-step">Mainnet trades always need REAL MONEY typed and enough collateral.${o.mainnet ? " You are on mainnet." : ""}</p></div>` +
    `<p class="x-step" id="portStep" role="status"></p>`
  );
}

// ---------- history ----------

const when = (ms: number) => (ms > 0 ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—");
const pnlCls = (v: number) => (v >= 0 ? "x-pnl-pos" : "x-pnl-neg");

export function historyHtml(m: { connected: boolean; netName: string; subId: number | null; spreads: ClosedSpread[]; closedSingles: LegSummary[]; trades: TradeRow[]; orders: OrderRow[]; loading: boolean; error: string | null }): string {
  if (!m.connected) return connectEmptyHtml("history", m.netName);
  if (m.subId === null) return `<div class="x-card"><h2>History</h2><p class="x-empty">No subaccount selected.</p></div>`;
  const total = m.spreads.reduce((s, x) => s + x.pnl, 0);
  const spreads = m.spreads.length
    ? `<table class="x-tbl" id="closedSpreads"><thead><tr><th>Spread</th><th>Size</th><th>Closed</th><th>Fees</th><th>P/L</th></tr></thead><tbody>${m.spreads
        .map((s) => `<tr><td><span class="x-mono">${h(s.long.instrument)}</span><br><span class="x-mono">−${h(s.short.instrument)}</span></td><td class="n">${s.size}</td><td>${h(when(s.closedAt))}</td><td class="n">${h(usd2(s.fees))}</td><td class="n ${pnlCls(s.pnl)}">${h(usd2(s.pnl))}</td></tr>`)
        .join("")}</tbody></table><p class="x-step" id="pnlTotal">Realised on closed spreads: <b class="${pnlCls(total)}">${h(usd2(total))}</b> (after fees)</p>`
    : `<p class="x-empty">No closed spreads yet. Spreads held to expiry settle in cash and are not trades, so they do not show here.</p>`;
  const singles = m.closedSingles.length ? `<p class="x-step">Other closed legs: ${m.closedSingles.map((l) => `${h(l.instrument)} ${h(usd2(l.pnl))}`).join(" · ")}</p>` : "";
  const trades = m.trades.length
    ? `<table class="x-tbl" id="trades"><thead><tr><th>Time</th><th>Instrument</th><th>Side</th><th>Price</th><th>Fee</th></tr></thead><tbody>${m.trades
        .slice(0, 50)
        .map((t) => `<tr><td>${h(when(t.timestamp))}</td><td><span class="x-mono">${h(t.instrument)}</span></td><td>${h(t.direction)} ${t.amount}</td><td class="n">${h(usd2(t.price))}</td><td class="n">${h(usd2(t.fee))}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="x-empty">No trades.</p>`;
  const orders = m.orders.length
    ? `<table class="x-tbl" id="orderHistory"><thead><tr><th>Time</th><th>Instrument</th><th>Side</th><th>Status</th><th>Order id</th></tr></thead><tbody>${m.orders
        .slice(0, 50)
        .map((o) => `<tr><td>${h(when(o.timestamp))}</td><td><span class="x-mono">${h(o.instrument)}</span></td><td>${h(o.direction)} ${o.filled}/${o.amount}</td><td>${h(o.status)}</td><td><code>${h(o.orderId)}</code></td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="x-empty">No orders.</p>`;
  return (
    `<div class="x-card"><h2>Closed spreads · #${m.subId} · ${h(m.netName)}</h2>${m.loading ? '<p class="x-step">Loading…</p>' : ""}${m.error ? `<p class="x-warn">${h(m.error)}</p>` : ""}${spreads}${singles}</div>` +
    `<div class="x-card"><h2>Trades</h2>${trades}</div><div class="x-card"><h2>Orders</h2>${orders}</div>`
  );
}

// ---------- deposit / withdraw / one-tap sheets ----------
export interface DepositSheetModel {
  mode: "new" | "existing";
  netName: string;
  mainnet: boolean;
  asset: string;
  riskUniverse: number | null;
  riskUniverseName: string;
  subId: number | null;
  walletUsdc: string | null;
  minDeposit: number;
  noAccount: boolean;
}

export function depositSheetHtml(m: DepositSheetModel): string {
  const title = m.mode === "new" ? (m.noAccount ? `Open your Derive ${m.netName.toLowerCase()} account` : `New ${m.asset} subaccount`) : `Deposit to #${m.subId}`;
  const why =
    m.mode === "new"
      ? `${h(m.asset)} options trade in risk universe ${m.riskUniverse ?? "?"} (${h(m.riskUniverseName)}). Your first deposit creates a subaccount there${m.noAccount ? " and your Derive account" : ""}. It is sent from your wallet on ${m.mainnet ? "Ethereum mainnet" : "Sepolia"}: an approval, then the deposit.`
      : `Adds USDC from your wallet to subaccount #${m.subId}: an approval if needed, then the deposit.`;
  return (
    `<h2>${h(title)}</h2><p>${why}</p>` +
    (m.noAccount ? `<p class="x-warn" id="noAccountNote">This wallet has no Derive account on ${h(m.netName.toLowerCase())} yet.</p>` : "") +
    `<label for="depAmt">Amount (USDC) · minimum $${m.minDeposit}</label><input id="depAmt" class="x-in" inputmode="decimal" autocomplete="off" placeholder="${m.mainnet ? "" : "1000"}">` +
    `<p class="x-step" id="depWallet">${m.walletUsdc === null ? "Reading your wallet…" : `In your wallet: ${h(m.walletUsdc)} USDC`}</p>` +
    `<div id="depPlan"></div>` +
    (m.mainnet ? `<div class="x-real" role="alert">Real money: this moves USDC from your wallet on Ethereum mainnet and costs gas. Type <b>REAL MONEY</b> to enable it.<input id="depReal" autocomplete="off" spellcheck="false" aria-label="Type REAL MONEY to confirm"></div>` : "") +
    `<div class="x-sheet__btns" style="margin:10px 0 8px"><button class="x-buy" type="button" id="depGo" disabled>Review deposit</button></div><p class="x-step" id="depStep" role="status"></p>`
  );
}

export function planHtml(steps: { label: string; state: "todo" | "now" | "done"; hash?: string; explorer: string }[], gas: string | null): string {
  return (
    `<ol class="x-steps" id="depSteps">${steps
      .map((s, i) => `<li class="${s.state === "done" ? "is-done" : s.state === "now" ? "is-now" : ""}"><span>${i + 1}. ${h(s.label)}</span>${s.hash ? `<a href="${h(s.explorer)}/tx/${h(s.hash)}" target="_blank" rel="noopener">tx ${h(s.hash.slice(0, 10))}…</a>` : ""}</li>`)
      .join("")}</ol>` + (gas ? `<p class="x-step" id="depGas">Network fee estimate: ${h(gas)}</p>` : "")
  );
}

export function withdrawSheetHtml(m: { subId: number; balance: number; owner: string; mainnet: boolean; netName: string }): string {
  return (
    `<h2>Withdraw from #${m.subId}</h2><p>Sends USDC back to your wallet <span class="x-mono">${h(m.owner)}</span> on ${m.mainnet ? "Ethereum mainnet" : "Sepolia"}. Signed by your wallet (the one-tap key cannot withdraw). Derive batches withdrawals, so it can take a while to arrive.</p>` +
    `<label for="wdAmt">Amount (USDC) · subaccount value ${h(usd2(m.balance))}</label><input id="wdAmt" class="x-in" inputmode="decimal" autocomplete="off">` +
    `<p class="x-step">Max Derive withdrawal fee: $1</p>` +
    (m.mainnet ? `<div class="x-real" role="alert">Real money withdrawal. Type <b>REAL MONEY</b> to enable it.<input id="wdReal" autocomplete="off" spellcheck="false" aria-label="Type REAL MONEY to confirm"></div>` : "") +
    `<div class="x-sheet__btns" style="margin:10px 0 8px"><button class="x-buy" type="button" id="wdGo">Withdraw</button></div><p class="x-step" id="wdStep" role="status"></p>`
  );
}

export function oneTapHtml(m: { subIds: number[]; hours: number; mainnet: boolean }): string {
  return (
    `<h2>Enable one-tap trading?</h2><p>Your wallet signs once to create a temporary trading key that lives only in this tab. For ${m.hours} hours it can place option orders on subaccount${m.subIds.length > 1 ? "s" : ""} #${m.subIds.join(", #")}, so a spread is one tap instead of three wallet prompts.</p>` +
    `<p>It cannot withdraw, transfer or change keys. Closing the tab forgets it; Disconnect revokes it.${m.mainnet ? " Every mainnet trade still needs REAL MONEY typed." : ""}</p>` +
    `<div class="x-sheet__btns" style="margin:10px 0 8px"><button class="x-buy" type="button" id="tapOn">Enable one-tap trading</button><button class="x-edit" type="button" id="tapLater">Not now</button></div><p class="x-step" id="tapStep" role="status"></p>`
  );
}
