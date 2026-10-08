// Number formatting shared by the sentence, review and portfolio.

export function money(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const d = a >= 100 || a === 0 ? 0 : 2;
  return (v < 0 ? "−$" : "$") + a.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export const usd2 = (v: number): string =>
  !Number.isFinite(v) ? "—" : (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const signedMoney = (v: number): string => (v >= 0 ? "+" : "−") + money(Math.abs(v));

/** Asset price with precision that suits its size ($96,841 · $2.45 · $0.712). */
export function price(v: number | null | undefined): string {
  if (v == null || !(v > 0) || !Number.isFinite(v)) return "…";
  const d = v >= 100 ? 0 : v >= 1 ? 2 : 3;
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export const pct = (p: number): string => (Number.isFinite(p) ? Math.round(p * 100) + "%" : "—");

/** Signed whole-percent move from `from` to `to`, e.g. "↑15%". */
export function movePct(from: number, to: number): { text: string; down: boolean } {
  if (!(from > 0) || !(to > 0)) return { text: "", down: false };
  const p = Math.round((to / from - 1) * 100);
  return { text: (p >= 0 ? "↑" : "↓") + Math.abs(p) + "%", down: p < 0 };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface ExpiryLabel {
  key: string;
  expiryMs: number;
  days: number;
  short: string; // "Nov 27" or "Mar 26 2027"
  long: string; // "Nov 27, 2026"
  list: string; // "Fri, Nov 27 · 50 days · monthly"
  kind: "daily" | "weekly" | "monthly" | "quarterly";
}

/** Label an expiry key (YYYYMMDD) relative to `now`. Pure; UTC throughout. */
export function expiryLabel(key: string, expiryMs: number, now: number, sameYear = new Date(now).getUTCFullYear()): ExpiryLabel {
  const dt = new Date(expiryMs);
  const y = dt.getUTCFullYear(), m = dt.getUTCMonth(), d = dt.getUTCDate(), wd = dt.getUTCDay();
  const days = Math.max(0, Math.round((expiryMs - now) / 86_400_000));
  const lastFriOfMonth = wd === 5 && d + 7 > new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const kind = wd !== 5 ? "daily" : lastFriOfMonth ? (m % 3 === 2 ? "quarterly" : "monthly") : "weekly";
  const mo = MONTHS[m]!;
  return {
    key,
    expiryMs,
    days,
    short: `${mo} ${d}` + (y !== sameYear ? ` ${y}` : ""),
    long: `${mo} ${d}, ${y}`,
    list: `${DAYS[wd]}, ${mo} ${d} · ${days} day${days === 1 ? "" : "s"} · ${kind}`,
    kind,
  };
}

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
