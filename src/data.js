// Loads the preprocessed PECD files from public/data and turns them into usable series.
// Values are stored as scaled integers (capacity factor x1000, temperature in 0.1 degC).

const cache = new Map();

async function load(path) {
  if (!cache.has(path)) {
    cache.set(
      path,
      fetch(`/data/${path}`).then((r) => {
        if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
        return r.json();
      }),
    );
  }
  return cache.get(path);
}

export const VARS = {
  spv: { label: "Solar PV", short: "Solar", unit: "%", color: "#FF6428" },
  won: { label: "Wind onshore", short: "Onshore", unit: "%", color: "#3C8CFA" },
  wof: { label: "Wind offshore", short: "Offshore", unit: "%", color: "#003584" },
  t2m: { label: "Temperature", short: "Temp", unit: "°C", color: "#3C465A" },
};

export const CF_VARS = ["spv", "won", "wof"];

export const ICONS = {
  spv: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>`,
  won: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 10v12M9 22h6"/><circle cx="12" cy="9" r="1.4"/><path d="M12 7.6 12.8 2.4M13.2 9.6l4.6 2.6M10.8 9.8l-4.4 3"/></svg>`,
  wof: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v9"/><circle cx="12" cy="8" r="1.3"/><path d="M12 6.7 12.7 2M13.1 8.6l4.2 2.3M10.9 8.8l-4 2.7M2 19c2 0 2-1.3 4-1.3S8 19 10 19s2-1.3 4-1.3 2 1.3 4 1.3 2-1.3 4-1.3M2 22c2 0 2-1.3 4-1.3S8 22 10 22s2-1.3 4-1.3 2 1.3 4 1.3 2-1.3 4-1.3"/></svg>`,
  t2m: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0Z"/><path d="M12 11v6"/></svg>`,
  play: `<svg viewBox="0 0 14 14" fill="currentColor"><path d="M3 1.5v11l9-5.5z"/></svg>`,
  pause: `<svg viewBox="0 0 14 14" fill="currentColor"><path d="M3 1.5h3v11H3zM8 1.5h3v11H8z"/></svg>`,
};

// Colour scales shared by the map and the tile map.
export const SCALES = {
  spv: { min: 0, max: 0.3, colors: ["#F5F7FA", "#FFE0D1", "#FFA47F", "#FF6428"] },
  won: { min: 0, max: 0.7, colors: ["#F5F7FA", "#A0C4E8", "#3C8CFA", "#003584"] },
  wof: { min: 0, max: 0.9, colors: ["#F5F7FA", "#A0C4E8", "#3C8CFA", "#003584"] },
  t2m: { min: -15, max: 30, colors: ["#003584", "#3C8CFA", "#A0C4E8", "#F5F7FA", "#FFC2A9", "#FF6428"] },
};

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

export function colorAt(key, v) {
  if (v == null) return "#E8EDF4";
  const { min, max, colors } = SCALES[key];
  const t = Math.max(0, Math.min(1, (v - min) / (max - min))) * (colors.length - 1);
  const i = Math.min(Math.floor(t), colors.length - 2);
  const a = hex(colors[i]);
  const b = hex(colors[i + 1]);
  const f = t - i;
  return `rgb(${a.map((x, j) => Math.round(x + (b[j] - x) * f)).join(",")})`;
}

// Perceived lightness, to pick dark or light text on a coloured tile.
export function isDark(rgb) {
  const [r, g, b] = rgb.match(/\d+/g).map(Number);
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}

export const scaleLabel = (key, v) => (key === "t2m" ? `${v} °C` : `${Math.round(v * 100)}%`);

function unscale(key, arr) {
  if (!arr) return null;
  const f = key === "t2m" ? 0.1 : 0.001;
  return arr.map((v) => (v == null ? null : v * f));
}

export const loadMeta = () => load("meta.json");

export async function loadCountry(code) {
  const raw = await load(`country/${code}.json`);
  const out = { start: raw.start };
  for (const key of Object.keys(VARS)) out[key] = unscale(key, raw[key]);
  out.length = out.spv?.length ?? out.t2m.length;
  return out;
}

export async function loadYear(year) {
  const raw = await load(`daily/${year}.json`);
  const out = { start: raw.start, days: raw.days };
  for (const key of Object.keys(VARS)) {
    out[key] = {};
    for (const [cc, arr] of Object.entries(raw[key] ?? {})) out[key][cc] = unscale(key, arr);
  }
  return out;
}

// Per-zone wind for countries with several PECD zones; null where the country has a single zone.
export async function loadZones(code) {
  const path = `zones/${code}.json`;
  const raw = await load(path);
  const out = { start: raw.start };
  for (const key of ["won", "wof"]) {
    if (!raw[key]) continue;
    out[key] = Object.entries(raw[key])
      .map(([zone, z]) => ({ zone, share: z.share, mw: z.mw, values: unscale(key, z.values) }))
      .sort((a, b) => b.share - a.share);
  }
  return out;
}

export async function loadHourly(code, year) {
  const raw = await load(`hourly/${code}/${year}.json`);
  const out = { start: raw.start };
  for (const key of CF_VARS) out[key] = unscale(key, raw[key]);
  return out;
}

// ---- dates -----------------------------------------------------------------

const DAY = 86400000;

export const utc = (iso) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
export const dayIndex = (start, iso) => Math.round((utc(iso) - utc(start)) / DAY);
export const isoAt = (start, i) => new Date(utc(start) + i * DAY).toISOString().slice(0, 10);

export function fmtDate(iso, opts = { day: "numeric", month: "short", year: "numeric" }) {
  return new Date(utc(iso)).toLocaleDateString("en-GB", { timeZone: "UTC", ...opts });
}

// Day of year on a 365-day calendar (29 February shares the slot of 28 February).
export function doy365(iso) {
  const d = new Date(utc(iso));
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  let n = Math.round((d - jan1) / DAY);
  const leap = new Date(Date.UTC(d.getUTCFullYear(), 1, 29)).getUTCMonth() === 1;
  if (leap && n >= 59) n -= 1;
  return n;
}

// ---- analysis --------------------------------------------------------------

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Daily climatology over a reference period: p10, p50 and p90 per calendar day,
// pooled over a +-7 day window so the band is smooth.
export function climatology(series, start, from = 1991, to = 2020, half = 7) {
  const buckets = Array.from({ length: 365 }, () => []);
  const i0 = Math.max(0, dayIndex(start, `${from}-01-01`));
  const i1 = Math.min(series.length - 1, dayIndex(start, `${to}-12-31`));
  for (let i = i0; i <= i1; i++) {
    const v = series[i];
    if (v == null) continue;
    const d = doy365(isoAt(start, i));
    for (let k = -half; k <= half; k++) buckets[(d + k + 365) % 365].push(v);
  }
  return buckets.map((b) => {
    b.sort((x, y) => x - y);
    return { p10: quantile(b, 0.1), p50: quantile(b, 0.5), p90: quantile(b, 0.9) };
  });
}

// Weighted renewable capacity factor. Weights are installed capacities (GW);
// technologies without data in a country drop out of the weighting.
export function portfolio(data, weights) {
  const keys = CF_VARS.filter((k) => data[k] && weights[k] > 0);
  const total = keys.reduce((s, k) => s + weights[k], 0);
  if (!total) return null;
  return Array.from({ length: data.length }, (_, i) => {
    let s = 0;
    for (const k of keys) {
      const v = data[k][i];
      if (v == null) return null;
      s += v * weights[k];
    }
    return s / total;
  });
}

// Runs of consecutive days below the threshold, at least minDays long.
export function findEvents(series, start, threshold, minDays) {
  const events = [];
  let runStart = -1;
  const close = (end) => {
    const len = end - runStart;
    if (len >= minDays) {
      let sum = 0;
      let deficit = 0;
      for (let i = runStart; i < end; i++) {
        sum += series[i];
        deficit += threshold - series[i];
      }
      events.push({
        start: isoAt(start, runStart),
        end: isoAt(start, end - 1),
        startIndex: runStart,
        days: len,
        mean: sum / len,
        deficit,
      });
    }
    runStart = -1;
  };
  for (let i = 0; i < series.length; i++) {
    const below = series[i] != null && series[i] < threshold;
    if (below && runStart < 0) runStart = i;
    if (!below && runStart >= 0) close(i);
  }
  if (runStart >= 0) close(series.length);
  return events;
}

// Mean per (year, month) for a daily series. Returns { years, values[yearIdx][month] }.
export function monthlyMeans(series, start) {
  const y0 = Number(start.slice(0, 4));
  const sums = new Map();
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (v == null) continue;
    const iso = isoAt(start, i);
    const key = iso.slice(0, 7);
    const s = sums.get(key) ?? [0, 0];
    s[0] += v;
    s[1] += 1;
    sums.set(key, s);
  }
  const lastYear = Number(isoAt(start, series.length - 1).slice(0, 4));
  const years = [];
  const values = [];
  for (let y = y0; y <= lastYear; y++) {
    years.push(y);
    values.push(
      Array.from({ length: 12 }, (_, m) => {
        const s = sums.get(`${y}-${String(m + 1).padStart(2, "0")}`);
        return s && s[1] >= 20 ? s[0] / s[1] : null;
      }),
    );
  }
  return { years, values };
}

// Mean per calendar year; years with fewer than 360 days are flagged as partial.
export function annualMeans(series, start) {
  const acc = new Map();
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (v == null) continue;
    const y = Number(isoAt(start, i).slice(0, 4));
    const a = acc.get(y) ?? [0, 0];
    a[0] += v;
    a[1] += 1;
    acc.set(y, a);
  }
  return [...acc.entries()].map(([year, [s, n]]) => ({ year, mean: s / n, partial: n < 360 }));
}

export const pct = (v, digits = 0) => (v == null ? "–" : `${(v * 100).toFixed(digits)}%`);
export const degC = (v) => (v == null ? "–" : `${v.toFixed(1)} °C`);
export const fmtVar = (key, v) => (key === "t2m" ? degC(v) : pct(v, 1));
