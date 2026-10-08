// HTML builders for the review, result and portfolio screens. Pure string
// functions (escaped), so they can be unit-tested without a DOM.

import type { SpreadQuote } from "../lib/spread.ts";
import { chartPoints, profitAt, type PayoffSpec } from "../lib/payoff.ts";
import { escapeHtml as h, money, pct, price, signedMoney, usd2 } from "../lib/format.ts";
import type { SpreadResult, OrderOutcome } from "../net/trader.ts";
import type { OpenOrder, Position, SubaccountInfo } from "../lib/ticker.ts";

export const specOf = (q: SpreadQuote): PayoffSpec => ({ dir: q.legs.dir, K1: q.legs.K1, K2: q.legs.K2, n: q.n, cost: q.cost, fees: q.fees });

export function chartSvg(q: SpreadQuote): { svg: string; pts: { x: number; pl: number }[]; from: number; to: number } {
  const spec = specOf(q);
  const pts = chartPoints(spec, 14);
  const maxUp = Math.max(1e-9, ...pts.map((p) => p.pl));
  const maxDn = Math.max(1e-9, ...pts.map((p) => -p.pl));
  const H = 160, mid = H * (maxUp / (maxUp + maxDn)), bw = 600 / pts.length;
  const bars = pts
    .map((p, i) => {
      const hgt = Math.max(2, p.pl >= 0 ? (p.pl / maxUp) * (mid - 6) : (-p.pl / maxDn) * (H - mid - 6));
      const y = p.pl >= 0 ? mid - hgt : mid;
      return `<rect data-i="${i}" x="${(i * bw + 4).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 8).toFixed(1)}" height="${hgt.toFixed(1)}" rx="6" fill="${p.pl >= 0 ? "#5BD08A" : "#F2A39B"}"><title>${h(price(p.x))} · ${h(signedMoney(p.pl))}</title></rect>`;
    })
    .join("");
  const svg = `<svg viewBox="0 0 600 ${H}" role="img" aria-label="Profit or loss by price at expiry">${bars}<line x1="0" x2="600" y1="${mid.toFixed(1)}" y2="${mid.toFixed(1)}" stroke="#151515" stroke-width="2"/></svg>`;
  return { svg, pts, from: pts[0]!.x, to: pts[pts.length - 1]!.x };
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
}

export function reviewHtml(m: ReviewModel): string {
  const q = m.q, up = q.legs.dir === "up", spec = specOf(q);
  const midP = (q.legs.K1 + q.legs.K2) / 2;
  const ch = chartSvg(q);
  const li = q.legs.long.instrument.name, si = q.legs.short.instrument.name;
  const inRU = m.subs.filter((s) => s.riskUniverse === m.assetRU);
  const subRow = !m.connected
    ? `<div><dt>Subaccount</dt><dd>Connect your wallet</dd></div>`
    : inRU.length
      ? `<div><dt><label for="subPick">Subaccount</label></dt><dd><select id="subPick" class="x-pick">${inRU
          .map((s) => `<option value="${s.id}"${s.id === m.selectedSub ? " selected" : ""}>#${s.id} · ${h(usd2(s.value))}</option>`)
          .join("")}</select></dd></div>`
      : `<div><dt>Subaccount</dt><dd class="x-dn">None for ${h(m.asset)}</dd></div>`;
  const noSubHint =
    m.connected && !inRU.length
      ? `<p class="x-warn" id="noSubHint">${h(m.asset)} options settle in risk universe ${m.assetRU ?? "?"}. None of your subaccounts is in it. <a href="${h(m.createUrl)}" target="_blank" rel="noopener">Create a subaccount in this universe on Derive</a> by depositing into a new ${h(m.asset)} subaccount, then reconnect.</p>`
      : "";
  const pre = m.preTrade
    ? m.preTrade.valid
      ? `<div><dt>Exchange check</dt><dd class="x-ok">Passes margin${m.preTrade.estFee !== null ? " · fee ≈ " + h(usd2(m.preTrade.estFee)) : ""}</dd></div>`
      : `<div><dt>Exchange check</dt><dd class="x-dn">${h(m.preTrade.reason || "Would be rejected")}</dd></div>`
    : "";
  const after = m.connected && m.balance !== null ? `<div data-bal><dt>Balance after</dt><dd${m.balance < q.maxLoss ? ' class="x-dn"' : ""}>${m.balance < q.maxLoss ? "Not enough collateral" : h(usd2(m.balance - q.maxLoss))}</dd></div>` : "";
  return (
    `<div class="x-review"><div class="x-card"><div class="x-card__top"><span>Your position</span><button type="button" class="x-edit" id="edit">Edit</button></div>` +
    `<p class="x-rh">Make <mark style="background:#F3DE9A">${h(money(q.maxProfit))}</mark> if ${h(m.asset)} ends ${up ? "above" : "below"} <mark style="background:#BDEFCB">${h(price(q.legs.K2))}</mark> by <mark style="background:#D9D6FB">${h(m.dateLong)}</mark></p>` +
    `<div class="x-outs"><div class="x-out"><i style="background:#BDEFCB">${up ? "↗" : "↘"}</i>Ends ${up ? "above" : "below"} ${h(price(q.legs.K2))}<b class="x-up">${h(signedMoney(q.maxProfit))}</b></div>` +
    `<div class="x-out"><i style="background:#EEEDEA">→</i>Ends at ${h(price(midP))}<b${profitAt(spec, midP) < 0 ? ' class="x-dn"' : ""}>${h(signedMoney(profitAt(spec, midP)))}</b></div>` +
    `<div class="x-out"><i style="background:#F7C6BC">${up ? "↘" : "↗"}</i>Ends ${up ? "below" : "above"} ${h(price(q.legs.K1))}<b class="x-dn">${h(signedMoney(-q.maxLoss))}</b></div></div>` +
    `<p class="x-chcap">Profit or loss by ${h(m.asset)} price on ${h(m.dateLong)} · tap the bars</p><div class="x-chart" id="chart">${ch.svg}<span class="x-tip" id="tip" hidden></span></div>` +
    `<div class="x-axis"><span>${h(price(ch.from))}</span><span>${h(price((ch.from + ch.to) / 2))}</span><span>${h(price(ch.to))}</span></div></div>` +
    `<div><div class="x-card"><dl class="x-rows">` +
    `<div><dt>Contracts</dt><dd>Buy ${h(q.amount)} <span class="x-mono">${h(li)}</span> @ ${h(usd2(Number(q.longPrice)))} ask<br>Sell ${h(q.amount)} <span class="x-mono">${h(si)}</span> @ ${h(usd2(Number(q.shortPrice)))} bid</dd></div>` +
    `<div><dt>Premium (net debit)</dt><dd>${h(usd2(q.cost))}</dd></div>` +
    `<div><dt>Derive fees</dt><dd>${h(usd2(q.fees))} · taker, both legs</dd></div>` +
    `<div><dt>Maximum loss</dt><dd class="x-dn">${h(usd2(q.maxLoss))}</dd></div>` +
    `<div><dt>Maximum profit</dt><dd class="x-up">${h(usd2(q.maxProfit))}</dd></div>` +
    `<div><dt>Breakeven</dt><dd>${h(price(q.breakeven))}</dd></div>` +
    `<div><dt>Chance it happens</dt><dd>${m.probability === null ? "—" : h(pct(m.probability))} · at ${h(price(m.target))}</dd></div>` +
    (q.belowMinimum ? `<div><dt>Size</dt><dd>Exchange minimum (${h(q.amount)} contracts), so the payout is ${h(money(q.maxProfit))}</dd></div>` : "") +
    `<div><dt>Expires</dt><dd>${h(m.dateLong)} · 08:00 UTC</dd></div>` +
    subRow +
    pre +
    after +
    `<div><dt>Settlement</dt><dd>Cash settled · Derive margin rules</dd></div></dl>${noSubHint}</div>` +
    (m.mainnet
      ? `<div class="x-real" role="alert">Real money on Derive mainnet. Type <b>REAL MONEY</b> to enable Confirm.<input id="realIn" autocomplete="off" spellcheck="false" aria-label="Type REAL MONEY to confirm"></div>`
      : "") +
    `<label class="x-agree"><input type="checkbox" id="agree"><span>I understand this ${h(m.netName.toLowerCase())} spread settles in cash, the two legs are sent as separate fill-or-kill orders, and it is subject to Derive margin and liquidation rules.</span></label>` +
    `<button type="button" class="x-buy x-confirm" id="confirm" disabled>Tick the box to continue</button><p class="x-step" id="step" role="status"></p></div></div>`
  );
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

export function portfolioHtml(sub: SubaccountInfo | null, netName: string, connected: boolean): string {
  if (!connected) return `<div class="x-card"><h2>Portfolio</h2><p class="x-empty">Connect your wallet to see positions and open orders on ${h(netName)}.</p></div>`;
  if (!sub) return `<div class="x-card"><h2>Portfolio</h2><p class="x-empty">No subaccount selected.</p></div>`;
  const { pairs, singles } = pairSpreads(sub.positions);
  const posRow = (p: Position, close: boolean) =>
    `<tr><td><span class="x-mono">${h(p.instrument)}</span></td><td class="n">${p.amount}</td><td class="n">${h(usd2(p.averagePrice))}</td><td class="n">${h(usd2(p.markPrice))}</td><td class="n${p.unrealizedPnl < 0 ? " x-dn" : " x-up"}">${h(usd2(p.unrealizedPnl))}</td><td>${close ? `<button type="button" class="x-edit x-small" data-close="${h(p.instrument)}">Close</button>` : ""}</td></tr>`;
  const rows =
    pairs
      .map(
        ([a, b]) =>
          posRow(a, false) +
          posRow(b, false).replace("<td></td></tr>", `<td><button type="button" class="x-edit x-small" data-close-spread="${h(a.instrument)}|${h(b.instrument)}">Close spread</button></td></tr>`),
      )
      .join("") + singles.map((p) => posRow(p, true)).join("");
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
      ? `<table class="x-tbl" id="positions"><thead><tr><th>Instrument</th><th>Size</th><th>Avg</th><th>Mark</th><th>P/L</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : `<p class="x-empty">No open positions.</p>`) +
    `</div><div class="x-card"><h2>Open orders</h2>${orders}</div><p class="x-step" id="portStep" role="status"></p>`
  );
}
