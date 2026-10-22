import { chart, axisCommon, tooltipCommon, FONT, MUTED } from "../charts.js";
import { dayIndex, isoAt, fmtDate, pct } from "../data.js";
import { emptyState, tip } from "../ui.js";

let windData = null;

async function loadWind() {
  windData ??= fetch("/data/wind.json")
    .then((r) => r.json())
    .then((raw) => ({
      start: raw.start,
      gw: raw.gw,
      countries: Object.fromEntries(
        Object.entries(raw.countries).map(([cc, a]) => [cc, Float32Array.from(a, (x) => (x == null ? NaN : x / 1000))]),
      ),
    }));
  return windData;
}

function distanceKm([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

// Capacity factor of the pooled fleet: each country weighted by its installed wind capacity.
function pooled(members, wind, n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let w = 0;
    for (const cc of members) {
      const v = wind.countries[cc][i];
      if (!Number.isNaN(v)) {
        s += v * wind.gw[cc];
        w += wind.gw[cc];
      }
    }
    out[i] = w ? s / w : NaN;
  }
  return out;
}

function corr(a, b) {
  let n = 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(a[i]) || Number.isNaN(b[i])) continue;
    sa += a[i];
    sb += b[i];
    n += 1;
  }
  const ma = sa / n;
  const mb = sb / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(a[i]) || Number.isNaN(b[i])) continue;
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  return cov / Math.sqrt(va * vb);
}

export async function renderEurope(root, state, alive) {
  const wind = await loadWind();
  if (!alive()) return;
  const meta = state.meta;
  const home = state.country;
  if (!wind.countries[home]) {
    root.innerHTML = emptyState(
      `No wind fleet for ${meta.countries[home]}`,
      "Pooling needs an operating wind fleet with known turbine locations and capacity, and the open turbine databases list none for this country. Pick a country with wind on the tile map.",
    );
    return;
  }
  const n = wind.countries[home].length;
  const years = n / 365.25;
  const byDistance = Object.keys(wind.countries)
    .filter((cc) => meta.centroids[cc] && wind.gw[cc])
    .sort((a, b) => distanceKm(meta.centroids[home], meta.centroids[a]) - distanceKm(meta.centroids[home], meta.centroids[b]));
  const maxSteps = Math.min(16, byDistance.length);
  state.europe ??= { size: 6, threshold: 0.1 };
  const opts = state.europe;
  opts.size = Math.min(opts.size, maxSteps);

  root.innerHTML = `
    <div class="view" style="grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:auto minmax(0,1.15fr) minmax(0,0.85fr)">
      <section class="panel">
        <div class="panel-head"><h2>Is the wind always blowing somewhere?${tip("Each country's wind fleet (onshore and offshore zones weighted by installed capacity) is pooled with its neighbours, weighted by their installed wind capacity (ENTSO-E ERAA 2025, expected for 2028). Germany therefore counts far more than Luxembourg.")}</h2></div>
        <div class="sub" style="margin-bottom:6px">Pool the wind fleet of ${meta.countries[home]} (${wind.gw[home]} GW) with its nearest neighbours,
          weighted by installed capacity, and count the days on which the pool as a whole stays calm. The pooled countries
          are outlined on the tile map.</div>
        <div class="slider-row">
          <label class="slider"><span class="slider-top"><span>Countries in the pool${tip("The pool adds the nearest countries first, by the distance between country centres.")}</span><b id="size-v"></b></span>
            <input type="range" id="size" min="1" max="${maxSteps}" step="1" value="${opts.size}" /></label>
          <label class="slider"><span class="slider-top"><span>Calm when${tip("A day is calm when the pooled fleet delivers less than this share of its installed capacity, as a daily mean.")}</span><b id="thr-v"></b></span>
            <input type="range" id="thr" min="0.03" max="0.25" step="0.01" value="${opts.threshold}" /></label>
        </div>
      </section>
      <section class="panel accent" style="justify-content:center">
        <div id="callout"></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h3>Low-wind days per year as the pool grows${tip("Bar n is the pool of the n nearest countries, weighted by installed wind capacity. Orange: the current pool. Neighbours with the same weather barely help; countries whose weather differs do.")}</h3><span class="sub">nearest first, weighted by capacity · click a bar to set the pool</span></div>
        <div class="chart" id="ladder"></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h3>Do neighbours go calm together?${tip("Correlation of daily wind output between the 12 nearest countries. 1 means they go calm at the same time; near 0 means one often blows while the other is calm.")}</h3><span class="sub">correlation of daily wind output, ${meta.firstYear}–${meta.lastYear} · low means they balance each other</span></div>
        <div class="chart" id="matrix"></div>
      </section>
      <section class="panel" style="grid-column:1/-1">
        <div class="panel-head"><h3 id="yearTitle"></h3>${tip("Daily wind capacity factor of the selected country's fleet and of the pooled fleet, in the year chosen on the timeline. Shaded days: calm in the selected country.")}<span class="sub">daily wind capacity factor · shaded: calm at home</span></div>
        <div class="chart" id="year"></div>
      </section>
    </div>`;

  const ladder = chart(root.querySelector("#ladder"));
  const matrix = chart(root.querySelector("#matrix"));
  const yearChart = chart(root.querySelector("#year"));

  const pools = Array.from({ length: maxSteps }, (_, i) => byDistance.slice(0, i + 1));
  const poolSeries = pools.map((p) => pooled(p, wind, n));

  function lowDays(series, thr) {
    let c = 0;
    for (const v of series) if (v < thr) c += 1;
    return c / years;
  }

  function draw() {
    const thr = opts.threshold;
    const counts = poolSeries.map((s) => lowDays(s, thr));
    const pool = pools[opts.size - 1];
    const poolGw = pool.reduce((a, cc) => a + wind.gw[cc], 0);
    root.querySelector("#size-v").textContent = `${opts.size} · ${pool.join(" ")} · ${Math.round(poolGw)} GW`;
    root.querySelector("#thr-v").textContent = `under ${pct(thr)} of capacity`;
    const alone = counts[0];
    const now = counts[opts.size - 1];
    const cut = alone ? 1 - now / alone : 0;
    root.querySelector("#callout").innerHTML = `
      <div class="sub" style="text-transform:uppercase;font-weight:700;letter-spacing:.04em;display:flex;align-items:center">Low-wind days per year${tip("Calm days per year, averaged over the whole record: the selected country on its own against the pool.")}</div>
      <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin:4px 0 6px">
        <span class="big-number">${alone.toFixed(0)}</span><span class="sub">${meta.countries[home]} alone</span>
        <span style="font-size:28px;color:var(--orange)">→</span>
        <span class="big-number">${now.toFixed(now < 10 ? 1 : 0)}</span><span class="sub">pool of ${opts.size}</span>
      </div>
      <div class="callout">${cut >= 0
          ? `Sharing wind across <b>${opts.size} countries</b> removes <b>${(cut * 100).toFixed(0)}%</b> of the calm days.`
          : `This pool has <b>${(-cut * 100).toFixed(0)}% more</b> calm days than ${meta.countries[home]} alone: its members go calm together.`}
        Averaged over ${meta.firstYear}–${meta.lastYear}.</div>`;

    ladder.setOption(
      {
        textStyle: { fontFamily: FONT },
        grid: { left: 6, right: 8, containLabel: true, top: 14, bottom: 26 },
        tooltip: {
          ...tooltipCommon,
          formatter: (p) => `<b>${pools[p[0].dataIndex].join(", ")}</b><br>${p[0].value.toFixed(1)} low-wind days per year`,
        },
        xAxis: {
          type: "category",
          data: byDistance.slice(0, maxSteps).map((cc, i) => (i === 0 ? cc : `+${cc}`)),
          ...axisCommon,
          splitLine: { show: false },
          axisLabel: { ...axisCommon.axisLabel, interval: 0, fontSize: 11 },
        },
        yAxis: { type: "value", ...axisCommon },
        series: [
          {
            type: "bar",
            barCategoryGap: "20%",
            data: counts.map((v, i) => ({
              value: v,
              itemStyle: { color: i === opts.size - 1 ? "#FF6428" : i < opts.size ? "#003584" : "#A0C4E8" },
            })),
            label: { show: true, position: "top", fontSize: 10, color: MUTED, formatter: (p) => p.value.toFixed(0) },
          },
        ],
      },
      { notMerge: true },
    );

    drawYear(pool);
    state.refreshRail();
  }

  function drawMatrix() {
    const set = byDistance.slice(0, 12);
    const data = [];
    for (let i = 0; i < set.length; i++)
      for (let j = 0; j < set.length; j++)
        data.push([j, i, i === j ? 1 : corr(wind.countries[set[i]], wind.countries[set[j]])]);
    matrix.setOption({
      textStyle: { fontFamily: FONT },
      grid: { left: 34, right: 54, top: 4, bottom: 22 },
      tooltip: {
        ...tooltipCommon,
        trigger: "item",
        formatter: (p) => `<b>${set[p.data[1]]} × ${set[p.data[0]]}</b><br>correlation ${p.data[2].toFixed(2)}`,
      },
      xAxis: { type: "category", data: set, ...axisCommon, splitLine: { show: false }, axisLabel: { ...axisCommon.axisLabel, interval: 0, fontSize: 10 } },
      yAxis: { type: "category", data: set, inverse: true, ...axisCommon, splitLine: { show: false }, axisLabel: { ...axisCommon.axisLabel, interval: 0, fontSize: 10 } },
      visualMap: {
        min: 0,
        max: 1,
        right: 0,
        top: "middle",
        itemHeight: 140,
        itemWidth: 10,
        calculable: false,
        inRange: { color: ["#F5F7FA", "#A0C4E8", "#3C8CFA", "#003584"] },
        text: ["1", "0"],
        textStyle: { color: MUTED, fontSize: 11 },
      },
      series: [
        {
          type: "heatmap",
          data,
          label: { show: true, fontSize: 9, formatter: (p) => p.data[2].toFixed(1), color: "#1A2B4A" },
          itemStyle: { borderColor: "#fff", borderWidth: 1 },
        },
      ],
    });
  }

  function drawYear(pool) {
    const y = state.year;
    const i0 = Math.max(0, dayIndex(wind.start, `${y}-01-01`));
    const i1 = Math.min(n, dayIndex(wind.start, `${y + 1}-01-01`));
    const dates = Array.from({ length: i1 - i0 }, (_, j) => isoAt(wind.start, i0 + j));
    const homeS = Array.from(wind.countries[home].slice(i0, i1));
    const poolS = Array.from(poolSeries[opts.size - 1].slice(i0, i1));
    const calm = [];
    let s = -1;
    homeS.forEach((v, j) => {
      const low = v < opts.threshold;
      if (low && s < 0) s = j;
      if ((!low || j === homeS.length - 1) && s >= 0) {
        calm.push([{ xAxis: dates[s] }, { xAxis: dates[low ? j : j - 1] }]);
        s = -1;
      }
    });
    const homeLow = homeS.filter((v) => v < opts.threshold).length;
    const poolLow = poolS.filter((v) => v < opts.threshold).length;
    root.querySelector("#yearTitle").textContent =
      `${y}: ${meta.countries[home]} calm on ${homeLow} days, the pool of ${opts.size} on ${poolLow}`;
    yearChart.setOption(
      {
        textStyle: { fontFamily: FONT },
        legend: { top: 0, right: 0, itemWidth: 14, textStyle: { fontFamily: FONT, fontSize: 11 } },
        grid: { left: 6, right: 8, containLabel: true, top: 22, bottom: 22 },
        tooltip: { ...tooltipCommon, valueFormatter: (v) => (v == null ? "–" : `${v.toFixed(0)}%`) },
        xAxis: {
          type: "category",
          data: dates,
          ...axisCommon,
          splitLine: { show: false },
          axisLabel: {
            ...axisCommon.axisLabel,
            interval: (i, d) => d.endsWith("-01"),
            formatter: (d) => fmtDate(d, { month: "short" }),
          },
        },
        yAxis: { type: "value", min: 0, ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: "{value}%" } },
        series: [
          {
            type: "line",
            name: meta.countries[home],
            data: homeS.map((v) => (Number.isNaN(v) ? null : v * 100)),
            symbol: "none",
            lineStyle: { color: "#A0C4E8", width: 1.2 },
            itemStyle: { color: "#A0C4E8" },
            markArea: { silent: true, itemStyle: { color: "rgba(255,100,40,0.13)" }, data: calm },
          },
          {
            type: "line",
            name: `Pool of ${opts.size}`,
            data: poolS.map((v) => (Number.isNaN(v) ? null : v * 100)),
            symbol: "none",
            lineStyle: { color: "#003584", width: 2 },
            itemStyle: { color: "#003584" },
            markLine: {
              silent: true,
              symbol: "none",
              lineStyle: { color: "#FF6428", type: "dashed" },
              label: { formatter: "threshold", position: "insideEndTop", fontSize: 11, color: MUTED },
              data: [{ yAxis: opts.threshold * 100 }],
            },
          },
        ],
      },
      { notMerge: true },
    );
  }

  root.querySelector("#size").addEventListener("input", (e) => {
    opts.size = Number(e.target.value);
    draw();
  });
  root.querySelector("#thr").addEventListener("input", (e) => {
    opts.threshold = Number(e.target.value);
    draw();
  });
  ladder.on("click", (p) => {
    opts.size = p.dataIndex + 1;
    root.querySelector("#size").value = opts.size;
    draw();
  });

  drawMatrix();
  draw();
  return { pool: () => pools[opts.size - 1], onYear: () => drawYear(pools[opts.size - 1]) };
}
