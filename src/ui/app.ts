// DOM controller: wires the pure modules to the page.

import { ASSETS, NETWORKS, QUOTE_MAX_AGE_MS, TICKER_REFRESH_MS, type Asset, type NetworkId } from "../config.ts";
import { DeriveClient, type Status } from "../net/client.ts";
import { walletSigner, type ActionSigner, type Eip1193 } from "../net/signer.ts";
import { cancelOrder, closePosition, closeSpread, placeSpread, preTradeCheck, type PreTrade, type SpreadResult } from "../net/trader.ts";
import {
  parseCurrencies,
  parseInstrument,
  parseInstruments,
  parseSubaccount,
  parseTicker,
  parseTickers,
  type CurrencyInfo,
  type Instrument,
  type SubaccountInfo,
  type Ticker,
} from "../lib/ticker.ts";
import { initialState, reduce, sentence, type Action, type BuilderState, type Pop, type QuoteResult } from "../lib/state.ts";
import { expiriesFor, liveQuote, probabilityFor, spotOf } from "../lib/market.ts";
import { confirmState } from "../lib/guards.ts";
import { escapeHtml as h, money, pct, price, signedMoney, usd2, type ExpiryLabel } from "../lib/format.ts";
import { chartSvg, portfolioHtml, resultHtml, reviewHtml } from "./views.ts";

type View = "build" | "review" | "done" | "portfolio";
type WalletSt = "none" | "busy" | "on" | "reconnect" | "err" | "nosub";

interface TkEntry {
  tk: Record<string, Ticker>;
  at: number; // local fetch time
  busy: boolean;
  failed: boolean;
}

export interface AppOptions {
  wsOverride?: string | null; // e2e builds only
  now?: () => number;
  ethereum?: Eip1193 | null;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const UP = '<path d="M3 17l6-6 4 4 8-8M15 7h6v6"/>', DN = '<path d="M3 7l6 6 4-4 8 8M15 17h6v-6"/>';

export function startApp(opts: AppOptions = {}) {
  const now = opts.now ?? Date.now;
  const eth = () => (opts.ethereum !== undefined ? opts.ethereum : ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null));

  let net: NetworkId = "testnet";
  let client: DeriveClient;
  let wsStatus: Status = "connecting";
  let S: BuilderState = initialState("ETH");
  let view: View = "build";
  let gen = 0;

  const currencies: Record<string, CurrencyInfo> = {};
  const inst: Partial<Record<Asset, Instrument[]>> = {};
  const instLoaded: Partial<Record<Asset, boolean>> = {};
  const perp: Partial<Record<Asset, Ticker>> = {};
  const TK: Record<string, TkEntry> = {};

  const W = { st: "none" as WalletSt, account: "", signer: null as ActionSigner | null, subs: [] as SubaccountInfo[], sel: null as number | null, msg: "" };
  const R = { agreed: false, typed: "", busy: false, pre: null as PreTrade | null, preKey: "", step: "" };

  // ---------- market data ----------
  const expiries = (): ExpiryLabel[] => expiriesFor(inst[S.asset] ?? [], now());
  const curExpiry = (): ExpiryLabel | null => expiries().find((e) => e.key === S.expiryKey) ?? null;
  const tkKey = (a: string, k: string) => `${a}|${k}`;
  const curTk = (): TkEntry | null => (S.expiryKey ? (TK[tkKey(S.asset, S.expiryKey)] ?? null) : null);
  const assetRU = (a: Asset = S.asset): number | null => currencies[a]?.riskUniverse ?? null;

  function spotFor(a: Asset): number | null {
    const e = S.asset === a ? curTk() : null;
    const s = e ? spotOf(e.tk).spot : null;
    return s ?? perp[a]?.index ?? currencies[a]?.spot ?? null;
  }
  function change24(a: Asset): number | null {
    return perp[a]?.change24h ?? currencies[a]?.change24h ?? null;
  }

  function quote(): QuoteResult & { spot: number | null } {
    const e = curTk(), ex = curExpiry();
    const r = liveQuote(S, inst[S.asset] ?? [], e && Object.keys(e.tk).length ? e.tk : null, ex ? ex.expiryMs : null, now());
    return { ...r, spot: r.spot ?? spotFor(S.asset) };
  }

  function fetchTk(a: Asset, key: string, force = false) {
    const k = tkKey(a, key);
    const e = (TK[k] ??= { tk: {}, at: 0, busy: false, failed: false });
    if (e.busy || (!force && now() - e.at < TICKER_REFRESH_MS)) return;
    e.busy = true;
    const g = gen;
    client
      .call("public/get_tickers", { currency: a, instrument_type: "option", expiry_date: Number(key) })
      .then((r) => {
        if (g !== gen) return;
        e.tk = parseTickers(r);
        e.at = now();
        e.failed = false;
        const sp = spotOf(e.tk).spot;
        if (a === S.asset && sp) dispatch({ type: "spot", spot: sp });
        else if (a === S.asset) refresh();
      })
      .catch(() => {
        if (g !== gen) return;
        e.failed = true;
        e.at = now();
        if (a === S.asset) refresh();
      })
      .finally(() => {
        e.busy = false;
      });
  }

  function loadInstruments(a: Asset) {
    const g = gen;
    client
      .getAllInstruments(a)
      .then((raw) => {
        if (g !== gen) return;
        inst[a] = parseInstruments({ instruments: raw });
        instLoaded[a] = true;
        if (a === S.asset) syncExpiries();
      })
      .catch(() => {
        if (g === gen) instLoaded[a] = true;
      });
  }

  function loadPerp(a: Asset) {
    const g = gen;
    client
      .call("public/get_ticker", { instrument_name: `${a}-PERP` })
      .then((r) => {
        if (g !== gen) return;
        const t = parseTicker(r);
        if (t) perp[a] = t;
        if (a === S.asset) refresh();
      })
      .catch(() => {});
  }

  function loadCurrencies() {
    const g = gen;
    client
      .call("public/get_all_currencies", {})
      .then((r) => {
        if (g !== gen) return;
        Object.assign(currencies, parseCurrencies(r));
        refresh();
      })
      .catch(() => {});
  }

  function syncExpiries() {
    dispatch({ type: "expiries", list: expiries().map((e) => ({ key: e.key, days: e.days })) });
  }

  // ---------- state ----------
  function dispatch(a: Action) {
    const prevKey = S.expiryKey, prevAsset = S.asset;
    S = reduce(S, a);
    if (S.asset !== prevAsset) {
      if (!inst[S.asset]) loadInstruments(S.asset);
      else syncExpiries();
    }
    if (S.expiryKey && (S.expiryKey !== prevKey || S.asset !== prevAsset)) fetchTk(S.asset, S.expiryKey, true);
    refresh();
  }

  // ---------- render: builder ----------
  function renderBuilder() {
    const q = quote();
    const ex = curExpiry();
    const v = sentence(S, q.spot, ex?.short ?? (instLoaded[S.asset] && !expiries().length ? "no dates" : null), q);
    $("pAmt").textContent = v.amount;
    $("pAsset").textContent = v.asset;
    $("pDirT").textContent = v.dirWord;
    $("dirIc").innerHTML = S.dir === "up" ? UP : DN;
    $("pTgt").textContent = v.target;
    $("pPct").textContent = v.move;
    $("pPct").classList.toggle("is-down", v.moveDown);
    $("pDate").textContent = v.date;
    $("kind").textContent = v.kind;
    $("spotTag").textContent = `${S.asset} ${price(q.spot)}`;
    $("qCost").textContent = v.cost;
    if (v.note) $("qCost").insertAdjacentHTML("beforeend", `<small class="x-mk">${h(v.note)}</small>`);
    $("qChance").textContent = v.chance;
    const hint = $("hint");
    hint.hidden = !v.hint;
    hint.textContent = v.hint ?? "";
    $("buyAmt").textContent = v.buy;
    ($("buy") as HTMLButtonElement).disabled = !v.buyEnabled;
    renderLive();
    if (S.open === "tgt") setTgtCap(q);
  }

  function renderLive() {
    const e = curTk();
    const age = e && e.at ? now() - e.at : null;
    const has = !!e && Object.keys(e.tk).length > 0;
    const q = has ? quote() : null;
    let txt: string, cls: "sim" | "amber" | "live";
    if (wsStatus !== "open") [txt, cls] = [wsStatus === "connecting" ? "Connecting…" : "Offline · reconnecting", "sim"];
    else if (!e || (!has && !e.failed && e.busy)) [txt, cls] = ["Loading quotes…", "sim"];
    else if (!has) [txt, cls] = ["No quotes for this date", "amber"];
    else if (age !== null && age > QUOTE_MAX_AGE_MS) [txt, cls] = ["Quotes stale · refreshing", "amber"];
    else if (q && q.quote && q.quote.priced === "mark") [txt, cls] = ["Mark only · no book for a leg", "amber"];
    else [txt, cls] = [`Live · Derive ${NETWORKS[net].name.toLowerCase()} · ${Math.round((age ?? 0) / 1000)}s ago`, "live"];
    $("liveTxt").textContent = txt;
    $("liveTag").classList.toggle("is-sim", cls === "sim");
    $("liveTag").classList.toggle("is-amber", cls === "amber");
  }

  // ---------- popovers ----------
  const pop = $("pop"), builder = $("builder");
  function closePop() {
    pop.hidden = true;
    document.querySelectorAll(".x-pill.is-on").forEach((b) => {
      b.classList.remove("is-on");
      b.setAttribute("aria-expanded", "false");
    });
    if (S.open) dispatch({ type: "close" });
  }
  function sliderPop(cap: string, val: number, min: number, max: number, step: number, l: string, r: string, onSet: (v: number) => void, capId = "") {
    const dp = step < 1 ? Math.min(6, Math.max(0, -Math.floor(Math.log10(step)))) : 0;
    pop.innerHTML =
      `<p class="x-pop__cap">${h(cap)}</p><label class="x-field"><span>$</span><input type="text" inputmode="decimal" autocomplete="off" enterkeyhint="done" id="popIn" aria-label="Value"><small>type or drag</small></label>` +
      `<input class="x-range" type="range" id="popRg" aria-label="Slider"><div class="x-ends"><span>${h(l)}</span><b id="${capId}"></b><span>${h(r)}</span></div>`;
    const inp = $<HTMLInputElement>("popIn"), rg = $<HTMLInputElement>("popRg");
    rg.min = String(min);
    rg.max = String(max);
    rg.step = String(step);
    rg.value = String(val);
    inp.value = String(+val.toFixed(dp));
    rg.oninput = () => {
      inp.value = String(+(+rg.value).toFixed(dp));
      onSet(+rg.value);
    };
    inp.oninput = () => {
      const v = parseFloat(inp.value);
      if (Number.isFinite(v) && v > 0) {
        rg.value = String(v);
        onSet(v);
      }
    };
    const commit = () => {
      let v = parseFloat(inp.value);
      if (!Number.isFinite(v)) v = +rg.value;
      v = Math.min(max, Math.max(min, v));
      inp.value = String(+v.toFixed(dp));
      rg.value = String(v);
      onSet(v);
    };
    inp.onblur = commit;
    inp.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
        inp.blur();
      }
    };
  }
  function listPop(items: { l: string; r: string; c?: string; sel?: boolean }[], onPick: (i: number) => void) {
    pop.innerHTML =
      '<ul class="x-list">' +
      items.map((it, i) => `<li><button type="button" data-i="${i}"${it.sel ? ' class="is-sel"' : ""}><span>${it.l}</span><em${it.c ? ` class="${it.c}"` : ""}>${it.r}</em></button></li>`).join("") +
      "</ul>";
    pop.querySelectorAll<HTMLButtonElement>("button").forEach(
      (b) =>
        (b.onclick = () => {
          onPick(+b.dataset.i!);
          closePop();
        }),
    );
  }
  function setTgtCap(q: QuoteResult & { spot: number | null }) {
    const cap = document.getElementById("tgtCap");
    if (!cap) return;
    const sp = q.spot, p = sp && S.target ? Math.round((S.target / sp - 1) * 100) : 0;
    const pays = q.quote && S.target && Math.abs(S.target - q.quote.legs.K2) / q.quote.legs.K2 > 0.005 ? " · pays at " + price(q.quote.legs.K2) : "";
    cap.textContent = (q.probability !== null && q.fail !== "wrong-side" ? pct(q.probability) + " chance" : q.fail === "wrong-side" ? "Wrong side of spot" : "…") + ` · ${p >= 0 ? "+" : ""}${p}% from now` + pays;
  }
  function openPop(kind: Pop, btn: HTMLElement) {
    if (S.open === kind) return closePop();
    closePop();
    const sp = spotFor(S.asset);
    if (kind === "tgt" && !sp) return;
    if (kind === "date" && !expiries().length) return;
    S = reduce(S, { type: "open", pop: kind });
    btn.classList.add("is-on");
    btn.setAttribute("aria-expanded", "true");
    if (kind === "amt") sliderPop("How much you want to make", S.amount, 50, 10000, 50, "$50", "$10,000", (v) => dispatch({ type: "amount", value: v }));
    if (kind === "tgt" && sp) {
      const st = Number((sp / 1000).toPrecision(2));
      sliderPop(`${S.asset} price now ${price(sp)}`, S.target ?? sp, sp * 0.5, sp * 2, st, price(sp * 0.5), price(sp * 2), (v) => dispatch({ type: "target", value: v }), "tgtCap");
    }
    if (kind === "asset") {
      listPop(
        ASSETS.map((a) => {
          const ch = change24(a);
          const has = ch !== null && Number.isFinite(ch);
          return { l: `<b>${a}</b> ${h(price(spotFor(a)))}`, r: has ? (ch! > 0 ? "+" : "") + (ch! * 100).toFixed(1) + "%" : "", c: has ? (ch! >= 0 ? "x-up" : "x-dn") : "", sel: a === S.asset };
        }),
        (i) => {
          const a = ASSETS[i]!;
          dispatch({ type: "asset", asset: a, spot: spotFor(a) });
        },
      );
    }
    if (kind === "date") {
      const exs = expiries();
      exs.forEach((e) => fetchTk(S.asset, e.key));
      listPop(
        exs.map((e) => {
          const t = TK[tkKey(S.asset, e.key)];
          const p = t && Object.keys(t.tk).length ? probabilityFor(S, inst[S.asset] ?? [], t.tk, e.key, e.expiryMs, now()) : null;
          return { l: h(e.list), r: (p === null ? "—" : pct(p)) + " chance", sel: e.key === S.expiryKey };
        }),
        (i) => dispatch({ type: "expiry", key: exs[i]!.key }),
      );
    }
    pop.hidden = false;
    renderBuilder();
    const br = builder.getBoundingClientRect(), r = btn.getBoundingClientRect(), w = pop.offsetWidth;
    const left = Math.max(0, Math.min(r.left - br.left, document.documentElement.clientWidth - 20 - br.left - w));
    pop.style.left = left + "px";
    pop.style.top = r.bottom - br.top + 8 + "px";
  }
  document.querySelectorAll<HTMLElement>(".x-sent .x-pill[data-pop]").forEach((b) => {
    b.insertAdjacentHTML("beforeend", CHEV);
    b.setAttribute("aria-expanded", "false");
    b.onclick = (e) => {
      e.stopPropagation();
      openPop(b.dataset.pop as Pop, b);
    };
  });
  $("pDir").onclick = () => {
    closePop();
    dispatch({ type: "toggleDir", spot: spotFor(S.asset) });
  };
  pop.onclick = (e) => e.stopPropagation();
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    if (S.open && !pop.contains(t) && !t.closest("[data-pop]")) closePop();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && S.open) closePop();
  });

  // ---------- review ----------
  const rv = $("review");
  let countdown = 10, cdTimer: ReturnType<typeof setInterval> | null = null, rvAt = 0;
  const sub = () => W.subs.find((s) => s.id === W.sel) ?? null;

  function confirmInput() {
    const q = quote(), e = curTk();
    return confirmState({
      quote: q.quote,
      quoteAgeMs: e && e.at ? now() - e.at : null,
      connected: W.st === "on",
      balance: sub()?.value ?? null,
      subaccountRU: sub()?.riskUniverse ?? null,
      assetRU: assetRU(),
      agreed: R.agreed,
      network: net,
      typed: R.typed,
      busy: R.busy,
    });
  }

  function renderReview() {
    const q = quote(), ex = curExpiry();
    if (!q.quote || !ex || !S.target) {
      rv.innerHTML = `<div class="x-card"><p class="x-empty">This quote is no longer available.</p><button type="button" class="x-edit" id="edit">Back</button></div>`;
      $("edit").onclick = () => showView("build");
      return;
    }
    const focusId = document.activeElement && rv.contains(document.activeElement) ? document.activeElement.id : null;
    const sp = sub();
    rv.innerHTML = reviewHtml({
      q: q.quote,
      asset: S.asset,
      target: S.target,
      dateLong: ex.long,
      probability: q.probability,
      netName: NETWORKS[net].name,
      mainnet: net === "mainnet",
      subs: W.subs,
      selectedSub: W.sel,
      assetRU: assetRU(),
      connected: W.st === "on",
      balance: sp?.value ?? null,
      preTrade: R.pre,
      createUrl: net === "mainnet" ? "https://app.derive.xyz" : "https://testnet.app.derive.xyz",
    });
    rvAt = curTk()?.at ?? 0;
    const ag = $<HTMLInputElement>("agree");
    ag.checked = R.agreed;
    ag.onchange = () => {
      R.agreed = ag.checked;
      countdown = 10;
      setConfirm();
    };
    const real = document.getElementById("realIn") as HTMLInputElement | null;
    if (real) {
      real.value = R.typed;
      real.oninput = () => {
        R.typed = real.value;
        setConfirm();
      };
    }
    const pick = document.getElementById("subPick") as HTMLSelectElement | null;
    if (pick) {
      if (W.sel === null || !W.subs.some((s) => s.id === W.sel && s.riskUniverse === assetRU())) W.sel = Number(pick.value);
      pick.onchange = () => {
        W.sel = Number(pick.value);
        R.pre = null;
        renderBal();
        renderReview();
      };
    }
    $("edit").onclick = () => showView("build");
    $<HTMLButtonElement>("confirm").onclick = () => void doConfirm();
    const tip = $("tip"), chart = $("chart"), ch = chartSvg(q.quote);
    chart.querySelectorAll<SVGRectElement>("rect").forEach(
      (r) =>
        (r.onclick = (e) => {
          e.stopPropagation();
          const p = ch.pts[+r.dataset.i!]!, cr = chart.getBoundingClientRect(), rr = r.getBoundingClientRect();
          tip.hidden = false;
          tip.textContent = price(p.x) + " · " + signedMoney(p.pl);
          tip.style.left = Math.min(Math.max(rr.left + rr.width / 2 - cr.left, 60), cr.width - 60) + "px";
          tip.style.top = "-30px";
        }),
    );
    $("step").textContent = R.step;
    setConfirm();
    if (focusId) document.getElementById(focusId)?.focus();
    maybePreTrade();
  }

  function maybePreTrade() {
    const q = quote().quote, s = sub();
    if (!q || !s || W.st !== "on" || s.riskUniverse !== assetRU()) return;
    const key = `${s.id}|${q.legs.long.instrument.name}|${q.legs.short.instrument.name}|${q.amount}`;
    if (key === R.preKey) return;
    R.preKey = key;
    const g = gen;
    preTradeCheck(client, s.id, q)
      .then((p) => {
        if (g !== gen || R.preKey !== key) return;
        R.pre = p;
        if (view === "review" && !R.busy) renderReview();
      })
      .catch(() => {});
  }

  function setConfirm() {
    const b = document.getElementById("confirm") as HTMLButtonElement | null;
    if (!b) return;
    const c = confirmInput();
    b.disabled = !c.enabled;
    b.dataset.reason = c.reason;
    b.innerHTML = c.enabled ? `${h(c.label)} <span class="x-ring" aria-label="Quote refreshes in ${countdown} seconds">${countdown}</span>` : h(c.label);
  }

  function startCountdown() {
    if (cdTimer) clearInterval(cdTimer);
    countdown = 10;
    cdTimer = setInterval(() => {
      if (R.busy) return;
      countdown--;
      if (countdown <= 0) {
        countdown = 10;
        if (S.expiryKey) fetchTk(S.asset, S.expiryKey, true);
      }
      setConfirm();
    }, 1000);
  }

  async function doConfirm() {
    const c = confirmInput(), q = quote().quote, s = sub();
    if (!c.enabled || !q || !s || !W.signer) return;
    R.busy = true;
    R.step = "";
    setConfirm();
    const step = (t: string) => {
      R.step = t;
      const el = document.getElementById("step");
      if (el) el.textContent = t;
    };
    let res: SpreadResult;
    try {
      res = await placeSpread({ rpc: client, signer: W.signer, net: NETWORKS[net], subaccountId: s.id, now }, q, step);
    } catch (e) {
      R.busy = false;
      step("Not sent: " + (e instanceof Error ? e.message : String(e)));
      setConfirm();
      return;
    }
    R.busy = false;
    R.step = "";
    R.agreed = false;
    R.typed = "";
    showResult(res);
    void loadSubs();
  }

  function showResult(res: SpreadResult) {
    $("done").innerHTML = resultHtml(res, NETWORKS[net].name);
    showView("done");
    $("again").onclick = () => showView("build");
    $("toPort").onclick = () => showView("portfolio");
  }

  // ---------- portfolio ----------
  const port = $("portfolio");
  let portMsg = "";
  function renderPortfolio() {
    port.innerHTML = portfolioHtml(sub(), NETWORKS[net].name, W.st === "on");
    const st = (t: string) => {
      portMsg = t; // survives the re-render that follows every refresh
      const el = document.getElementById("portStep");
      if (el) el.textContent = t;
    };
    st(portMsg);
    port.querySelectorAll<HTMLButtonElement>("[data-cancel]").forEach(
      (b) =>
        (b.onclick = async () => {
          const [id, ins] = b.dataset.cancel!.split("|");
          b.disabled = true;
          try {
            await cancelOrder(client, W.sel!, id!, ins!);
            st("Order cancelled");
          } catch (e) {
            st("Cancel failed: " + (e as Error).message);
          }
          await loadSubs();
        }),
    );
    const legData = async (name: string) => {
      const cached = Object.values(inst).flat().find((x) => x?.name === name) ?? null;
      const [ri, rt] = await Promise.all([cached ?? client.call("public/get_instrument", { instrument_name: name }), client.call("public/get_ticker", { instrument_name: name })]);
      const i = cached ?? parseInstrument(ri), t = parseTicker(rt);
      if (!i || !t) throw new Error("no market data for " + name);
      return { i, t };
    };
    const ctx = () => ({ rpc: client, signer: W.signer!, net: NETWORKS[net], subaccountId: W.sel!, now });
    port.querySelectorAll<HTMLButtonElement>("[data-close]").forEach(
      (b) =>
        (b.onclick = async () => {
          const name = b.dataset.close!, p = sub()?.positions.find((x) => x.instrument === name);
          if (!p || !W.signer) return;
          if (net === "mainnet" && !window.confirm("Close this position with real money on mainnet?")) return;
          b.disabled = true;
          st("Sign the closing order in your wallet");
          try {
            const { i, t } = await legData(name);
            const r = await closePosition(ctx(), i, t, p.amount);
            st(`${r.status}: ${r.filled} of ${r.amount} closed · order ${r.orderId ?? "—"}${r.error ? " · " + r.error : ""}`);
          } catch (e) {
            st("Close failed: " + (e as Error).message);
          }
          await loadSubs();
        }),
    );
    port.querySelectorAll<HTMLButtonElement>("[data-close-spread]").forEach(
      (b) =>
        (b.onclick = async () => {
          const names = b.dataset.closeSpread!.split("|");
          const ps = names.map((n) => sub()?.positions.find((x) => x.instrument === n));
          if (ps.some((p) => !p) || !W.signer) return;
          if (net === "mainnet" && !window.confirm("Close this spread with real money on mainnet?")) return;
          b.disabled = true;
          st("Sign the closing orders in your wallet");
          try {
            const legs = await Promise.all(names.map(async (n, k) => ({ ...(await legData(n)), amount: ps[k]!.amount })));
            const out = await closeSpread(ctx(), legs.map((l) => ({ inst: l.i, ticker: l.t, amount: l.amount })));
            st(out.map((r) => `${r.instrument}: ${r.status} ${r.filled}/${r.amount} · ${r.orderId ?? "—"}`).join(" · "));
          } catch (e) {
            st("Close failed: " + (e as Error).message);
          }
          await loadSubs();
        }),
    );
  }

  // ---------- views ----------
  function showView(v: View) {
    closePop();
    view = v;
    builder.hidden = v !== "build";
    rv.hidden = v !== "review";
    $("done").hidden = v !== "done";
    port.hidden = v !== "portfolio";
    $("buy").hidden = $("dockSep").hidden = v !== "build";
    document.querySelectorAll<HTMLElement>(".x-ic").forEach((b) => b.classList.toggle("is-on", b.dataset.view === (v === "portfolio" ? "portfolio" : "build")));
    if (cdTimer && v !== "review") {
      clearInterval(cdTimer);
      cdTimer = null;
    }
    if (v === "review") {
      R.agreed = false;
      R.typed = "";
      R.pre = null;
      R.preKey = "";
      renderReview();
      startCountdown();
    }
    if (v === "build") renderBuilder();
    if (v === "portfolio") {
      renderPortfolio();
      void loadSubs();
    }
    window.scrollTo(0, 0);
  }
  function refresh() {
    if (view === "build") renderBuilder();
    else if (view === "review" && !R.busy && (curTk()?.at ?? 0) !== rvAt) renderReview();
    else if (view === "review") setConfirm();
  }
  $("buy").onclick = (e) => {
    e.stopPropagation();
    if (quote().quote) showView("review");
  };
  document.querySelectorAll<HTMLElement>(".x-ic").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        showView(b.dataset.view === "portfolio" ? "portfolio" : "build");
      }),
  );

  // ---------- wallet ----------
  function renderBal() {
    const s = sub();
    const t: Record<WalletSt, string> = { none: "Connect wallet", busy: "Signing in…", reconnect: "Reconnect wallet", nosub: "No Derive subaccount on this network", err: W.msg, on: "" };
    $("bal").textContent = W.st === "on" ? (s ? usd2(s.value) : "Pick a subaccount") : t[W.st];
    $("balNet").textContent = W.st === "on" && s ? `${NETWORKS[net].name} · #${s.id}${s.riskUniverse !== null ? " · RU" + s.riskUniverse : ""}` : "";
    $("balBtn").setAttribute("aria-label", W.st === "on" && s ? `Derive balance ${usd2(s.value)}, ${NETWORKS[net].name} subaccount ${s.id}` : $("bal").textContent ?? "");
  }
  function walletLost() {
    const had = W.st === "on" || W.st === "nosub" || W.st === "reconnect";
    W.signer = null;
    W.subs = [];
    W.sel = null;
    W.st = had ? "reconnect" : "none";
    renderBal();
    if (view === "review") renderReview();
    if (view === "portfolio") renderPortfolio();
  }
  let errT: ReturnType<typeof setTimeout> | null = null;
  function flashErr(e: unknown) {
    W.signer = null;
    W.subs = [];
    W.sel = null;
    W.msg = (e as { message?: string })?.message || String(e);
    W.st = "err";
    renderBal();
    if (errT) clearTimeout(errT);
    errT = setTimeout(() => {
      if (W.st === "err") {
        W.st = "none";
        renderBal();
      }
    }, 4000);
  }
  const sheet = $("sheet"), sheetBody = $("sheetBody");
  function closeSheet() {
    sheet.hidden = true;
    $("balBtn").focus();
  }
  function openSheet(html: string) {
    sheetBody.innerHTML = html + '<div class="x-sheet__btns"><button class="x-edit" type="button" id="sheetClose">Close</button></div>';
    sheet.hidden = false;
    $("sheetClose").onclick = closeSheet;
    ((sheetBody.querySelector("input, .x-buy, select") as HTMLElement | null) ?? $("sheetClose")).focus();
  }
  sheet.onclick = (e) => {
    if (e.target === sheet) closeSheet();
  };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !sheet.hidden) closeSheet();
  });

  async function openWallet() {
    if (W.st === "busy") return;
    if (W.st === "on") return openSubSheet();
    const p = eth();
    if (!p) return openSheet("<h2>No wallet found</h2><p>Open this page in a browser with MetaMask, Rabby or another injected wallet to trade on Derive.</p>");
    let accounts: unknown;
    try {
      accounts = await p.request({ method: "eth_requestAccounts" });
    } catch (e) {
      return flashErr(e);
    }
    const acct = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;
    if (!acct) return flashErr(new Error("No account shared by the wallet"));
    openSheet(
      `<h2>Sign in to Derive ${h(NETWORKS[net].name.toLowerCase())}</h2><p>Signing in proves you own the wallet. It never sends an order. Orders are only sent when you press Confirm, and each one is signed in your wallet.</p><label for="walletIn">Derive wallet address</label><input id="walletIn" autocomplete="off" spellcheck="false"><div class="x-sheet__btns" style="margin-bottom:8px"><button class="x-buy" type="button" id="signIn">Sign in</button></div>`,
    );
    $<HTMLInputElement>("walletIn").value = acct;
    $("signIn").onclick = () => void signIn(p, acct, $<HTMLInputElement>("walletIn").value.trim());
  }

  function openSubSheet() {
    const ru = assetRU();
    const opts = W.subs
      .map((s) => `<option value="${s.id}"${s.id === W.sel ? " selected" : ""}>#${s.id} · ${h(usd2(s.value))} · RU${s.riskUniverse ?? "?"}${s.riskUniverse === ru ? " · " + h(S.asset) : ""}</option>`)
      .join("");
    openSheet(
      `<h2>Subaccount</h2><p>${h(S.asset)} options trade in risk universe ${ru ?? "?"}.</p><label for="subSheet">Subaccount</label><select id="subSheet" class="x-pick">${opts}</select><div class="x-sheet__btns" style="margin:12px 0 8px"><button class="x-edit" type="button" id="signOut">Disconnect</button></div>`,
    );
    const sel = $<HTMLSelectElement>("subSheet");
    sel.onchange = () => {
      W.sel = Number(sel.value);
      renderBal();
      refresh();
    };
    $("signOut").onclick = () => {
      W.st = "none";
      W.signer = null;
      W.subs = [];
      W.sel = null;
      renderBal();
      closeSheet();
      refresh();
    };
  }

  async function signIn(p: Eip1193, account: string, wallet: string) {
    closeSheet();
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return flashErr(new Error("Enter a valid wallet address"));
    let signer: ActionSigner;
    try {
      signer = walletSigner(p, account, NETWORKS[net], wallet);
    } catch (e) {
      return flashErr(e);
    }
    W.st = "busy";
    renderBal();
    const g = gen;
    try {
      const ts = String(now());
      const sig = await signer.signLogin(ts);
      await client.call("public/login", { wallet: signer.owner, timestamp: ts, signature: sig });
      if (g !== gen) return;
      W.signer = signer;
      W.account = account;
      await loadSubs(true);
    } catch (e) {
      if (g === gen) flashErr(e);
    }
  }

  async function loadSubs(first = false) {
    if (!W.signer) return;
    const g = gen;
    try {
      const r = await client.call<{ subaccount_ids?: number[] }>("private/get_subaccounts", { wallet: W.signer.owner });
      const ids = (r?.subaccount_ids ?? []).slice(0, 20);
      const subs = (await Promise.all(ids.map((id) => client.call("private/get_subaccount", { subaccount_id: id }).then(parseSubaccount, () => null)))).filter(
        (s): s is SubaccountInfo => s !== null,
      );
      if (g !== gen) return;
      W.subs = subs;
      if (!subs.length) {
        W.st = "nosub";
      } else {
        W.st = "on";
        if (first || !subs.some((s) => s.id === W.sel)) {
          const ru = assetRU();
          const inRu = subs.filter((s) => s.riskUniverse === ru).sort((a, b) => b.value - a.value);
          W.sel = (inRu[0] ?? subs[0]!).id;
        }
      }
      renderBal();
      if (view === "review" && !R.busy) renderReview();
      if (view === "portfolio") renderPortfolio();
    } catch (e) {
      if (g === gen) flashErr(e);
    }
  }
  $("balBtn").onclick = (e) => {
    e.stopPropagation();
    void openWallet();
  };

  // ---------- network ----------
  function connect() {
    const url = opts.wsOverride || NETWORKS[net].wsUrl;
    client = new DeriveClient(url, {
      onStatus: (s) => {
        wsStatus = s;
        if (s === "closed" && W.signer) walletLost();
        if (s === "open") {
          loadCurrencies();
          ASSETS.forEach(loadPerp);
          if (!inst[S.asset]) loadInstruments(S.asset);
          if (S.expiryKey) fetchTk(S.asset, S.expiryKey, true);
        }
        renderLive();
      },
    });
    client.connect();
  }
  function setNet(n: NetworkId) {
    if (n === net) {
      if (S.expiryKey) fetchTk(S.asset, S.expiryKey, true);
      toast(`Already on ${NETWORKS[n].name} · quotes refreshed`);
      return;
    }
    net = n;
    gen++;
    document.querySelectorAll<HTMLElement>("[data-net]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.net === n)));
    $("netNote").hidden = n !== "mainnet";
    client.close();
    for (const k of Object.keys(TK)) delete TK[k];
    for (const a of ASSETS) {
      delete inst[a];
      delete instLoaded[a];
      delete perp[a];
    }
    for (const k of Object.keys(currencies)) delete currencies[k];
    const hadWallet = W.st !== "none";
    W.signer = null;
    W.subs = [];
    W.sel = null;
    W.st = hadWallet ? "reconnect" : "none";
    renderBal();
    S = { ...S, expiryKey: null, target: null };
    connect();
    if (view !== "build") showView("build");
    else renderBuilder();
  }
  document.querySelectorAll<HTMLElement>("[data-net]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        setNet(b.dataset.net as NetworkId);
      }),
  );

  let toastT: ReturnType<typeof setTimeout> | null = null;
  function toast(t: string) {
    const el = $("toast");
    el.textContent = t;
    el.hidden = false;
    if (toastT) clearTimeout(toastT);
    toastT = setTimeout(() => (el.hidden = true), 2200);
  }

  // ---------- timers ----------
  setInterval(() => {
    renderLive();
    if (S.expiryKey && wsStatus === "open") fetchTk(S.asset, S.expiryKey);
    if (view === "review") setConfirm();
  }, 1000);
  setInterval(() => {
    if (wsStatus !== "open") return;
    loadCurrencies();
    ASSETS.forEach(loadPerp);
  }, 300_000);
  setInterval(() => {
    if (W.st === "on" && !R.busy) void loadSubs();
  }, 30_000);

  connect();
  renderBal();
  renderBuilder();

  // test hook: lets e2e read state without scraping
  (window as unknown as { __peo?: unknown }).__peo = { state: () => ({ S, net, view, wallet: { st: W.st, sel: W.sel }, q: quote() }) };
}

export { money };
