import { chart, axisCommon, tooltipCommon, FONT, MUTED } from "../charts.js";
import { emptyState, tip } from "../ui.js";

const METRICS = {
  dunkel: { label: "Dunkelflaute days", unit: "days/yr", higherIsWorse: true },
  lowwind: { label: "Low-wind days", unit: "days/yr", higherIsWorse: true },
  spv: { label: "Solar PV", unit: "%", cf: true },
  won: { label: "Wind onshore", unit: "%", cf: true },
  wof: { label: "Wind offshore", unit: "%", cf: true },
};
const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const MODEL_COLORS = ["#3C8CFA", "#33A92F", "#A0C4E8", "#3C465A", "#7FB2F8", "#8BC98A"];

const cache = new Map();
const loadFuture = (cc) => {
  if (!cache.has(cc))
    cache.set(
      cc,
      fetch(`/data/future/${cc}.json`).then((r) => {
        if (!r.ok) throw new Error(`no projections for ${cc} (HTTP ${r.status})`);
        return r.json();
      }),
    );
  return cache.get(cc);
};

// Centred moving average; null where the window is incomplete.
function smooth(arr, w = 11) {
  const h = Math.floor(w / 2);
  return arr.map((_, i) => {
    if (i < h || i + h >= arr.length) return null;
    let s = 0;
    for (let j = i - h; j <= i + h; j++) s += arr[j];
    return s / w;
  });
}

const meanOf = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
const periodMean = (years, arr, a, b) => meanOf(arr.filter((v, i) => v != null && years[i] >= a && years[i] <= b));

// Delta method: each model is compared with its own baseline, and that change is added to today's ERA5 level.
// The models match mean capacity factors but overstate how long calm spells last, so raw counts are not comparable.
const MODEL_BASE = [2015, 2044];
const END = [2071, 2100];

export async function renderFuture(root, state, alive) {
  const meta = state.meta;
  if (!meta.projections) throw new Error("projections are not in this data set yet");
  const proj = meta.projections;
  if (!proj.countries.includes(state.country)) {
    root.innerHTML = emptyState(
      `No projections for ${meta.countries[state.country]}`,
      "The climate indicators need solar and an existing wind fleet with known capacity. This country lacks one of them, so it has no Dunkelflaute or low-wind projection. Pick another country on the tile map.",
    );
    return { onYear: () => {} };
  }
  const data = await loadFuture(state.country);
  if (!alive()) return;
  const name = meta.countries[state.country];
  state.future ??= { scenario: proj.scenarios.at(-1).id, metric: "dunkel" };
  const opts = state.future;
  const available = Object.keys(METRICS).filter((k) => data.hist[k]);
  if (!available.includes(opts.metric)) opts.metric = available[0];

  root.innerHTML = `
    <div class="view" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);grid-template-rows:auto minmax(0,1.25fr) minmax(0,0.75fr)">
      <section class="panel" style="grid-column:1/-1;flex-direction:row;align-items:center;gap:20px;flex-wrap:wrap">
        <div><h2>${name} towards 2100${tip("PECD v4.2 climate projections 2015–2100 from CMIP6 climate models, with the same wind and solar technology as today, so any change comes from the climate alone. SSP2-4.5 is a middle-of-the-road emissions path, SSP5-8.5 a high one.")}</h2>
          <div class="sub">PECD v4.2 climate projections, ${proj.models.length} CMIP6 models, same wind and solar technology as today</div></div>
        <div class="seg" id="scenario">${proj.scenarios
          .map((s) => `<button data-s="${s.id}" class="${s.id === opts.scenario ? "active" : ""}" title="${s.note}">${s.label}</button>`)
          .join("")}</div>
        <div class="seg" id="metric">${available
          .map((k) => `<button data-k="${k}" class="${k === opts.metric ? "active" : ""}">${METRICS[k].label}</button>`)
          .join("")}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><h3 id="mainTitle"></h3>${tip("11-year moving average. Dark blue: ERA5 history. Orange: model mean; thin lines: single models; band: model range. The models are aligned to today's ERA5 level (delta method) because they overstate how long calm spells last.")}<span class="sub">11-year moving average · models aligned to ERA5 ${data.hist.years.at(-1) - 29}–${data.hist.years.at(-1)} · band: model range</span></div>
        <div class="chart" id="main"></div>
      </section>
      <section class="panel accent" style="grid-row:2/4;grid-column:2">
        <div class="panel-head"><h3>Change by 2071–2100${tip("Change between 2015–2044 and 2071–2100 in each model, added to today's ERA5 level (last 30 years). Green: better for supply, red: worse. The note shows the spread between models and how many agree on the direction.")}</h3></div>
        <div class="sub" style="margin-bottom:8px">Each model against its own 2015–2044, applied to today's ERA5 level.
          <span id="scenLabel"></span></div>
        <div class="stats" id="changes"></div>
        <div class="summary" id="summary"></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h3 id="seasonTitle"></h3>${tip("Monthly mean capacity factor: ERA5 1991–2020 against the model mean for 2015–2044 and 2071–2100.")}<span class="sub">monthly mean capacity factor · bars: model mean</span></div>
        <div class="chart" id="season"></div>
      </section>
    </div>`;

  const main = chart(root.querySelector("#main"));
  const season = chart(root.querySelector("#season"));

  function runsFor(scenario) {
    return Object.entries(data.proj.runs[scenario] ?? {});
  }

  function draw() {
    const k = opts.metric;
    const m = METRICS[k];
    const scale = m.cf ? 100 : 1;
    const runs = runsFor(opts.scenario);
    const pYears = data.proj.years;
    const hYears = data.hist.years;
    const allYears = [];
    for (let y = hYears[0]; y <= pYears.at(-1); y++) allYears.push(y);
    const at = (years, arr) => {
      const map = new Map(years.map((y, i) => [y, arr[i]]));
      return allYears.map((y) => (map.has(y) && map.get(y) != null ? map.get(y) * scale : null));
    };
    const [e0, e1] = [data.hist.years.at(-1) - 29, data.hist.years.at(-1)];
    const today = periodMean(hYears, data.hist[k], e0, e1);
    const smoothRuns = runs.map(([id, r]) => {
      const shift = today - periodMean(pYears, r[k], ...MODEL_BASE);
      return [id, at(pYears, smooth(r[k].map((v) => v + shift)))];
    });
    const lo = allYears.map((_, i) => {
      const v = smoothRuns.map(([, s]) => s[i]).filter((x) => x != null);
      return v.length ? Math.min(...v) : null;
    });
    const hi = allYears.map((_, i) => {
      const v = smoothRuns.map(([, s]) => s[i]).filter((x) => x != null);
      return v.length ? Math.max(...v) : null;
    });
    const ens = allYears.map((_, i) => {
      const v = smoothRuns.map(([, s]) => s[i]).filter((x) => x != null);
      return v.length ? meanOf(v) : null;
    });
    const scen = proj.scenarios.find((s) => s.id === opts.scenario);
    root.querySelector("#mainTitle").textContent = `${m.label} in ${name}, ERA5 history and ${scen.label}`;
    root.querySelector("#scenLabel").textContent = `${scen.label} (${scen.note})`;

    main.setOption(
      {
        textStyle: { fontFamily: FONT },
        legend: { top: 0, right: 0, itemWidth: 14, textStyle: { fontFamily: FONT, fontSize: 11 }, data: ["ERA5 history", "Model mean"] },
        grid: { left: 40, right: 10, top: 24, bottom: 22 },
        tooltip: {
          ...tooltipCommon,
          valueFormatter: (v) => (v == null ? "–" : m.cf ? `${v.toFixed(1)}%` : v.toFixed(1)),
        },
        xAxis: {
          type: "category",
          data: allYears,
          ...axisCommon,
          splitLine: { show: false },
          axisLabel: { ...axisCommon.axisLabel, interval: (i, y) => Number(y) % 25 === 0 },
        },
        yAxis: {
          type: "value",
          scale: true,
          ...axisCommon,
          axisLabel: { ...axisCommon.axisLabel, formatter: m.cf ? "{value}%" : "{value}" },
        },
        series: [
          { type: "line", data: lo, stack: "band", stackStrategy: "all", symbol: "none", lineStyle: { opacity: 0 }, silent: true, tooltip: { show: false } },
          {
            type: "line",
            data: hi.map((h, i) => (h == null ? null : h - lo[i])),
            stack: "band", stackStrategy: "all",
            symbol: "none",
            lineStyle: { opacity: 0 },
            areaStyle: { color: "rgba(255,100,40,0.12)" },
            silent: true,
            tooltip: { show: false },
          },
          ...smoothRuns.map(([id, s], i) => ({
            type: "line",
            name: proj.models.find((x) => x.id === id)?.label ?? id,
            data: s,
            symbol: "none",
            lineStyle: { width: 0.8, color: MODEL_COLORS[i % MODEL_COLORS.length], opacity: 0.7 },
            itemStyle: { color: MODEL_COLORS[i % MODEL_COLORS.length] },
          })),
          {
            type: "line",
            name: "ERA5 history (annual)",
            data: at(hYears, data.hist[k]),
            symbol: "none",
            lineStyle: { width: 0.8, color: "#A0C4E8" },
            itemStyle: { color: "#A0C4E8" },
          },
          {
            type: "line",
            name: "ERA5 history",
            data: at(hYears, smooth(data.hist[k])),
            symbol: "none",
            lineStyle: { width: 2.4, color: "#003584" },
            itemStyle: { color: "#003584" },
          },
          {
            type: "line",
            name: "Model mean",
            data: ens,
            symbol: "none",
            lineStyle: { width: 2.6, color: "#FF6428" },
            itemStyle: { color: "#FF6428" },
            markArea: {
              silent: true,
              itemStyle: { color: "rgba(160,196,232,0.12)" },
              label: { color: MUTED, fontSize: 10, position: "insideTop" },
              data: [
                [{ xAxis: String(e0), name: "today" }, { xAxis: String(e1) }],
                [{ xAxis: "2071", name: "end of century" }, { xAxis: "2100" }],
              ],
            },
          },
        ],
      },
      { notMerge: true },
    );

    // Change cards for every metric.
    root.querySelector("#changes").innerHTML = available
      .map((kk) => {
        const mm = METRICS[kk];
        const r = periodMean(hYears, data.hist[kk], e0, e1);
        const ch = runs.map(([, run]) => periodMean(pYears, run[kk], ...END) - periodMean(pYears, run[kk], ...MODEL_BASE));
        const avg = meanOf(ch);
        const rel = (v) => (mm.cf ? v / r : v);
        const fmt = (v) =>
          mm.cf ? `${v >= 0 ? "+" : ""}${(rel(v) * 100).toFixed(1)}%` : `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
        const worse = mm.higherIsWorse ? avg > 0 : avg < 0;
        const agree = ch.filter((v) => Math.sign(v) === Math.sign(avg)).length;
        return `<div class="stat" style="grid-template-columns:1fr auto">
          <span class="stat-name">${mm.label}</span>
          <span class="stat-val ${worse ? "down" : "up"}" style="grid-row:span 1">${fmt(avg)}</span>
          <span class="stat-note" style="grid-column:1/-1">today ${mm.cf ? `${(r * 100).toFixed(1)}%` : `${r.toFixed(1)} ${mm.unit}`} → ${mm.cf ? `${((r + avg) * 100).toFixed(1)}%` : `${(r + avg).toFixed(1)}`} ·
            models ${fmt(Math.min(...ch))} to ${fmt(Math.max(...ch))} · ${agree} of ${ch.length} agree on the sign</span>
        </div>`;
      })
      .join("");

    const dk = (kk) => {
      const r = periodMean(hYears, data.hist[kk], e0, e1);
      const ch = runs.map(([, run]) => periodMean(pYears, run[kk], ...END) - periodMean(pYears, run[kk], ...MODEL_BASE));
      return { r, ch, avg: meanOf(ch) };
    };
    const d = dk("dunkel");
    const w = data.hist.won ? dk("won") : null;
    root.querySelector("#summary").innerHTML = `Under <b>${scen.label}</b>, ${name} goes from <b>${d.r.toFixed(1)}</b> to
      <b>${(d.r + d.avg).toFixed(1)}</b> Dunkelflaute days a year by 2071–2100
      (models ${(d.r + Math.min(...d.ch)).toFixed(1)} to ${(d.r + Math.max(...d.ch)).toFixed(1)}).
      ${w ? `Onshore wind output changes by <b>${((w.avg / w.r) * 100).toFixed(1)}%</b>.` : ""}
      ${
        runs.length < 2
          ? ""
          : d.ch.every((v) => Math.sign(v) === Math.sign(d.avg))
            ? `All ${runs.length} models agree on the direction for Dunkelflaute.`
            : "The models disagree on the direction for Dunkelflaute: plan for the range, not the mean."
      }`;

    // Seasonal cycle for the selected capacity factor (or onshore wind for the day counts).
    const sk = m.cf ? k : data.hist.won ? "won" : "spv";
    root.querySelector("#seasonTitle").textContent = `${METRICS[sk].label} through the year`;
    const periods = Object.keys(runs[0]?.[1].monthly ?? {});
    const ensMonthly = (p) => MONTHS.map((_, i) => meanOf(runs.map(([, run]) => run.monthly[p][sk][i])) * 100);
    season.setOption(
      {
        textStyle: { fontFamily: FONT },
        legend: { top: 0, right: 0, itemWidth: 14, textStyle: { fontFamily: FONT, fontSize: 11 } },
        grid: { left: 6, right: 8, containLabel: true, top: 24, bottom: 20 },
        tooltip: { ...tooltipCommon, valueFormatter: (v) => `${v.toFixed(1)}%` },
        xAxis: { type: "category", data: MONTHS, ...axisCommon, splitLine: { show: false } },
        yAxis: { type: "value", ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: "{value}%" } },
        series: [
          {
            type: "bar",
            name: "1991–2020 (ERA5)",
            data: data.hist.monthly[sk].map((v) => v * 100),
            itemStyle: { color: "#003584" },
            barGap: "10%",
          },
          ...periods.map((p, i) => ({
            type: "bar",
            name: `${p} (models)`,
            data: ensMonthly(p),
            itemStyle: { color: i === periods.length - 1 ? "#FF6428" : "#A0C4E8" },
          })),
        ],
      },
      { notMerge: true },
    );
  }

  root.querySelector("#scenario").addEventListener("click", (e) => {
    if (!e.target.dataset.s) return;
    opts.scenario = e.target.dataset.s;
    for (const b of root.querySelectorAll("#scenario button")) b.classList.toggle("active", b === e.target);
    draw();
  });
  root.querySelector("#metric").addEventListener("click", (e) => {
    if (!e.target.dataset.k) return;
    opts.metric = e.target.dataset.k;
    for (const b of root.querySelectorAll("#metric button")) b.classList.toggle("active", b === e.target);
    draw();
  });

  draw();

  // The selected year does not change the projections.
  return { onYear: () => {} };
}
