// The Perps tab: "I think ETH goes UP, risking $100 at 3×" → one perp order.
// Venue-agnostic: everything exchange-specific (markets, accounts, signing,
// orders, history) goes through a PerpVenue adapter (src/venues). The builder
// maths is shared (quotePerp); a venue picker appears once two venues exist.

import { QUOTE_MAX_AGE_MS, TICKER_REFRESH_MS } from "../config.ts";
import { friendlyWalletError } from "../net/signer.ts";
import { quotePerp, type PerpDir, type PerpMarket, type PerpOrderType, type PerpQuote, type PerpTicker } from "../lib/perp.ts";
import { perpConfirmState } from "../lib/guards.ts";
import { escapeHtml as h, money } from "../lib/format.ts";
import type { PerpVenue, VenueAccount, VenueMarginCheck } from "../venues/types.ts";
import { fundingText, marketsHtml, perpConfirmHtml, perpPanelHtml, perpPrice, pctSigned } from "./perpViews.ts";

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
  let tkAt = 0, tkBusy = false, instBusy = false, gen = 0;
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
  };

  const inst = () => insts.find((i) => i.name === P.name) ?? null;
  const oneTap = () => venue().signer()?.oneTap ?? false;
  /** The account this market's orders go to (the venue picks one that can trade it). */
  const sub = (): VenueAccount | null => (venue().connected() ? venue().selectedAccount(P.name) : null);

  function quote(): { q: PerpQuote | null; fail: string | null } {
    const i = inst(), t = tk[P.name];
    if (!i || !t) return { q: null, fail: insts.length ? `No live price for ${P.name}` : "Loading perpetual markets…" };
    const s = sub();
    const r = quotePerp({
      inst: i,
      ticker: t,
      dir: P.dir,
      risk: P.risk,
      leverage: P.lev,
      orderType: P.orderType,
      limitPrice: P.limit,
      postOnly: P.postOnly,
      takeProfit: P.tp,
      stopLoss: P.sl,
      slippage: venue().slippage,
      headroomMM: s?.maintenanceMargin ?? null,
      headroomIM: s?.initialMargin ?? null,
      existing: s?.positions.find((p) => p.instrument === P.name)?.amount ?? 0,
      leverageCap: d.settings().leverageCap,
    });
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
    if (instBusy || insts.length) return;
    instBusy = true;
    const g = gen;
    venue()
      .markets()
      .then((list) => {
        if (g !== gen) return;
        insts = list.filter((i) => i.isActive);
        if (!insts.some((i) => i.name === P.name) && insts[0]) P.name = insts[0].name;
        render();
      })
      .catch(() => {})
      .finally(() => (instBusy = false));
  }
  function loadTickers(force = false) {
    if (tkBusy || (!force && d.now() - tkAt < TICKER_REFRESH_MS)) return;
    tkBusy = true;
    const g = gen;
    venue()
      .tickers()
      .then((r) => {
        if (g !== gen) return;
        tk = r;
        tkAt = d.now();
        render();
      })
      .catch(() => {})
      .finally(() => (tkBusy = false));
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
      maxCost: v.isMainnet() ? d.settings().maxCost : null,
      leverageCap: d.settings().leverageCap,
    });
    const pick = document.getElementById("perpSub") as HTMLSelectElement | null;
    if (pick)
      pick.onchange = () => {
        venue().selectAccount(Number(pick.value));
        P.marginKey = "";
        render();
      };
    const mk = document.getElementById("perpNewSub");
    if (mk) mk.onclick = () => venue().newAccount(P.name);
    if (focusId) document.getElementById(focusId)?.focus();
    setConfirm();
    maybeMargin(q);
  }
  function renderConfirmBox() {
    $("perpConfirmBox").innerHTML = perpConfirmHtml({ mainnet: venue().isMainnet(), netName: venue().networkName(), connected: venue().connected(), dryRun: venue().caps.dryRun });
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
  function renderMarkets() {
    $("perpMarketsBox").innerHTML = marketsHtml(insts, tk, P.name);
    $("perpMarketsBox")
      .querySelectorAll<HTMLButtonElement>("[data-pick]")
      .forEach((b) => (b.onclick = () => pickMarket(b.dataset.pick!)));
  }
  function render() {
    if (!visible) return;
    const { q } = quote();
    renderSentence(q);
    renderPanel();
    renderMarkets();
  }
  function rerenderAll() {
    if (!visible) return;
    const sig = `${venue().id}|${venue().networkName()}|${venue().connected()}`;
    if (sig !== confirmSig) {
      confirmSig = sig;
      renderConfirmBox();
    }
    $("perpNetNote").hidden = !venue().isMainnet();
    renderVenues();
    render();
  }

  function pickMarket(name: string) {
    if (name === P.name) return;
    P.name = name;
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
    pop.hidden = true;
    P.open = null;
    document.querySelectorAll("#perps .x-pill.is-on").forEach((b) => {
      b.classList.remove("is-on");
      b.setAttribute("aria-expanded", "false");
    });
  }
  function slider(cap: string, val: number, min: number, max: number, step: number, unit: string, onSet: (v: number) => void, l: string, r: string) {
    pop.innerHTML =
      `<p class="x-pop__cap">${h(cap)}</p><label class="x-field"><span>${h(unit)}</span><input type="text" inputmode="decimal" autocomplete="off" enterkeyhint="done" id="ppIn" aria-label="Value"><small>type or drag</small></label>` +
      `<input class="x-range" type="range" id="ppRg" aria-label="Slider"><div class="x-ends"><span>${h(l)}</span><b></b><span>${h(r)}</span></div>`;
    const inp = $<HTMLInputElement>("ppIn"), rg = $<HTMLInputElement>("ppRg");
    rg.min = String(min);
    rg.max = String(max);
    rg.step = String(step);
    rg.value = String(val);
    inp.value = String(val);
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
      pop.innerHTML =
        '<ul class="x-list" id="ppMarketList">' +
        insts
          .map((i, k) => {
            const t = tk[i.name];
            return `<li><button type="button" data-k="${k}"${i.name === P.name ? ' class="is-sel"' : ""}><span><b>${h(i.currency)}</b> ${h(perpPrice(t?.mark))}</span><em>${h(t ? fundingText(t.fundingRate).split(" · ")[1] ?? "" : "")} funding</em></button></li>`;
          })
          .join("") +
        "</ul>";
      pop.querySelectorAll<HTMLButtonElement>("button[data-k]").forEach(
        (b) =>
          (b.onclick = () => {
            pickMarket(insts[+b.dataset.k!]!.name);
            closePop();
          }),
      );
    }
    if (kind === "risk") slider("Money you put in (margin)", P.risk, 5, 10000, 5, "$", (v) => set({ risk: v }), "$5", "$10,000");
    if (kind === "lev") {
      const i = inst();
      const max = Math.max(1, Math.min(d.settings().leverageCap, i?.maxLeverage ?? 1));
      slider(`Leverage · your cap ${d.settings().leverageCap}× · exchange max ${i ? trim(i.maxLeverage) : "?"}×`, Math.min(P.lev, max), 1, Math.floor(max * 2) / 2, 0.5, "×", (v) => set({ lev: v }), "1×", `${trim(Math.floor(max * 2) / 2)}×`);
    }
    pop.hidden = false;
    const root = $("perps").getBoundingClientRect(), r = btn.getBoundingClientRect();
    pop.style.left = Math.max(0, Math.min(r.left - root.left, document.documentElement.clientWidth - 20 - root.left - pop.offsetWidth)) + "px";
    pop.style.top = r.bottom - root.top + 8 + "px";
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

  function renderVenues() {
    const box = $("venuePick");
    box.hidden = d.venues.length < 2; // one venue: no picker
    if (box.hidden) return;
    box.innerHTML = d.venues.map((v, i) => `<button type="button" data-venue="${i}" aria-pressed="${i === venueIdx}">${h(v.name)}</button>`).join("");
    box.querySelectorAll<HTMLButtonElement>("[data-venue]").forEach(
      (b) =>
        (b.onclick = () => {
          const i = Number(b.dataset.venue);
          if (i === venueIdx) return;
          venueIdx = i;
          gen++;
          insts = [];
          tk = {};
          tkAt = 0;
          P.margin = null;
          P.marginKey = "";
          confirmSig = "";
          loadInstruments();
          loadTickers(true);
          rerenderAll();
        }),
    );
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
      loadInstruments();
      loadTickers(true);
      rerenderAll();
    },
    hide() {
      visible = false;
      closePop();
    },
    /** Network switched or socket reopened: forget market data. */
    reset() {
      gen++;
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
      if (venue().isLive()) loadTickers();
      setConfirm();
    },
    /** Wallet / subaccount changed. */
    walletChanged() {
      P.marginKey = "";
      P.margin = null;
      rerenderAll();
    },
    state: () => ({ ...P, venue: venue().id, quote: quote().q, markets: insts.map((i) => i.name), scope: venue().accountScope(P.name), oneTap: oneTap() }),
    venue,
    data: () => ({ insts, tk }),
  };
}

const trim = (x: number) => String(Math.round(x * 100) / 100);
