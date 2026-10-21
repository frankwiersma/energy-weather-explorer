import {
  VARS,
  ICONS,
  SCALES,
  loadMeta,
  loadYear,
  loadCountry,
  colorAt,
  isDark,
  scaleLabel,
  dayIndex,
  doy365,
  isoAt,
  fmtDate,
} from "./data.js";
import { beginLayer, disposeLayer, echarts, FONT, MUTED, tooltipCommon } from "./charts.js";
import { renderMap } from "./views/map.js";
import { renderCountry } from "./views/country.js";
import { renderDunkel } from "./views/dunkel.js";
import { renderEurope } from "./views/europe.js";
import { renderYears } from "./views/years.js";
import { renderFuture } from "./views/future.js";
import { renderAbout } from "./views/about.js";
import { initTips, tip } from "./ui.js";

const VIEWS = {
  map: renderMap,
  country: renderCountry,
  dunkel: renderDunkel,
  europe: renderEurope,
  years: renderYears,
  future: renderFuture,
};

// Tile cartogram of Europe: [column, row] on a 9 x 8 grid.
const TILES = {
  IS: [0, 0], NO: [4, 0], SE: [5, 0], FI: [6, 0],
  IE: [1, 1], UK: [2, 1], DK: [4, 1], EE: [6, 1],
  NL: [3, 2], DE: [4, 2], PL: [5, 2], LV: [6, 2],
  BE: [3, 3], CZ: [4, 3], SK: [5, 3], LT: [6, 3],
  FR: [2, 4], LU: [3, 4], AT: [4, 4], HU: [5, 4], RO: [6, 4],
  PT: [1, 5], ES: [2, 5], CH: [3, 5], SI: [4, 5], HR: [5, 5], RS: [6, 5], BG: [7, 5], TR: [8, 5],
  LI: [3, 6], IT: [4, 6], ME: [5, 6], MK: [6, 6], CY: [8, 6],
  MT: [4, 7], AL: [5, 7], EL: [6, 7],
};

const $ = (id) => document.getElementById(id);
const app = $("app");

const state = {
  meta: null,
  view: "map",
  country: "NL",
  year: null,
  date: null,
  metric: "won",
  set,
  refreshRail: () => updateRail(),
};

// ---------------------------------------------------------------------------
// State changes. Country, year and view re-render the view; date and metric
// changes go to the view's own handlers when it has them.

let viewHooks = {};
let renderToken = 0;

function clampDate(year, date) {
  const md = (date ?? `${year}-01-15`).slice(5);
  let iso = `${year}-${md === "02-29" ? "02-28" : md}`;
  if (iso > state.meta.lastDate) iso = state.meta.lastDate;
  return iso;
}

function set(patch) {
  const prev = { ...state };
  Object.assign(state, patch);
  if (patch.year != null && patch.date == null) state.date = clampDate(state.year, prev.date);
  if (patch.date != null) state.year = Number(state.date.slice(0, 4));

  // A view that can show another year in place says so with onYear; otherwise it is rebuilt.
  const yearChanged = state.year !== prev.year;
  const structural = state.view !== prev.view || state.country !== prev.country || (yearChanged && !viewHooks.onYear);
  writeHash();
  updateRail(prev);
  if (state.country !== prev.country || state.metric !== prev.metric) drawTimeline();
  else if (yearChanged) highlightTimelineYear();
  updateCaption();
  if (structural) return render();
  if (yearChanged) viewHooks.onYear(state.year);
  if (state.date !== prev.date) viewHooks.onDate?.(state.date);
  if (state.metric !== prev.metric) {
    if (viewHooks.onMetric) viewHooks.onMetric(state.metric);
    else if (viewHooks.usesMetric) render();
  }
}

// The new view is built in a hidden layer on top of the current one and swapped in when it is
// ready, so changing year or country does not flash an empty page.
async function render() {
  const token = ++renderToken;
  for (const b of $("tabs").querySelectorAll("button")) b.classList.toggle("active", b.dataset.view === state.view);
  viewHooks = {};
  if (!app.querySelector(".layer")) app.innerHTML = '<div class="loading">Loading data…</div>';
  const layer = document.createElement("div");
  layer.className = "layer pending";
  app.appendChild(layer);
  const charts = beginLayer();
  let hooks = {};
  try {
    hooks = (await VIEWS[state.view](layer, state, () => token === renderToken)) ?? {};
  } catch (err) {
    console.error(err);
    layer.innerHTML = `<div class="loading">Could not load data: ${err.message}</div>`;
  }
  // ECharts paints on the next frame; swap only once the new charts are on screen.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (token !== renderToken) {
    disposeLayer(charts);
    layer.remove();
    return;
  }
  for (const old of [...app.children]) {
    if (old === layer) continue;
    disposeLayer(old.__charts);
    old.remove();
  }
  layer.__charts = charts;
  layer.classList.remove("pending");
  viewHooks = hooks;
  updateRail();
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (VIEWS[p.get("view")]) state.view = p.get("view");
  if (state.meta.countries[p.get("country")]) state.country = p.get("country");
  if (VARS[p.get("metric")]) state.metric = p.get("metric");
  const d = p.get("date");
  if (d && d >= `${state.meta.firstYear}-01-01` && d <= state.meta.lastDate) state.date = d;
  if (!state.date) state.date = state.meta.lastDate;
  state.year = Number(state.date.slice(0, 4));
}

function writeHash() {
  const p = new URLSearchParams({ view: state.view, country: state.country, date: state.date, metric: state.metric });
  history.replaceState(null, "", `#${p}`);
}

// ---------------------------------------------------------------------------
// Rail: metric switch and tile map.

function buildRail() {
  $("metricSwitch").innerHTML = Object.entries(VARS)
    .map(
      ([k, v]) =>
        `<button role="radio" data-k="${k}" aria-checked="false" title="${v.label}">${ICONS[k]}<span>${v.short}</span></button>`,
    )
    .join("");
  $("metricSwitch").addEventListener("click", (e) => {
    const k = e.target.closest("button")?.dataset.k;
    if (k) set({ metric: k });
  });

  $("tilemap").innerHTML = Object.entries(TILES)
    .filter(([cc]) => state.meta.countries[cc])
    .map(
      ([cc, [c, r]]) =>
        `<button class="tile" role="option" data-cc="${cc}" style="grid-column:${c + 1};grid-row:${r + 1}"
          title="${state.meta.countries[cc]}">${cc}</button>`,
    )
    .join("");
  $("tilemap").addEventListener("click", (e) => {
    const cc = e.target.closest(".tile")?.dataset.cc;
    if (!cc) return;
    if (viewHooks.onTile) viewHooks.onTile(cc);
    else set({ country: cc });
  });
}

let railToken = 0;

async function updateRail() {
  $("railCountry").textContent = state.meta.countries[state.country];
  $("railDate").textContent = fmtDate(state.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  for (const b of $("metricSwitch").querySelectorAll("button")) {
    const on = b.dataset.k === state.metric;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", String(on));
  }
  const s = SCALES[state.metric];
  $("tileLegend").innerHTML = `<span>${scaleLabel(state.metric, s.min)}</span>
    <span class="ramp" style="background:linear-gradient(90deg, ${s.colors.join(",")})"></span>
    <span>${scaleLabel(state.metric, s.max)}</span>`;

  const token = ++railToken;
  const year = await loadYear(state.year);
  if (token !== railToken) return;
  const di = dayIndex(year.start, state.date);
  const pool = viewHooks.pool?.() ?? [];
  for (const tile of $("tilemap").querySelectorAll(".tile")) {
    const cc = tile.dataset.cc;
    const v = year[state.metric]?.[cc]?.[di];
    const col = colorAt(state.metric, v);
    tile.style.background = col;
    tile.classList.toggle("dark", v != null && isDark(col));
    tile.classList.toggle("selected", cc === state.country);
    tile.classList.toggle("in-pool", pool.includes(cc));
    tile.title = `${state.meta.countries[cc]}: ${v == null ? "no data" : VARS[state.metric].unit === "%" ? `${(v * 100).toFixed(0)}%` : `${v.toFixed(1)} °C`}`;
  }
}


// ---------------------------------------------------------------------------
// Bottom timeline: one bar per year, the anomaly of the selected metric
// against 1991-2020 over the same calendar days. Click or drag to pick a year.

let timeline;
let tlData = [];
let tlToken = 0;

async function drawTimeline() {
  const token = ++tlToken;
  const country = await loadCountry(state.country);
  if (token !== tlToken) return;
  const k = state.metric;
  const series = country[k] ?? country.won ?? country.spv;
  const isT = k === "t2m";

  // Mean per calendar day over 1991-2020.
  const sum = new Float64Array(365);
  const cnt = new Uint16Array(365);
  for (let y = 1991; y <= 2020; y++) {
    const i0 = dayIndex(country.start, `${y}-01-01`);
    const i1 = dayIndex(country.start, `${y + 1}-01-01`);
    for (let i = i0; i < i1; i++) {
      const v = series[i];
      if (v == null) continue;
      const d = doy365(isoAt(country.start, i));
      sum[d] += v;
      cnt[d] += 1;
    }
  }
  const norm = Array.from(sum, (s, d) => s / cnt[d]);

  tlData = [];
  for (let y = state.meta.firstYear; y <= state.meta.lastYear; y++) {
    const i0 = dayIndex(country.start, `${y}-01-01`);
    const i1 = Math.min(series.length, dayIndex(country.start, `${y + 1}-01-01`));
    let dv = 0;
    let dn = 0;
    let n = 0;
    for (let i = i0; i < i1; i++) {
      if (series[i] == null) continue;
      const d = doy365(isoAt(country.start, i));
      dv += series[i] - norm[d];
      dn += norm[d];
      n += 1;
    }
    tlData.push({ year: y, anomaly: n ? (isT ? dv / n : dv / dn) : null, partial: n < 360 });
  }

  const lim = isT ? 1.5 : 0.15;
  timeline.setOption(
    {
      textStyle: { fontFamily: FONT },
      grid: { left: 4, right: 4, top: 6, bottom: 18 },
      tooltip: {
        ...tooltipCommon,
        formatter: (ps) => {
          const d = tlData[ps[0].dataIndex];
          if (d.anomaly == null) return `<b>${d.year}</b>`;
          const a = isT ? `${d.anomaly >= 0 ? "+" : ""}${d.anomaly.toFixed(2)} °C` : `${d.anomaly >= 0 ? "+" : ""}${(d.anomaly * 100).toFixed(1)}%`;
          return `<b>${d.year}${d.partial ? " (so far)" : ""}</b><br>${VARS[k].label}: ${a} vs 1991–2020`;
        },
      },
      xAxis: {
        type: "category",
        data: tlData.map((d) => d.year),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: MUTED, fontSize: 10, interval: (i, y) => Number(y) % 10 === 0 },
      },
      yAxis: { type: "value", show: false, min: -lim, max: lim },
      series: [
        {
          type: "bar",
          barCategoryGap: "18%",
          data: tlData.map((d) => ({
            value: d.anomaly,
            itemStyle: {
              color: tlColor(d.anomaly, lim, isT),
              opacity: d.partial ? 0.55 : 1,
            },
          })),
          markLine: {
            silent: true,
            symbol: "none",
            animation: false,
            label: { show: false },
            lineStyle: { color: "#FF6428", width: 2, type: "solid" },
            data: [{ xAxis: String(state.year) }],
          },
        },
      ],
    },
    { notMerge: true },
  );
}

function tlColor(a, lim, isT) {
  if (a == null) return "#E8EDF4";
  const t = Math.max(-1, Math.min(1, a / lim));
  // Temperature: warm is orange. Capacity factor: more output is blue.
  const pos = isT ? [255, 100, 40] : [0, 53, 132];
  const neg = isT ? [60, 140, 250] : [255, 100, 40];
  const base = [221, 229, 240];
  const c = t >= 0 ? pos : neg;
  const f = Math.abs(t);
  return `rgb(${base.map((b, i) => Math.round(b + (c[i] - b) * f)).join(",")})`;
}

function highlightTimelineYear() {
  timeline.setOption({ series: [{ markLine: { data: [{ xAxis: String(state.year) }] } }] });
}

function updateCaption() {
  $("tlYear").textContent = state.year;
  const k = state.metric;
  $("tlCaption").innerHTML = `<b>${VARS[k].label}</b> per year in ${state.meta.countries[state.country]},
    against 1991–2020. ${k === "t2m" ? "Orange is warmer" : "Blue is more output, orange less"}. Drag to change the year.`;
}

function setupTimeline() {
  timeline = echarts.init($("timeline"), "calm");
  new ResizeObserver(() => timeline.resize()).observe($("timeline"));
  const zr = timeline.getZr();
  let dragging = false;
  let pending = null;
  const yearAt = (x) => {
    const idx = timeline.convertFromPixel({ gridIndex: 0 }, [x, 10])?.[0];
    return tlData[Math.max(0, Math.min(tlData.length - 1, Math.round(idx)))]?.year;
  };
  const pick = (x) => {
    const y = yearAt(x);
    if (!y || y === state.year) return;
    $("tlYear").textContent = y;
    timeline.setOption({ series: [{ markLine: { data: [{ xAxis: String(y) }] } }] });
    clearTimeout(pending);
    pending = setTimeout(() => set({ year: y }), 110);
  };
  zr.on("mousedown", (e) => {
    dragging = true;
    pick(e.offsetX);
  });
  zr.on("mousemove", (e) => dragging && pick(e.offsetX));
  zr.on("mouseup", () => (dragging = false));
  zr.on("globalout", () => (dragging = false));

  $("yearPrev").addEventListener("click", () => state.year > state.meta.firstYear && set({ year: state.year - 1 }));
  $("yearNext").addEventListener("click", () => state.year < state.meta.lastYear && set({ year: state.year + 1 }));
  document.addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, textarea")) return;
    if (e.key === "[" && state.year > state.meta.firstYear) set({ year: state.year - 1 });
    if (e.key === "]" && state.year < state.meta.lastYear) set({ year: state.year + 1 });
  });
}

// ---------------------------------------------------------------------------

function setupDrawer() {
  const drawer = $("drawer");
  const open = (on) => {
    drawer.classList.toggle("open", on);
    drawer.setAttribute("aria-hidden", String(!on));
  };
  $("infoBtn").addEventListener("click", () => {
    renderAbout($("drawerBody"), state);
    open(true);
  });
  $("drawerClose").addEventListener("click", () => open(false));
  drawer.addEventListener("click", (e) => e.target === drawer && open(false));
  document.addEventListener("keydown", (e) => e.key === "Escape" && open(false));
}

function staticTips() {
  $("tipCountry").innerHTML = tip(
    "Click a tile to pick a country. Tiles are coloured by the selected metric on the selected day; hover a tile for its value.",
  );
  $("tipMetric").innerHTML = tip(
    "What the tiles, the map and the timeline show. Solar and wind are capacity factors: output as a share of installed capacity. Temperature is the 2 m air temperature.",
  );
  $("tipTimeline").innerHTML = tip(
    "One bar per year: how far the metric was from its 1991–2020 average over the same calendar days, so the running year compares fairly. Click or drag to change year, or press [ and ].",
  );
}

async function init() {
  initTips();
  staticTips();
  state.meta = await loadMeta();
  readHash();
  buildRail();
  setupTimeline();
  setupDrawer();
  $("tabs").addEventListener("click", (e) => {
    const view = e.target.closest("button")?.dataset.view;
    if (view) set({ view });
  });
  window.addEventListener("hashchange", () => {
    const prev = { ...state };
    readHash();
    if (prev.view !== state.view || prev.country !== state.country || prev.date !== state.date || prev.metric !== state.metric) {
      updateRail();
      drawTimeline();
      updateCaption();
      render();
    }
  });
  updateRail();
  drawTimeline();
  updateCaption();
  render();
}

init().catch((err) => {
  app.innerHTML = `<div class="loading">Could not start: ${err.message}</div>`;
});
