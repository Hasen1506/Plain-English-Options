// Sparklines for the asset list, from Derive's public/get_index_chart_data
// (hourly index candles). Pure functions so they can be unit-tested.

/** Close prices, oldest first, from a get_index_chart_data answer. Junk rows are dropped. */
export function parseIndexChart(r: unknown): number[] {
  const rows = Array.isArray(r) ? r : Array.isArray((r as { result?: unknown })?.result) ? (r as { result: unknown[] }).result : [];
  const pts: { t: number; p: number }[] = [];
  for (const x of rows) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const p = Number(o.close_price ?? o.price);
    const t = Number(o.timestamp ?? o.timestamp_bucket);
    if (Number.isFinite(p) && p > 0 && Number.isFinite(t)) pts.push({ t, p });
  }
  pts.sort((a, b) => a.t - b.t);
  return pts.map((x) => x.p);
}

/** SVG path for a sparkline in a w×h box, or null when there is not enough data to draw one. */
export function sparkPath(values: number[], w = 64, h = 22, pad = 2): string | null {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return null;
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  const step = (w - pad * 2) / (v.length - 1);
  return v
    .map((x, i) => {
      const X = pad + i * step;
      const Y = hi === lo ? h / 2 : pad + (1 - (x - lo) / span) * (h - pad * 2);
      return `${i ? "L" : "M"}${X.toFixed(1)} ${Y.toFixed(1)}`;
    })
    .join("");
}

/** The whole sparkline as inline SVG (coloured by direction), or "" when there is no data. */
export function sparkSvg(values: number[], w = 64, h = 22): string {
  const d = sparkPath(values, w, h);
  if (!d) return "";
  const up = values[values.length - 1]! >= values[0]!;
  return `<svg class="x-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="${up ? "#22a45a" : "#d0453a"}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** Params for the last 24 h of hourly candles ending at `nowMs`. */
export const indexChartParams = (currency: string, nowMs: number) => {
  const end = Math.floor(nowMs / 1000);
  return { currency, start_timestamp: end - 86_400, end_timestamp: end, period: 3600 };
};

/** "+1.2%" / "−0.7%" / "0.0%": a 24h change as a one-decimal percent, no sign on a flat 0.0. */
export function changeText(ch: number): string {
  const r = (ch * 100).toFixed(1);
  const v = Number(r);
  return v > 0 ? "+" + r + "%" : v < 0 ? r + "%" : "0.0%";
}
