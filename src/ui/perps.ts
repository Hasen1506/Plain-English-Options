// The Perps tab: "I think ETH goes UP, risking $100 at 3×" → one perp order.
// Venue-agnostic: everything exchange-specific (markets, accounts, signing,
// orders, history) goes through a PerpVenue adapter (src/venues). The builder
// maths is shared (quotePerp); a venue picker appears once two venues exist.

import { QUOTE_MAX_AGE_MS, TICKER_REFRESH_MS } from "../config.ts";
import { friendlyWalletError } from "../net/signer.ts";
import { liquidationPrice, mmRequirement, moveTo, quotePerp, type PerpDir, type PerpMarket, type PerpOrderType, type PerpQuote, type PerpTicker } from "../lib/perp.ts";
import { perpConfirmState } from "../lib/guards.ts";
import { escapeHtml as h, money } from "../lib/format.ts";
import { fillRange, popIn, popOut } from "./motion.ts";
import type { PerpVenue, VenueAccount, VenueMarginCheck } from "../venues/types.ts";
import { compareHtml, fundingText, marketsHtml, perpConfirmHtml, perpPanelHtml, perpPrice, pctSigned, venueAccountHtml, type CompareRow } from "./perpViews.ts";
import { perpHistoryRows } from "../lib/perpHistory.ts";
import type { VenueTrigger } from "../venues/types.ts";
import { CATEGORY_LABEL, CATEGORY_WORDS, categoriesOf, categoryOf, type MarketCategory } from "../lib/categories.ts";
import { changeText, sparkSvg } from "../lib/spark.ts";

export interface PerpDeps {
  venues: PerpVenue[];
  now: () => number;
  settings: () => { maxCost: number | null; leverageCap: number };
  toast: (t: string) => void;
}

type PPop = "market" | "risk" | "lev";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

export function createPerps(d: PerpDeps) {
  let venueIdx = 0;
  const venue = () => d.venues[venueIdx]!;
  let insts: PerpMarket[] = [];
  let tk: Record<string, PerpTicker> = {};
  // busy flags belong to one venue generation: a slow answer from the venue we just left
  // must not block (or be mistaken for) the first load of the venue we switched to
  let tkAt = 0, tkBusyGen = -1, instBusyGen = -1, gen = 0;
  const tkRetry = { gen: 0, n: 0 };
  let riskTouched = false; // the user picked the amount: never resize it for them
  let visible = false;
  const P = {
    name: "ETH-PERP",
    dir: "long" as PerpDir,
    risk: 100,
    lev: 3,
    orderType: "market" as PerpOrderType,
    limit: null as number | null,
    postOnly: false,
    tp: null as number | null,
    sl: null as number | null,
    agreed: false,
    typed: "",
    busy: false,
    open: null as PPop | null,
    margin: null as VenueMarginCheck | null,
    marginKey: "",
    /** The category the market list shows (null: the selected market's). */
    cat: null as MarketCategory | null,
  };

  const inst = () => insts.find((i) => i.name === P.name) ?? null;
  const oneTap = () => venue().signer()?.oneTap ?? false;
  /** The account this market's orders go to (the venue picks one that can trade it). */
  const sub = (): VenueAccount | null => (venue().connected() ? venue().selectedAccount(P.name) : null);

  function quote(): { q: PerpQuote | null; fail: string | null } {
    const i = inst(), t = tk[P.name];
    if (!i || !t) return { q: null, fail: insts.length ? `No live price for ${P.name}` : "Loading perpetual markets…" };
    const s = sub();
    const v = venue();
    const lev = v.effectiveLeverage?.(P.name, P.lev) ?? P.lev;
    const isolated = v.marginMode?.() === "isolated";
    const r = quotePerp({
      inst: i,
      ticker: t,
      dir: P.dir,
      risk: P.risk,
      leverage: lev,
      orderType: P.orderType,
      limitPrice: P.limit,
      postOnly: P.postOnly,
      takeProfit: P.tp,
      stopLoss: P.sl,
      slippage: venue().slippage,
      headroomMM: isolated ? null : (s?.maintenanceMargin ?? null),
      headroomIM: s?.initialMargin ?? null,
      existing: isolated ? 0 : (s?.positions.find((p) => p.instrument === P.name)?.amount ?? 0),
      leverageCap: d.settings().leverageCap,
    });
    if (r.ok && v.openFee) {
      // the venue prices its own open fee (Veranta: by open-interest skew)
      const fee = v.openFee(r.quote);
      r.quote = { ...r.quote, estFee: fee, worstFee: Math.max(fee, r.quote.worstFee) };
    }
    if (r.ok && isolated && s) {
      // isolated: only this position's margin (notional ÷ leverage) backs it
      const q = r.quote;
      const signed = q.side === "buy" ? q.n : -q.n;
      const liq = v.liquidationPrice ? v.liquidationPrice(q) : liquidationPrice({ size: signed, price: q.entry, headroom: q.putIn - mmRequirement(q.inst, q.n, q.entry) - q.estFee, mmReq: q.inst.mmReq });
      return { q: { ...q, liqPrice: liq, liqMove: moveTo(q.entry, liq) }, fail: null };
    }
    if (r.ok) return { q: r.quote, fail: null };
    const why: Record<string, string> = {
      "no-price": `No live price for ${P.name}`,
      "no-book": `The ${P.dir === "long" ? "ask" : "bid"} side of the ${P.name} book is empty. Use a limit order`,
      "bad-amount": "Pick an amount and leverage",
      "bad-limit": "Type a limit price",
      "too-large": "That is more than the exchange allows in one order",
      inactive: `${P.name} is not trading right now`,
    };
    return { q: null, fail: why[r.reason] ?? r.reason };
  }

  // ---------- data ----------
  function loadInstruments() {
    if (instBusyGen === gen || insts.length) return;
    const g = (instBusyGen = gen);
    venue()
      .markets()
      .then((list) => {
        if (g !== gen) return;
        insts = list.filter((i) => i.isActive);
        if (!insts.some((i) => i.name === P.name) && insts[0]) P.name = insts[0].name;
        defaultAboveMinimum();
        venue().focus?.(P.name);
        loadTickers(true);
        render();
      })
      .catch(() => {})
      .finally(() => {
        if (instBusyGen === g) instBusyGen = -1;
      });
  }
  let tkAgain = false; // a forced load asked for while one was running: run it right after
  function loadTickers(force = false) {
    if (tkBusyGen === gen) {
      if (force) tkAgain = true;
      return;
    }
    if (!force && d.now() - tkAt < TICKER_REFRESH_MS) return;
    const g = (tkBusyGen = gen);
    if (tkRetry.gen !== g) Object.assign(tkRetry, { gen: g, n: 0 });
    venue()
      .tickers()
      .then((r) => {
        if (g !== gen) return;
        tk = r;
        tkAt = d.now();
        render();
        paintMarketPrices();
      })
      .catch(() => {})
      .finally(() => {
        if (tkBusyGen === g) tkBusyGen = -1;
        if (tkAgain && g === gen) {
          tkAgain = false;
          loadTickers(true);
          return;
        }
        // a forced load that found prices missing (late feed) tries again soon instead of waiting a full refresh
        if (g === gen && visible && !tk[P.name] && insts.length && tkRetry.gen === g && tkRetry.n++ < 5) setTimeout(() => g === gen && loadTickers(true), 2000);
      });
  }
  /**
   * The default amount must be a valid order on every venue: when the market's minimum
   * position (money put in × leverage) is at or above the default, raise the default to the
   * next $5 step that clears the minimum by 10%. Never touches an amount the user picked.
   */
  function defaultAboveMinimum() {
    const i = inst();
    if (riskTouched || !i?.minNotional) return;
    const need = (i.minNotional * 1.1) / Math.max(P.lev, 1);
    if (P.risk >= need) return;
    P.risk = Math.ceil(need / 5) * 5;
  }
  function maybeMargin(q: PerpQuote | null) {
    const s = sub();
    if (!q || !s) return;
    const key = `${venue().id}|${s.id}|${q.inst.name}|${q.side}|${q.amount}`;
    if (key === P.marginKey) return;
    P.marginKey = key;
    P.margin = null;
    const g = gen;
    venue()
      .marginCheck(s, q)
      .then((m) => {
        if (g !== gen || P.marginKey !== key) return;
        P.margin = m;
        renderPanel();
      })
      .catch(() => {});
  }

  // ---------- render ----------
  function renderSentence(q: PerpQuote | null) {
    const i = inst(), t = tk[P.name];
    $("ppMarket").textContent = i?.currency ?? P.name.replace(/-PERP$/, "");
    $("ppDirT").textContent = P.dir === "long" ? "goes up" : "goes down";
    $("ppDir").classList.toggle("is-down", P.dir === "short");
    $("ppDir").setAttribute("aria-label", `Direction: ${P.dir === "long" ? "up (long)" : "down (short)"}. Tap to switch`);
    $("ppRisk").textContent = money(P.risk);
    $("ppLev").textContent = `${trim(P.lev)}×`;
    $("perpSpot").textContent = `${i?.currency ?? ""} ${perpPrice(t?.mark)}${t?.change24h != null ? " " + pctSigned(t.change24h) : ""}`;
    $("ppSummary").textContent = q ? `${q.dir === "long" ? "Long" : "Short"} ${q.amount} ${q.inst.currency} · ${money(q.notional)} position` : "…";
    $("ppSub").textContent = q ? (q.liqPrice !== null ? `Liquidation near ${perpPrice(q.liqPrice)} (${pctSigned(q.liqMove)})` : `Funding ${fundingText(q.fundingRate)}`) : quote().fail ?? "";
    renderLive();
  }
  function renderLive() {
    const age = tkAt ? d.now() - tkAt : null;
    let txt: string, cls: "sim" | "amber" | "live";
    if (!venue().isLive()) [txt, cls] = ["Connecting…", "sim"];
    else if (!tkAt) [txt, cls] = ["Loading markets…", "sim"];
    else if (age !== null && age > QUOTE_MAX_AGE_MS) [txt, cls] = ["Prices stale · refreshing", "amber"];
    else [txt, cls] = [`Live · ${venue().name} ${venue().networkName().toLowerCase()} · ${Math.round((age ?? 0) / 1000)}s ago`, "live"];
    $("perpLiveTxt").textContent = txt;
    $("perpLive").classList.toggle("is-sim", cls === "sim");
    $("perpLive").classList.toggle("is-amber", cls === "amber");
  }
  let moreOpen = false; // the panel's "More details" fold, kept across re-renders
  function renderPanel() {
    const { q, fail } = quote();
    const v = venue();
    const s = sub();
    const focusId = document.activeElement && $("perpPanel").contains(document.activeElement) ? document.activeElement.id : null;
    $("perpPanel").innerHTML = perpPanelHtml({
      q,
      fail,
      ticker: tk[P.name] ?? null,
      asset: inst()?.currency ?? P.name,
      venueName: v.name,
      connectLabel: v.connectLabel?.(),
      netName: v.networkName(),
      mainnet: v.isMainnet(),
      connected: v.connected(),
      accounts: v.accountsFor(P.name),
      accountScope: v.accountScope(P.name),
      selectedSub: s?.id ?? null,
      subValue: s?.value ?? null,
      margin: P.margin,
      oneTap: oneTap(),
      triggersNeedWallet: v.signer()?.triggersNeedWallet ?? true,
      canTrigger: v.caps.triggers,
      canDeposit: v.caps.deposit,
      canWithdraw: v.caps.withdraw,
      maxCost: v.isMainnet() ? d.settings().maxCost : null,
      leverageCap: d.settings().leverageCap,
      canConnect: !!v.connect,
      accountLabel: v.connect ? "Account" : "Subaccount",
      marginModes: v.marginModes,
      marginMode: v.marginMode?.(),
      collateral: v.collateralWords?.() ?? null,
      builder: inst()?.builder ?? null,
      moreOpen,
    });
    const more = document.getElementById("perpMore") as HTMLDetailsElement | null;
    if (more) more.ontoggle = () => (moreOpen = more.open);
    const vc = document.getElementById("perpVenueConnect");
    if (vc) vc.onclick = () => void connectVenue();
    const mode = document.getElementById("perpMode") as HTMLSelectElement | null;
    if (mode)
      mode.onchange = () => {
        venue().setMarginMode?.(mode.value as "cross" | "isolated");
        P.marginKey = "";
        confirmSig = "";
        rerenderAll();
      };
    const pick = document.getElementById("perpSub") as HTMLSelectElement | null;
    if (pick)
      pick.onchange = () => {
        venue().selectAccount(Number(pick.value));
        P.marginKey = "";
        render();
      };
    const mk = document.getElementById("perpNewSub");
    if (mk) mk.onclick = () => venue().newAccount(P.name);
    const dep = document.getElementById("perpDeposit");
    if (dep && s) dep.onclick = () => venue().deposit(s);
    const wd = document.getElementById("perpWithdraw");
    if (wd && s) wd.onclick = () => venue().withdraw(s);
    if (focusId) document.getElementById(focusId)?.focus();
    setConfirm();
    maybeMargin(q);
  }
  function renderConfirmBox() {
    $("perpConfirmBox").innerHTML = perpConfirmHtml({ mainnet: venue().isMainnet(), netName: venue().networkName(), connected: venue().connected(), dryRun: venue().caps.dryRun, venueName: venue().name, riskWords: venue().riskWords?.() });
    const ag = $<HTMLInputElement>("perpAgree");
    ag.checked = P.agreed;
    ag.onchange = () => {
      P.agreed = ag.checked;
      setConfirm();
    };
    const real = document.getElementById("perpReal") as HTMLInputElement | null;
    if (real) {
      real.value = P.typed;
      real.oninput = () => {
        P.typed = real.value;
        setConfirm();
      };
    }
    $("perpConfirm").onclick = () => void doConfirm();
    const chk = document.getElementById("perpCheck");
    if (chk) chk.onclick = () => void doCheck();
  }
  let confirmSig = "";
  function confirmInput() {
    const { q } = quote();
    const s = sub();
    return perpConfirmState({
      quote: q,
      quoteAgeMs: tkAt ? d.now() - tkAt : null,
      connected: venue().connected(),
      accountOk: !!s,
      marginValid: P.margin ? P.margin.valid : null,
      agreed: P.agreed,
      network: venue().isMainnet() ? "mainnet" : "testnet",
      typed: P.typed,
      busy: P.busy,
      maxCost: d.settings().maxCost,
    });
  }
  function setConfirm() {
    const b = document.getElementById("perpConfirm") as HTMLButtonElement | null;
    if (!b) return;
    const c = confirmInput();
    b.disabled = !c.enabled;
    b.dataset.reason = c.reason;
    b.textContent = c.label;
  }
  /** The selected market's category (the table under the builder shows that category only). */
  const curCat = (): MarketCategory => categoryOf(inst() ?? {});
  function renderMarkets() {
    const c = curCat();
    $("perpMarketsBox").innerHTML = marketsHtml(insts.filter((i) => categoryOf(i) === c), tk, P.name);
    $("perpMarketsBox")
      .querySelectorAll<HTMLButtonElement>("[data-pick]")
      .forEach((b) => (b.onclick = () => pickMarket(b.dataset.pick!)));
  }
  /** The confirm box (risk words, REAL MONEY) follows the venue, network, connection and the market's margin words. */
  function syncConfirmBox() {
    const v = venue();
    const words = v.riskWords?.() ?? "";
    const sig = `${v.id}|${v.networkName()}|${v.connected()}|${v.marginMode?.() ?? ""}|${words}`;
    if (sig === confirmSig) return;
    // new words need a new tick: an agreement to other risk words does not carry over
    if (confirmSig && confirmSig.split("|").slice(4).join("|") !== words) P.agreed = false;
    confirmSig = sig;
    renderConfirmBox();
  }
  function render() {
    if (!visible) return;
    syncConfirmBox();
    const { q } = quote();
    renderSentence(q);
    renderPanel();
    renderMarkets();
  }
  function rerenderAll() {
    if (!visible) return;
    syncConfirmBox();
    $("perpNetNote").hidden = !venue().isMainnet();
    $("ppTpslNote").textContent = venue().signer()?.triggersNeedWallet === false || venue().id !== "derive"
      ? `They close the position with a reduce-only market order on ${venue().name}, placed together with your order and signed the same way (no extra wallet prompt with one-tap on).`
      : "They close the position with a reduce-only market order. Derive keeps them for 30 days, so your wallet signs them even with one-tap on.";
    renderVenues();
    render();
    renderVenueAcct();
    renderCompare();
  }

  function pickMarket(name: string) {
    if (name === P.name) return;
    P.name = name;
    P.cat = null;
    venue().focus?.(name);
    loadTickers(true);
    P.limit = P.tp = P.sl = null;
    ($("ppLimit") as HTMLInputElement).value = "";
    ($("ppTp") as HTMLInputElement).value = "";
    ($("ppSl") as HTMLInputElement).value = "";
    P.marginKey = "";
    const i = inst();
    if (i && P.lev > Math.min(d.settings().leverageCap, i.maxLeverage)) P.lev = Math.max(1, Math.floor(Math.min(d.settings().leverageCap, i.maxLeverage)));
    render();
  }

  // ---------- popovers ----------
  const pop = $("perpPop");
  function closePop() {
    sparkObs?.disconnect();
    sparkObs = null;
    if (P.open === "market" && primeSeen.size) {
      primeSeen = new Set();
      venue().prime?.([]); // stop pricing the list's extra rows once it is closed
    }
    popOut(pop);
    pop.hidden = true;
    pop.classList.remove("is-in");
    P.open = null;
    document.querySelectorAll("#perps .x-pill.is-on").forEach((b) => {
      b.classList.remove("is-on");
      b.setAttribute("aria-expanded", "false");
    });
  }
  function slider(cap: string, val: number, min: number, max: number, step: number, unit: string, onSet: (v: number) => void, l: string, r: string) {
    pop.innerHTML =
      `<p class="x-pop__cap">${h(cap)}</p><label class="x-field"><span>${h(unit)}</span><input type="text" inputmode="decimal" autocomplete="off" enterkeyhint="done" id="ppIn" aria-label="Value"><small>type or drag</small></label>` +
      `<div class="x-rangewrap x-rangewrap--${unit === "$" ? "amt" : "tgt"}"><input class="x-range" type="range" id="ppRg" aria-label="Slider"></div><div class="x-ends"><span>${h(l)}</span><b></b><span>${h(r)}</span></div>`;
    const inp = $<HTMLInputElement>("ppIn"), rg = $<HTMLInputElement>("ppRg");
    const onSet0 = onSet;
    onSet = (v: number) => {
      fillRange(rg);
      onSet0(v);
    };
    rg.min = String(min);
    rg.max = String(max);
    rg.step = String(step);
    rg.value = String(val);
    inp.value = String(val);
    fillRange(rg);
    rg.oninput = () => {
      inp.value = rg.value;
      onSet(+rg.value);
    };
    const commit = () => {
      let v = parseFloat(inp.value.replace(/[$,×x\s]/gi, ""));
      if (!Number.isFinite(v)) v = +rg.value;
      v = Math.min(max, Math.max(min, v));
      inp.value = String(v);
      rg.value = String(v);
      onSet(v);
    };
    inp.oninput = () => {
      const v = parseFloat(inp.value.replace(/[$,×x\s]/gi, ""));
      if (Number.isFinite(v) && v >= min && v <= max) {
        rg.value = String(v);
        onSet(v);
      }
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
  function openPop(kind: PPop, btn: HTMLElement) {
    if (P.open === kind) return closePop();
    closePop();
    P.open = kind;
    btn.classList.add("is-on");
    btn.setAttribute("aria-expanded", "true");
    if (kind === "market") {
      const cats = categoriesOf(insts);
      P.cat = cats.includes(P.cat ?? curCat()) ? (P.cat ?? curCat()) : (cats[0] ?? null);
      renderMarketPop();
    }
    if (kind === "risk") slider("Money you put in (margin)", P.risk, 5, 10000, 5, "$", (v) => ((riskTouched = true), set({ risk: v })), "$5", "$10,000");
    if (kind === "lev") {
      const i = inst();
      const max = Math.max(1, Math.min(d.settings().leverageCap, i?.maxLeverage ?? 1));
      slider(`Leverage · your cap ${d.settings().leverageCap}× · exchange max ${i ? trim(i.maxLeverage) : "?"}×`, Math.min(P.lev, max), 1, Math.floor(max * 2) / 2, 0.5, "×", (v) => set({ lev: v }), "1×", `${trim(Math.floor(max * 2) / 2)}×`);
    }
    pop.hidden = false;
    const root = $("perps").getBoundingClientRect(), r = btn.getBoundingClientRect();
    const left = Math.max(0, Math.min(r.left - root.left, document.documentElement.clientWidth - 20 - root.left - pop.offsetWidth));
    pop.style.left = left + "px";
    pop.style.top = r.bottom - root.top + 8 + "px";
    popIn(pop, r.left - root.left - left + Math.min(r.width, pop.offsetWidth) / 2);
  }
  // ---------- market list: categories, rows with 24h change and sparklines ----------
  const sparks = new Map<string, { v: number[]; at: number }>();
  const sparkKey = (name: string) => `${venue().id}|${venue().networkName()}|${name}`;
  let sparkQueue: string[] = [];
  let sparkBusy = 0;
  let sparkObs: IntersectionObserver | null = null;
  // venues that price pair by pair (Veranta): price the rows that scroll into view
  let primeSeen = new Set<string>();
  let primeTimer: ReturnType<typeof setTimeout> | null = null;
  function wantPrice(name: string) {
    const v = venue();
    if (!v.prime || tk[name] || primeSeen.has(name)) return;
    primeSeen.add(name);
    if (primeTimer) clearTimeout(primeTimer);
    primeTimer = setTimeout(() => {
      primeTimer = null;
      v.prime!([...primeSeen]);
      loadTickers(true);
    }, 250);
  }
  const viewMarkets = () => (P.cat ? insts.filter((i) => categoryOf(i) === P.cat) : insts);
  /** 24h change: the venue's figure, else the change across the sparkline's hourly closes. */
  function change24(name: string): number | null {
    const c = tk[name]?.change24h;
    if (c != null && Number.isFinite(c) && c !== 0) return c;
    const sp = sparks.get(sparkKey(name))?.v;
    return sp && sp.length > 1 ? sp[sp.length - 1]! / sp[0]! - 1 : (c ?? null);
  }
  function marketRow(i: PerpMarket): string {
    const ch = change24(i.name);
    const has = ch !== null && Number.isFinite(ch);
    const tag = i.builder ? `<i class="x-btag">${h(i.builder.dex)}</i>` : "";
    return `<span class="x-arow"><b>${h(i.currency)}</b>${tag}<small data-px="${h(i.name)}">${h(perpPrice(tk[i.name]?.mark))}</small></span><em class="${has ? (ch! >= 0 ? "x-up" : "x-dn") : ""}" data-chg="${h(i.name)}">${has ? changeText(ch!) : ""}</em><span class="x-sparkbox" data-spark="${h(i.name)}">${sparkSvg(sparks.get(sparkKey(i.name))?.v ?? [])}</span>`;
  }
  function renderMarketPop() {
    const cats = categoriesOf(insts);
    const list = viewMarkets();
    const sel = list.findIndex((i) => i.name === P.name);
    const b = list.find((i) => i.builder)?.builder;
    const dexes = [...new Set(list.filter((i) => i.builder).map((i) => i.builder!.label))];
    pop.innerHTML =
      `<p class="x-pop__cap">Choose a perpetual market</p>` +
      (cats.length > 1
        ? `<div class="x-seg x-seg--cats" role="group" aria-label="Market category: ${h(P.cat ? CATEGORY_WORDS[P.cat] : "")}">${cats.map((c) => `<button type="button" data-cat="${c}" aria-pressed="${c === P.cat}"><i class="x-dot x-cat--${c}" aria-hidden="true"></i>${h(CATEGORY_LABEL[c])}</button>`).join("")}</div>`
        : "") +
      `<ul class="x-list x-list--assets" id="ppMarketList">` +
      list.map((i, k) => `<li style="--i:${Math.min(k, 14)}"><button type="button" data-k="${k}"${k === sel ? ' class="is-sel" aria-current="true"' : ""}>${marketRow(i)}</button></li>`).join("") +
      "</ul>" +
      (b ? `<p class="x-pop__note" id="ppBuilderNote">${h(dexes.join(" · "))}. HIP-3 markets are deployed by a third party on Hyperliquid, may trade 24/7 while the underlying market is closed, and have their own leverage caps and isolated margin.</p>` : "");
    pop.querySelectorAll<HTMLButtonElement>("button[data-k]").forEach(
      (btn) =>
        (btn.onclick = () => {
          pickMarket(list[+btn.dataset.k!]!.name);
          closePop();
        }),
    );
    pop.querySelectorAll<HTMLButtonElement>("button[data-cat]").forEach(
      (btn) =>
        (btn.onclick = () => {
          const c = btn.dataset.cat as MarketCategory;
          if (c === P.cat) return;
          P.cat = c;
          renderMarketPop();
        }),
    );
    const ul = pop.querySelector<HTMLElement>(".x-list");
    const selEl = pop.querySelector<HTMLElement>(".is-sel");
    if (selEl && ul && ul.scrollHeight > ul.clientHeight) ul.scrollTop = Math.max(0, selEl.offsetTop - ul.clientHeight / 2);
    // venues that price pair by pair (Veranta): the first rows now, later ones as they scroll into view
    primeSeen = new Set();
    list.slice(0, 24).forEach((i) => wantPrice(i.name));
    // the pills scroll sideways when they do not fit: keep the chosen one in view, fade the cut edge
    const seg = pop.querySelector<HTMLElement>(".x-seg--cats");
    if (seg) {
      const on = seg.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (on) seg.scrollLeft = Math.max(0, on.offsetLeft - (seg.clientWidth - on.offsetWidth) / 2);
      const edge = () => {
        seg.classList.toggle("is-cut-r", seg.scrollLeft + seg.clientWidth < seg.scrollWidth - 2);
        seg.classList.toggle("is-cut-l", seg.scrollLeft > 2);
      };
      edge();
      seg.onscroll = edge;
    }
    watchSparks();
  }
  /** Fetch sparklines only for rows that scroll into view, a few at a time, cached 10 minutes. */
  function watchSparks() {
    sparkObs?.disconnect();
    sparkQueue = [];
    const v = venue();
    if (!v.sparkline && !v.prime) return;
    const want = (name: string) => {
      wantPrice(name);
      if (!v.sparkline) return;
      const c = sparks.get(sparkKey(name));
      if (c && d.now() - c.at < 600_000) return;
      if (!sparkQueue.includes(name)) sparkQueue.push(name);
      pumpSparks();
    };
    const boxes = [...pop.querySelectorAll<HTMLElement>("[data-spark]")];
    if (typeof IntersectionObserver === "undefined") {
      boxes.slice(0, 12).forEach((b) => want(b.dataset.spark!));
      return;
    }
    sparkObs = new IntersectionObserver(
      (es) => es.forEach((e) => e.isIntersecting && want((e.target as HTMLElement).dataset.spark!)),
      { root: pop.querySelector(".x-list"), rootMargin: "60px 0px" },
    );
    boxes.forEach((b) => sparkObs!.observe(b));
  }
  function pumpSparks() {
    const v = venue();
    while (sparkBusy < 3 && sparkQueue.length) {
      const name = sparkQueue.shift()!;
      const key = sparkKey(name);
      sparks.set(key, { v: sparks.get(key)?.v ?? [], at: d.now() });
      sparkBusy++;
      const g = gen;
      v.sparkline!(name)
        .then((vals) => {
          if (g !== gen) return;
          sparks.set(key, { v: vals, at: d.now() });
          paintSpark(name);
        })
        .catch(() => {})
        .finally(() => {
          sparkBusy--;
          if (g === gen) pumpSparks();
        });
    }
  }
  function paintSpark(name: string) {
    if (P.open !== "market") return;
    const esc = CSS.escape(name);
    const b = pop.querySelector<HTMLElement>(`[data-spark="${esc}"]`);
    if (b && !b.firstChild) b.innerHTML = sparkSvg(sparks.get(sparkKey(name))?.v ?? []);
    const c = pop.querySelector<HTMLElement>(`[data-chg="${esc}"]`);
    const ch = change24(name);
    if (c && ch !== null && Number.isFinite(ch)) {
      const t = changeText(ch);
      if (c.textContent !== t) c.textContent = t;
      c.className = ch >= 0 ? "x-up" : "x-dn";
    }
  }
  /** Prices arrived while the list is open: fill in the rows that had none. */
  function paintMarketPrices() {
    if (P.open !== "market") return;
    pop.querySelectorAll<HTMLElement>("[data-px]").forEach((el) => {
      const t = perpPrice(tk[el.dataset.px!]?.mark);
      if (el.textContent !== t) el.textContent = t;
    });
    viewMarkets().forEach((i) => paintSpark(i.name));
  }

  function set(p: Partial<typeof P>) {
    Object.assign(P, p);
    render();
  }

  // ---------- actions ----------
  async function doConfirm() {
    const c = confirmInput(), { q } = quote(), s = sub(), v = venue();
    if (!c.enabled || !q || !s) return;
    P.busy = true;
    setConfirm();
    const step = (t: string) => ($("perpStep").textContent = t);
    try {
      const r = await v.open(s, q, step);
      const ids = [r.entry.orderId, ...r.triggers.map((t) => t.orderId)].filter(Boolean).join(", ");
      step(`${r.message}${ids ? ` · order ${ids}` : ""}`);
      $("perpStep").dataset.status = r.entry.error ? "error" : r.entry.status;
      d.toast(r.entry.filled > 0 ? `${q.dir === "long" ? "Long" : "Short"} ${r.entry.filled} ${q.inst.currency} opened` : r.entry.error ? "Order not placed" : "Order placed");
      P.agreed = false;
      P.typed = "";
      P.marginKey = "";
    } catch (e) {
      step("Not sent: " + friendlyWalletError(e).message);
      $("perpStep").dataset.status = "error";
    }
    P.busy = false;
    confirmSig = "";
    const msg = $("perpStep").textContent ?? "", st = $("perpStep").dataset.status ?? "";
    rerenderAll();
    $("perpStep").textContent = msg;
    $("perpStep").dataset.status = st;
    await v.refreshAccounts();
  }

  async function doCheck() {
    const { q } = quote(), s = sub();
    const out = $("perpCheckStep");
    if (!q || !s) {
      out.textContent = "Connect your wallet and pick an account first";
      return;
    }
    out.textContent = oneTap() ? "Checking with your one-tap key…" : "Sign the check order in your wallet (nothing is traded)…";
    try {
      const r = await venue().checkOrder(s, q);
      out.textContent = r.message;
      out.dataset.ok = String(r.ok);
    } catch (e) {
      out.textContent = "Check failed: " + friendlyWalletError(e).message;
    }
  }

  // ---------- venues with their own wallet (Hyperliquid, Veranta): connect, account card ----------
  type VOrders = Awaited<ReturnType<NonNullable<PerpVenue["openOrders"]>>>;
  let acctData: { venueId: string; triggers: VenueTrigger[]; orders: VOrders; history: { rows: ReturnType<typeof perpHistoryRows>["rows"]; total: number } | null; historyError: string | null; at: number } | null = null;
  let acctBusy = false;
  let acctMsg = "";
  let acctQueued = false;

  async function connectVenue() {
    const v = venue();
    const out = document.getElementById("perpStep");
    try {
      if (out) out.textContent = `Connecting your wallet to ${v.name}…`;
      await v.connect!();
      if (out) out.textContent = "";
      P.marginKey = "";
      confirmSig = "";
      acctData = null;
      rerenderAll();
      void loadVenueAcct(true);
    } catch (e) {
      if (out) out.textContent = "Not connected: " + friendlyWalletError(e).message;
    }
  }

  async function loadVenueAcct(force = false) {
    const v = venue();
    if (!v.connect || !v.connected() || acctBusy) return;
    if (!force && acctData && acctData.venueId === v.id && d.now() - acctData.at < 15_000) return;
    acctBusy = true;
    const g = gen;
    try {
      await v.refreshAccounts();
      const acct = v.selectedAccount(P.name);
      const [triggers, orders, hist] = await Promise.all([
        acct ? v.triggers(acct).catch(() => [] as VenueTrigger[]) : Promise.resolve([] as VenueTrigger[]),
        acct && v.openOrders ? v.openOrders(acct).catch(() => [] as VOrders) : Promise.resolve([] as VOrders),
        acct ? v.history(acct).then((x) => ({ ok: x, err: null as string | null }), (e) => ({ ok: null, err: (e as Error).message })) : Promise.resolve({ ok: null, err: null as string | null }),
      ]);
      if (g !== gen) return;
      const ph = hist.ok ? perpHistoryRows(hist.ok.trades, hist.ok.funding) : null;
      acctData = { venueId: v.id, triggers, orders, history: ph, historyError: hist.err ? "History unavailable: " + hist.err : null, at: d.now() };
    } catch {
      /* keep the last good data */
    } finally {
      acctBusy = false;
    }
    renderVenueAcct();
    renderPanel();
  }

  function renderVenueAcct() {
    const box = document.getElementById("venueAcctBox");
    if (!box) return;
    const v = venue();
    if (!visible || !v.connect || !v.connected()) {
      box.innerHTML = "";
      return;
    }
    const a = v.selectedAccount(P.name);
    const mine = acctData && acctData.venueId === v.id ? acctData : null;
    const ext = v as unknown as { agentAddress?: () => string | null; sessionAddress?: () => string | null; user?: () => string | null };
    box.innerHTML = venueAccountHtml({
      venue: v.name,
      netName: v.networkName(),
      address: ext.user?.() ?? "",
      oneTapKey: ext.agentAddress?.() ?? ext.sessionAddress?.() ?? null,
      account: a,
      triggers: mine?.triggers ?? [],
      orders: mine?.orders ?? [],
      tickers: tk,
      history: mine?.history ?? null,
      historyError: mine?.historyError ?? null,
      canDeposit: v.caps.deposit,
      canWithdraw: v.caps.withdraw,
      oneTapWords: v.id === "hyperliquid" ? "can trade, cannot withdraw · expires in 24 h or on Disconnect" : v.id === "veranta" ? "can trade, cannot withdraw or approve · 30 days, revoked on Disconnect" : "can trade, cannot withdraw or approve · revoked on Disconnect",
    });
    const st = (t: string) => {
      acctMsg = t;
      const el = document.getElementById("venueStep");
      if (el) el.textContent = t;
    };
    st(acctMsg);
    const real = (what: string) => !v.isMainnet() || window.confirm(`${what} with real money on ${v.name} mainnet?`);
    const act = async (what: string, run: () => Promise<string>) => {
      if (!real(what)) return;
      st(v.signer()?.oneTap ? "Sending…" : "Sign in your wallet…");
      try {
        st(await run());
      } catch (e) {
        st(what + " failed: " + friendlyWalletError(e).message);
      }
      acctData = null;
      void loadVenueAcct(true);
    };
    const said = (r: { status: string; filled: number; amount: number; orderId: string | null; error: string | null }) => `${r.status}: ${r.filled} of ${r.amount} · order ${r.orderId ?? "—"}${r.error ? " · " + r.error : ""}`;
    const pos = (name: string) => a?.positions.find((p) => p.instrument === name) ?? null;
    box.querySelectorAll<HTMLButtonElement>("[data-perp-close]").forEach((b) => (b.onclick = () => void act("Close this perp", async () => said(await v.close(a!, b.dataset.perpClose!, pos(b.dataset.perpClose!)!.amount, 1)))));
    box.querySelectorAll<HTMLButtonElement>("[data-perp-half]").forEach((b) => (b.onclick = () => void act("Close half of this perp", async () => said(await v.close(a!, b.dataset.perpHalf!, pos(b.dataset.perpHalf!)!.amount, 0.5)))));
    box.querySelectorAll<HTMLButtonElement>("[data-perp-flip]").forEach(
      (b) =>
        (b.onclick = () =>
          void act("Flip this perp", async () => {
            const r = await v.flip(a!, b.dataset.perpFlip!, pos(b.dataset.perpFlip!)!.amount);
            return `${r.message} · orders ${[r.close.orderId, r.open?.orderId].filter(Boolean).join(", ")}`;
          })),
    );
    box.querySelectorAll<HTMLButtonElement>("[data-cancel-trigger]").forEach(
      (b) =>
        (b.onclick = () =>
          void act("Cancel take-profit / stop-loss", async () => {
            await v.cancelTrigger(a!, b.dataset.cancelTrigger!);
            return "Take-profit / stop-loss cancelled";
          })),
    );
    box.querySelectorAll<HTMLButtonElement>("[data-venue-cancel]").forEach(
      (b) =>
        (b.onclick = () =>
          void act("Cancel order", async () => {
            await v.cancelOrder!(a!, b.dataset.venueCancel!, b.dataset.venueInst!);
            return "Order cancelled";
          })),
    );
    const on = (id: string, f: () => void) => {
      const el = document.getElementById(id);
      if (el) el.onclick = f;
    };
    on("venueDeposit", () => (a ? v.deposit(a) : v.newAccount(P.name)));
    on("venueWithdraw", () => {
      if (a) v.withdraw(a);
    });
    on("venueCancelAll", () =>
      void act("Cancel every order", async () => {
        if (a) await v.cancelAll(a);
        return "All open orders cancelled, take-profits and stop-losses too";
      }),
    );
    on("venueCloseAll", () => {
      if (!a || !a.positions.length) return;
      if (!window.confirm(`Cancel every order and close all ${a.positions.length} position${a.positions.length === 1 ? "" : "s"} on ${v.name}${v.isMainnet() ? " with real money" : ""}?`)) return;
      void (async () => {
        st("Cancelling orders and closing positions…");
        const out: string[] = [];
        try {
          await v.cancelAll(a);
          out.push("orders cancelled");
        } catch (e) {
          out.push("cancel all failed: " + friendlyWalletError(e).message);
        }
        for (const p of [...a.positions]) {
          try {
            const r = await v.close(a, p.instrument, p.amount, 1);
            out.push(`${p.instrument} ${r.status}${r.error ? " (" + r.error + ")" : ""}`);
          } catch (e) {
            out.push(`${p.instrument} not closed: ${friendlyWalletError(e).message}`);
          }
        }
        st(out.join(" · "));
        acctData = null;
        void loadVenueAcct(true);
      })();
    });
    on("venueDisconnect", () => {
      void (async () => {
        st("Revoking the one-tap key (sign in your wallet)…");
        try {
          await v.disconnect!();
          st("Disconnected. The one-tap key is revoked.");
        } catch (e) {
          st("Disconnected here; the key could not be revoked (" + friendlyWalletError(e).message + ") and expires on its own.");
        }
        acctData = null;
        confirmSig = "";
        rerenderAll();
      })();
    });
  }

  // ---------- venue comparison ----------
  const cmp = new Map<string, { insts: PerpMarket[]; tk: Record<string, PerpTicker>; at: number; busy: boolean; failed: boolean }>();
  function loadCompare(force = false) {
    if (d.venues.length < 2) return;
    d.venues.forEach((v) => {
      const c = cmp.get(v.id) ?? { insts: [], tk: {}, at: 0, busy: false, failed: false };
      cmp.set(v.id, c);
      if (v === venue() || v.status?.usable === false || c.busy || (!force && d.now() - c.at < 30_000)) return;
      c.busy = true;
      Promise.all([c.insts.length ? Promise.resolve(c.insts) : v.markets(), v.tickers()])
        .then(([i, t]) => {
          c.insts = i;
          c.tk = t;
          c.failed = false;
        })
        .catch(() => {
          c.failed = true;
        })
        .finally(() => {
          c.at = d.now();
          c.busy = false;
          renderCompare();
        });
    });
  }
  function compareRows(): CompareRow[] {
    const cur = inst()?.currency ?? P.name.replace(/-PERP$/, "");
    return d.venues.map((v, idx) => {
      const own = v === venue();
      if (v.status?.usable === false)
        return { venueIdx: idx, venue: v.name, listed: false, loading: false, comingSoon: true, mark: null, fundingRate: null, taker: null, maker: null, maxLeverage: null, minOrder: null, selected: false, note: v.status.detail };
      const c = cmp.get(v.id);
      const list = own ? insts : (c?.insts ?? []);
      const ticks = own ? tk : (c?.tk ?? {});
      const m = list.find((x) => x.name === P.name) ?? list.find((x) => x.currency === cur) ?? null;
      const t = m ? ticks[m.name] : undefined;
      return {
        venueIdx: idx,
        venue: v.name,
        listed: !!m,
        loading: !m && !own && (!c || !c.at),
        mark: t?.mark ?? null,
        fundingRate: t?.fundingRate ?? null,
        taker: m?.takerFeeRate ?? null,
        maker: m?.makerFeeRate ?? null,
        maxLeverage: m?.maxLeverage ?? null,
        minOrder: m ? (m.minNotional ? `$${m.minNotional}` : `${m.minAmount} ${m.currency}`) : null,
        selected: own,
        note: [v.status?.tag, c?.failed && !own ? "prices unavailable right now" : ""].filter(Boolean).join(" · ") || undefined,
      };
    });
  }
  function renderCompare() {
    const box = document.getElementById("venueCompareBox");
    if (!box || !visible) return;
    box.innerHTML = compareHtml(inst()?.currency ?? P.name.replace(/-PERP$/, ""), compareRows());
    box.querySelectorAll<HTMLButtonElement>("[data-cmp-pick]").forEach((b) => (b.onclick = () => pickVenue(Number(b.dataset.cmpPick))));
  }

  function pickVenue(i: number) {
    if (i === venueIdx || !d.venues[i] || d.venues[i].status?.usable === false) return;
    venueIdx = i;
    gen++;
    P.cat = null;
    acctData = null;
    acctMsg = "";
    insts = [];
    tk = {};
    tkAt = 0;
    P.margin = null;
    P.marginKey = "";
    P.agreed = false;
    P.typed = "";
    confirmSig = "";
    venue().focus?.(P.name);
    loadInstruments();
    loadTickers(true);
    loadCompare(true);
    rerenderAll();
    void loadVenueAcct(true);
  }

  function renderVenues() {
    // a network switch can make the venue on screen unavailable (Veranta mainnet: coming soon)
    if (venue().status?.usable === false && venueIdx !== 0) {
      venueIdx = -1;
      pickVenue(0);
      return;
    }
    const box = $("venuePick");
    box.hidden = d.venues.length < 2; // one venue: no picker
    const st = $("venueStatus");
    if (box.hidden) {
      st.hidden = true;
      return;
    }
    // status dot: green = live-tested, amber = not live-tested, blue = practice account, grey = not available here
    const tone = (v: PerpVenue) => (!v.status ? "ok" : !v.status.usable ? "off" : /not live-tested/i.test(v.status.tag) ? "warn" : "info");
    box.innerHTML = d.venues
      .map((v, i) => {
        const dot = `<i class="x-dot is-${tone(v)}" aria-hidden="true"></i>`;
        const tag = v.status ? `<span class="x-sr"> (${h(v.status.tag)})</span>` : "";
        return v.status && !v.status.usable
          ? `<button type="button" data-venue="${i}" aria-pressed="false" disabled title="${h(v.status.detail)}">${dot}${h(v.name)}<small aria-hidden="true">soon</small>${tag}</button>`
          : `<button type="button" data-venue="${i}" aria-pressed="${i === venueIdx}"${v.status ? ` title="${h(v.status.tag)}"` : ""}>${dot}${h(v.name)}${tag}</button>`;
      })
      .join("");
    box.querySelectorAll<HTMLButtonElement>("[data-venue]:not([disabled])").forEach((b) => (b.onclick = () => pickVenue(Number(b.dataset.venue))));
    const vs = venue().status;
    st.hidden = !vs;
    const wasOpen = !!st.querySelector("details[open]");
    st.className = `x-venuest is-${tone(venue())}`;
    st.innerHTML = vs
      ? `<details${wasOpen ? " open" : ""}><summary><i class="x-dot is-${tone(venue())}" aria-hidden="true"></i><span>${h(venue().name)} is ${h(vs.tag)}</span><em>Details</em></summary><p>${h(vs.detail)}</p></details>`
      : "";
  }

  // ---------- wiring ----------
  document.querySelectorAll<HTMLElement>("#perps .x-pill[data-ppop]").forEach((b) => {
    b.insertAdjacentHTML("beforeend", CHEV);
    b.setAttribute("aria-expanded", "false");
    b.onclick = (e) => {
      e.stopPropagation();
      openPop(b.dataset.ppop as PPop, b);
    };
  });
  $("ppDir").onclick = () => {
    closePop();
    set({ dir: P.dir === "long" ? "short" : "long", tp: null, sl: null, limit: P.limit });
    ($("ppTp") as HTMLInputElement).value = "";
    ($("ppSl") as HTMLInputElement).value = "";
  };
  pop.onclick = (e) => e.stopPropagation();
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    if (P.open && !pop.contains(t) && !t.closest("[data-ppop]")) closePop();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && P.open) closePop();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-otype]").forEach(
    (b) =>
      (b.onclick = () => {
        const t = b.dataset.otype as PerpOrderType;
        document.querySelectorAll<HTMLElement>("[data-otype]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.otype === t)));
        $("ppLimitRow").hidden = t !== "limit";
        if (t === "limit" && P.limit === null) {
          const tt = tk[P.name];
          const seed = tt ? (P.dir === "long" ? tt.bid : tt.ask) || tt.mark : null;
          if (seed) {
            P.limit = seed;
            ($("ppLimit") as HTMLInputElement).value = String(seed);
          }
        }
        set({ orderType: t });
      }),
  );
  const num = (id: string) => {
    const v = parseFloat(($(id) as HTMLInputElement).value.replace(/[$,\s]/g, ""));
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  $("ppLimit").oninput = () => set({ limit: num("ppLimit") });
  $("ppPostOnly").onchange = () => set({ postOnly: ($("ppPostOnly") as HTMLInputElement).checked });
  $("ppTp").oninput = () => set({ tp: num("ppTp") });
  $("ppSl").oninput = () => set({ sl: num("ppSl") });

  return {
    show() {
      visible = true;
      confirmSig = "";
      venue().focus?.(P.name);
      loadInstruments();
      loadTickers(true);
      loadCompare();
      rerenderAll();
      void loadVenueAcct();
    },
    hide() {
      visible = false;
      closePop();
    },
    /** Network switched or socket reopened: forget market data. */
    reset() {
      gen++;
      cmp.clear();
      acctData = null;
      insts = [];
      tk = {};
      tkAt = 0;
      P.margin = null;
      P.marginKey = "";
      P.agreed = false;
      P.typed = "";
      confirmSig = "";
      if (visible) {
        loadInstruments();
        loadTickers(true);
        rerenderAll();
      }
    },
    onOpen() {
      if (visible) {
        loadInstruments();
        loadTickers(true);
      }
    },
    tick() {
      if (!visible) return;
      renderLive();
      if (venue().isLive() || venue().connect) loadTickers();
      loadCompare();
      void loadVenueAcct();
      setConfirm();
    },
    /** Wallet / subaccount changed. */
    walletChanged() {
      P.marginKey = "";
      P.margin = null;
      rerenderAll();
    },
    /** A venue's own account/key changed (connect, one-tap approval, refresh). */
    venueChanged() {
      if (!visible) return;
      renderPanel();
      renderVenueAcct();
      // orders/triggers/history changed with it: reload them (no-op while a load is running)
      if (!acctQueued) {
        acctQueued = true;
        queueMicrotask(() => {
          acctQueued = false;
          void loadVenueAcct(true);
        });
      }
    },
    state: () => ({ ...P, venue: venue().id, quote: quote().q, markets: insts.map((i) => i.name), scope: venue().accountScope(P.name), oneTap: oneTap(), marginMode: venue().marginMode?.() ?? "cross", compare: compareRows() }),
    venue,
    data: () => ({ insts, tk }),
    /** Venues with their own wallet connection that are connected now (their positions live on the Perps tab). */
    connectedVenues: () => d.venues.filter((v) => v.connect && v.connected()).map((v) => ({ id: v.id, name: v.name, net: v.networkName() })),
    /** Make a venue the Perps tab's venue (before showing the tab). */
    openVenue(id: string) {
      const i = d.venues.findIndex((v) => v.id === id);
      if (i >= 0 && i !== venueIdx) pickVenue(i);
    },
  };
}

const trim = (x: number) => String(Math.round(x * 100) / 100);
