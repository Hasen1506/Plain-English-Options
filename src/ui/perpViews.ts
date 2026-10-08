// HTML builders for the Perps tab, perp positions in Portfolio and perp P&L in
// History. Pure, escaped string functions (unit-tested without a DOM).

import { escapeHtml as h, usd2 } from "../lib/format.ts";
import { fundingApr, maxLossWords, moveTo, type PerpMarket, type PerpQuote, type PerpTicker } from "../lib/perp.ts";
import type { Position } from "../lib/ticker.ts";
import type { VenueAccount, VenueTrigger } from "../venues/types.ts";
import type { PerpHistoryRow } from "../lib/perpHistory.ts";

/** Price with enough digits for every perp: $2,568.57 · $25.31 · $0.1177. */
export function perpPrice(v: number | null | undefined): string {
  if (v == null || !(v > 0) || !Number.isFinite(v)) return "—";
  if (v >= 1) return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: v >= 100 ? 2 : 4 });
  return "$" + Number(v.toPrecision(4)).toString();
}

export const pctSigned = (f: number | null | undefined, dp = 1): string => (f == null || !Number.isFinite(f) ? "—" : (f >= 0 ? "+" : "−") + Math.abs(f * 100).toFixed(dp) + "%");

/** Funding per hour and annualised, e.g. "+0.0013%/h · +10.9%/yr". */
export function fundingText(rph: number | null | undefined): string {
  if (rph == null || !Number.isFinite(rph)) return "—";
  return `${pctSigned(rph, 4)}/h · ${pctSigned(fundingApr(rph), 1)}/yr`;
}

const compact = (v: number | null): string => {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  return a >= 1e9 ? (v / 1e9).toFixed(2) + "B" : a >= 1e6 ? (v / 1e6).toFixed(2) + "M" : a >= 1e3 ? (v / 1e3).toFixed(1) + "k" : v.toFixed(a >= 10 ? 0 : 2);
};

export function marketsHtml(insts: PerpMarket[], tk: Record<string, PerpTicker>, selected: string): string {
  if (!insts.length) return `<p class="x-empty" id="perpMarketsEmpty">Loading perpetual markets…</p>`;
  const rows = insts
    .map((i) => {
      const t = tk[i.name];
      const ch = t?.change24h ?? null;
      const oi = t?.openInterest != null && t.mark > 0 ? t.openInterest * t.mark : null;
      return (
        `<tr data-perp="${h(i.name)}"${i.name === selected ? ' class="is-sel" aria-selected="true"' : ""}><td><button type="button" class="x-link" data-pick="${h(i.name)}"><b>${h(i.currency)}</b><span class="x-mono">-PERP</span></button></td>` +
        `<td class="n">${h(perpPrice(t?.mark))}</td><td class="n x-hide-s">${h(perpPrice(t?.index))}</td>` +
        `<td class="n ${ch == null ? "" : ch >= 0 ? "x-up" : "x-dn"}">${h(pctSigned(ch))}</td>` +
        `<td class="n">${h(t ? fundingText(t.fundingRate) : "—")}</td>` +
        `<td class="n x-hide-s">${oi === null ? "—" : "$" + h(compact(oi))}</td>` +
        `<td class="n x-hide-s">${h(String(Math.floor(i.maxLeverage * 100) / 100))}×</td></tr>`
      );
    })
    .join("");
  return `<table class="x-tbl" id="perpMarkets"><thead><tr><th>Market</th><th>Mark</th><th class="x-hide-s">Index</th><th>24h</th><th>Funding</th><th class="x-hide-s">Open interest</th><th class="x-hide-s">Max</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export interface PerpPanelModel {
  q: PerpQuote | null;
  fail: string | null;
  ticker: PerpTicker | null;
  asset: string;
  venueName: string;
  netName: string;
  mainnet: boolean;
  connected: boolean;
  accounts: VenueAccount[]; // accounts that can trade this market
  accountScope: string | null; // "risk universe 1 (PRIME)"
  selectedSub: number | null;
  subValue: number | null;
  margin: { valid: boolean; postIM: number | null } | null;
  oneTap: boolean;
  triggersNeedWallet: boolean;
  canTrigger: boolean;
  maxCost: number | null;
  leverageCap: number;
}

export function perpPanelHtml(m: PerpPanelModel): string {
  const q = m.q;
  const subRow = !m.connected
    ? `<div><dt>Subaccount</dt><dd>Connect your wallet</dd></div>`
    : m.accounts.length
      ? `<div><dt><label for="perpSub">Subaccount</label></dt><dd><select id="perpSub" class="x-pick">${m.accounts.map((s) => `<option value="${s.id}"${s.id === m.selectedSub ? " selected" : ""}>#${s.id} · ${h(usd2(s.value))}</option>`).join("")}</select>${m.accountScope ? `<br><small>${h(m.venueName)} · ${h(m.accountScope)}</small>` : ""}</dd></div>`
      : `<div><dt>Subaccount</dt><dd class="x-dn" id="perpNoSub">None in ${h(m.accountScope ?? "this market's account")} <button type="button" class="x-edit x-small" id="perpNewSub">Deposit into a new one</button></dd></div>`;
  if (!q) {
    return `<div class="x-card" id="perpDetails"><p class="x-empty" id="perpFail">${h(m.fail ?? "Waiting for a live price")}</p><dl class="x-rows">${subRow}</dl></div>`;
  }
  const side = q.dir === "long" ? "Buy" : "Sell";
  const prompts = (m.oneTap ? 0 : 1) + (q.takeProfit || q.stopLoss ? (m.triggersNeedWallet ? (q.takeProfit ? 1 : 0) + (q.stopLoss ? 1 : 0) : 0) : 0);
  const signedBy = m.oneTap ? (prompts ? `One-tap key for the order · your wallet for TP/SL (${prompts} prompt${prompts > 1 ? "s" : ""}, they last 30 days)` : "One-tap key (no wallet prompt)") : `Your wallet (${prompts} prompt${prompts > 1 ? "s" : ""})`;
  const margin = m.margin
    ? m.margin.valid
      ? `<div><dt>Exchange check</dt><dd class="x-ok" id="perpMarginOk">Passes margin${m.margin.postIM !== null ? ` · ${h(usd2(m.margin.postIM))} free after` : ""}</dd></div>`
      : `<div><dt>Exchange check</dt><dd class="x-dn" id="perpMarginBad">Not enough margin for this size</dd></div>`
    : "";
  const fundingHr = q.fundingHourly;
  const rows =
    `<div><dt>Size</dt><dd id="perpSize">${side} ${h(q.amount)} <span class="x-mono">${h(q.inst.name)}</span> · ${h(usd2(q.notional))} position</dd></div>` +
    `<div><dt>Leverage</dt><dd>${q.leverage.toFixed(2)}× on ${h(usd2(q.putIn))} put in · cap ${m.leverageCap}×</dd></div>` +
    `<div><dt>${q.orderType === "market" ? "Expected entry" : "Limit price"}</dt><dd id="perpEntry">${h(perpPrice(q.entry))}${q.orderType === "market" ? ` · ${q.side === "buy" ? "ask" : "bid"} now` : q.tif === "post_only" ? " · post-only (maker)" : " · good till cancelled"}</dd></div>` +
    (q.orderType === "market" ? `<div><dt>Price protection</dt><dd>Never fills worse than ${h(perpPrice(Number(q.limitPrice)))} (${pctSigned(Number(q.limitPrice) / q.entry - 1, 2)})</dd></div>` : "") +
    `<div><dt>Liquidation</dt><dd id="perpLiq"${q.liqPrice !== null && Math.abs(q.liqMove ?? 1) < 0.1 ? ' class="x-dn"' : ""}>${q.liqPrice === null ? (m.connected ? "None at this size (cross margin)" : "Connect to see") : `${h(perpPrice(q.liqPrice))} (${pctSigned(q.liqMove)})`}</dd></div>` +
    `<div><dt>Est. fees</dt><dd id="perpFee">${h(usd2(q.estFee))} ${q.orderType === "limit" && q.tif === "post_only" ? "maker" : "taker"} · ${(q.orderType === "limit" ? q.inst.makerFeeRate : q.inst.takerFeeRate) * 100}% + ${h(usd2(q.inst.baseFee))}</dd></div>` +
    `<div><dt>Funding</dt><dd id="perpFunding">${h(fundingText(q.fundingRate))}${fundingHr !== null ? ` · you ${fundingHr >= 0 ? "receive" : "pay"} ≈ ${h(usd2(Math.abs(fundingHr)))}/h` : ""}</dd></div>` +
    `<div><dt>Margin used</dt><dd>${h(usd2(q.marginUsed))} initial (${(q.inst.imReq * 100).toFixed(1)}% of size)</dd></div>` +
    (q.takeProfit ? `<div><dt>Take-profit</dt><dd class="x-up">${h(perpPrice(Number(q.takeProfit)))} · ≈ +${h(usd2(Math.max(0, q.gainAtTp ?? 0)))}</dd></div>` : "") +
    (q.stopLoss ? `<div><dt>Stop-loss</dt><dd class="x-dn">${h(perpPrice(Number(q.stopLoss)))} · ≈ −${h(usd2(Math.max(0, q.lossAtSl ?? 0)))}</dd></div>` : "") +
    subRow +
    (m.connected ? `<div><dt>Signed by</dt><dd id="perpSignedBy">${h(signedBy)}</dd></div>` : "") +
    (m.mainnet && m.maxCost ? `<div><dt>Your limit</dt><dd>${h(usd2(m.maxCost))} put in per mainnet trade</dd></div>` : "") +
    margin;
  const notes = [...q.problems.map((p) => `<li class="x-dn">${h(p)}</li>`), ...q.warnings.map((w) => `<li>${h(w)}</li>`)].join("");
  return (
    `<div class="x-card" id="perpDetails"><p class="x-loss" id="perpLoss">${h(maxLossWords(q, m.asset, m.subValue))}</p>` +
    (notes ? `<ul class="x-notes" id="perpNotes">${notes}</ul>` : "") +
    `<dl class="x-rows">${rows}</dl></div>`
  );
}

export function perpConfirmHtml(m: { mainnet: boolean; netName: string; connected: boolean; dryRun?: boolean }): string {
  return (
    (m.mainnet ? `<div class="x-real" role="alert">Real money on Derive mainnet. Type <b>REAL MONEY</b> to enable Confirm.<input id="perpReal" autocomplete="off" spellcheck="false" aria-label="Type REAL MONEY to confirm"></div>` : "") +
    `<label class="x-agree"><input type="checkbox" id="perpAgree"><span>I understand perpetuals use leverage on my whole ${h(m.netName.toLowerCase())} subaccount (cross margin), pay or receive funding every hour, and can be liquidated under Derive's rules.</span></label>` +
    `<button type="button" class="x-buy x-confirm" id="perpConfirm" disabled>Tick the box to continue</button><p class="x-step" id="perpStep" role="status"></p>` +
    (m.connected && m.dryRun !== false ? `<div class="x-sheet__btns" style="justify-content:center;margin-top:10px"><button type="button" class="x-edit x-small" id="perpCheck">Check order (no trade)</button></div><p class="x-step" id="perpCheckStep" role="status"></p>` : "")
  );
}

// ---------- portfolio ----------

export interface PerpPortfolioModel {
  sub: VenueAccount & { id: number };
  triggers: VenueTrigger[];
  tickers: Record<string, PerpTicker>;
}

/** Share of the subaccount value used by maintenance requirements (1 = liquidation). */
export function marginUsage(sub: Pick<VenueAccount, "value" | "maintenanceMargin">): number | null {
  if (!(sub.value > 0)) return null;
  return Math.min(1.5, Math.max(0, (sub.value - sub.maintenanceMargin) / sub.value));
}

export function perpPositionsHtml(m: PerpPortfolioModel): string {
  const perps = m.sub.positions.filter((p) => p.instrumentType === "perp" || /-PERP$/.test(p.instrument));
  const usage = marginUsage(m.sub);
  const level = usage === null ? "" : usage >= 0.8 ? "x-dn" : usage >= 0.5 ? "x-warn-t" : "x-up";
  const warn =
    m.sub.underLiquidation
      ? `<p class="x-warn" id="marginWarn">This subaccount is being liquidated.</p>`
      : usage !== null && usage >= 0.5
        ? `<p class="x-warn" id="marginWarn">${usage >= 0.8 ? "Danger: " : ""}${Math.round(usage * 100)}% of your maintenance margin is used. At 100% Derive liquidates. Add collateral or reduce positions.</p>`
        : "";
  const row = (p: Position) => {
    const t = m.tickers[p.instrument];
    const funding = p.cumulativeFunding + p.pendingFunding;
    const mark = t?.mark ?? p.markPrice;
    const dist = moveTo(mark, p.liquidationPrice);
    const near = dist !== null && Math.abs(dist) < 0.1;
    return (
      `<tr data-perp-pos="${h(p.instrument)}"><td><span class="x-mono">${h(p.instrument)}</span><br><b class="${p.amount > 0 ? "x-up" : "x-dn"}">${p.amount > 0 ? "Long" : "Short"} ${Math.abs(p.amount)}</b></td>` +
      `<td class="n">${h(perpPrice(p.averagePrice))}<br><small>${h(perpPrice(mark))}</small></td>` +
      `<td class="n ${p.unrealizedPnl < 0 ? "x-dn" : "x-up"}">${h(usd2(p.unrealizedPnl))}</td>` +
      `<td class="n ${funding < 0 ? "x-dn" : ""}" title="settled ${h(usd2(p.cumulativeFunding))}, pending ${h(usd2(p.pendingFunding))}">${h(usd2(funding))}</td>` +
      `<td class="n${near ? " x-dn" : ""}">${p.liquidationPrice === null ? "none" : `${h(perpPrice(p.liquidationPrice))}<br><small>${h(pctSigned(dist))}</small>`}</td>` +
      `<td class="x-acts"><button type="button" class="x-edit x-small" data-perp-close="${h(p.instrument)}">Close</button><button type="button" class="x-edit x-small" data-perp-half="${h(p.instrument)}">Close ½</button><button type="button" class="x-edit x-small" data-perp-flip="${h(p.instrument)}">Flip</button></td></tr>`
    );
  };
  const trig = m.triggers.length
    ? `<table class="x-tbl" id="perpTriggers"><thead><tr><th>Take-profit / stop-loss</th><th>Side</th><th>Trigger (mark)</th><th></th></tr></thead><tbody>${m.triggers
        .map((t) => `<tr><td><span class="x-mono">${h(t.instrument)}</span> ${h(t.triggerType === "takeprofit" ? "take-profit" : t.triggerType === "stoploss" ? "stop-loss" : t.triggerType)}</td><td>${h(t.direction)} ${t.amount}</td><td class="n">${h(perpPrice(t.triggerPrice))}</td><td><button type="button" class="x-edit x-small" data-cancel-trigger="${h(t.orderId)}">Cancel</button></td></tr>`)
        .join("")}</tbody></table>`
    : "";
  return (
    `<div class="x-card" id="perpPortfolio"><h2>Perpetuals · #${m.sub.id}</h2>` +
    (usage !== null ? `<p class="x-step" id="marginUsage">Margin used: <b class="${level}">${Math.round(usage * 100)}%</b> of maintenance · ${h(usd2(m.sub.maintenanceMargin))} left before liquidation</p>` : "") +
    warn +
    (perps.length
      ? `<table class="x-tbl" id="perpPositions"><thead><tr><th>Position</th><th>Entry / mark</th><th>Unrealised</th><th>Funding</th><th>Liquidation</th><th></th></tr></thead><tbody>${perps.map(row).join("")}</tbody></table>`
      : `<p class="x-empty">No perp positions.</p>`) +
    trig +
    `</div>`
  );
}

// ---------- history ----------

export function perpHistoryHtml(rows: PerpHistoryRow[], total: number, fundingError: string | null): string {
  if (!rows.length) return `<div class="x-card" id="perpHistory"><h2>Perpetuals</h2><p class="x-empty">No perp trades yet.</p>${fundingError ? `<p class="x-warn">${h(fundingError)}</p>` : ""}</div>`;
  const cls = (v: number) => (v >= 0 ? "x-pnl-pos" : "x-pnl-neg");
  return (
    `<div class="x-card" id="perpHistory"><h2>Perpetuals</h2><table class="x-tbl" id="perpPnl"><thead><tr><th>Market</th><th>Trades</th><th>Realised</th><th>Fees</th><th>Funding</th><th>Net</th></tr></thead><tbody>${rows
      .map(
        (r) =>
          `<tr><td><span class="x-mono">${h(r.instrument)}</span>${Math.abs(r.size) > 1e-12 ? `<br><small>${r.size > 0 ? "long" : "short"} ${Math.abs(r.size)} still open</small>` : ""}</td><td class="n">${r.trades}</td><td class="n ${cls(r.realized)}">${h(usd2(r.realized))}</td><td class="n">${h(usd2(r.fees))}</td><td class="n ${cls(r.funding)}">${h(usd2(r.funding))}</td><td class="n ${cls(r.net)}">${h(usd2(r.net))}</td></tr>`,
      )
      .join("")}</tbody></table><p class="x-step" id="perpPnlTotal">Perps realised after fees and funding: <b class="${cls(total)}">${h(usd2(total))}</b></p>${fundingError ? `<p class="x-warn">${h(fundingError)}</p>` : ""}</div>`
  );
}
