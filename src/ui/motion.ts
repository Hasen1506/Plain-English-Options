// Small motion helpers: popover spring-in / fade-out, number roll, pill resize,
// slider fill. Everything is skipped when the user prefers reduced motion.

import { canRoll, easeOut, rollText } from "../lib/roll.ts";

export const reducedMotion = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Spring the popover in (scale + fade), growing from the pill that opened it. */
export function popIn(pop: HTMLElement, originX: number): void {
  pop.style.setProperty("--ox", Math.max(16, originX) + "px");
  pop.classList.remove("is-in");
  if (reducedMotion()) return;
  void pop.offsetWidth; // restart the animation
  pop.classList.add("is-in");
}

/** Fade a copy of the popover out while the real one is already hidden (ids stripped, inert). */
export function popOut(pop: HTMLElement): void {
  if (pop.hidden || reducedMotion() || !pop.parentElement) return;
  const ghost = pop.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("id");
  ghost.removeAttribute("role");
  ghost.querySelectorAll("[id]").forEach((e) => e.removeAttribute("id"));
  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("inert", "");
  ghost.classList.remove("is-in");
  ghost.classList.add("is-out");
  pop.parentElement.insertBefore(ghost, pop);
  setTimeout(() => ghost.remove(), 160);
}

const runs = new WeakMap<HTMLElement, { to: string; raf: number }>();
const lastNum = new WeakMap<HTMLElement, string>(); // last text with a number, to roll from after a "…"
const RAF = (f: FrameRequestCallback) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(f) : (setTimeout(() => f(Date.now()), 16) as unknown as number));
const CAF = (id: number) => (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id));
const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Animate a pill's width from w0 to its natural width (spring), then let it size itself again. */
function springWidth(pill: HTMLElement, w0: number): void {
  pill.style.transition = "none";
  pill.style.width = "";
  const w1 = pill.offsetWidth;
  if (Math.abs(w1 - w0) < 1 || reducedMotion()) return;
  pill.style.transition = "none";
  pill.style.width = w0 + "px";
  void pill.offsetWidth;
  pill.style.transition = "width .24s cubic-bezier(.34,1.4,.64,1)";
  pill.style.width = w1 + "px";
  pill.classList.add("is-sizing");
  const done = () => {
    pill.style.transition = "";
    pill.style.width = "";
    pill.classList.remove("is-sizing");
  };
  clearTimeout(Number(pill.dataset.sizeT ?? 0));
  pill.dataset.sizeT = String(setTimeout(done, 280));
}

/**
 * Set an element's text. With `animate`, a number in it counts from the old value to the
 * new one (about 0.4 s); with `pill`, that pill's width springs to fit the new text.
 */
export function setText(el: HTMLElement, to: string, o: { animate?: boolean; pill?: HTMLElement | null } = {}): void {
  const cur = runs.get(el);
  if (cur) {
    if (cur.to === to) return;
    CAF(cur.raf);
    runs.delete(el);
  }
  const shown = el.textContent ?? "";
  if (shown === to && !cur) return;
  const from = canRoll(shown, to) ? shown : (lastNum.get(el) ?? shown);
  if (/\d/.test(to)) lastNum.set(el, to);
  const w0 = o.pill ? o.pill.offsetWidth : 0;
  el.textContent = to;
  if (o.pill) springWidth(o.pill, w0);
  if (!o.animate || reducedMotion() || !canRoll(from, to)) return;
  const t0 = clock(), D = 420;
  const step = () => {
    const t = (clock() - t0) / D;
    el.textContent = rollText(from, to, easeOut(t));
    if (t < 1) runs.set(el, { to, raf: RAF(step) });
    else runs.delete(el);
  };
  step();
}

/** Paint a range input's filled part (CSS var --p) to match its value. */
export function fillRange(rg: HTMLInputElement): void {
  const min = +rg.min || 0, max = +rg.max || 100;
  const p = max > min ? ((+rg.value - min) / (max - min)) * 100 : 0;
  const c = Math.min(100, Math.max(0, p));
  for (const el of [rg, rg.parentElement]) {
    el?.style.setProperty("--p", c.toFixed(2) + "%");
    el?.style.setProperty("--pn", (c / 100).toFixed(4));
  }
}
