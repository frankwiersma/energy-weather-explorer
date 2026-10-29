import { chart, axisCommon, tooltipCommon, FONT, MUTED } from "../charts.js";
import { VARS, loadCountry, portfolio, monthlyMeans, pct, fmtVar } from "../data.js";
import { tip } from "../ui.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export async function renderYears(root, state, alive) {
  const country = await loadCountry(state.country);
  if (!alive()) return;
  const meta = state.meta;
  const name = meta.countries[state.country];
  const weights = meta.weights?.[state.country]?.gw ?? { spv: 1, won: 1, wof: 1 };
  const series = { mix: portfolio(country, weights) };
  for (const k of Object.keys(VARS)) if (country[k]) series[k] = country[k];
  const labels = { mix: "Wind + solar mix", ...Object.fromEntries(Object.entries(VARS).map(([k, v]) => [k, v.label])) };
  state.yearsVar = series[state.yearsVar] ? state.yearsVar : "mix";

  root.innerHTML = `
    <div class="view" style="grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);grid-template-rows:minmax(0,1fr) minmax(0,1fr)">
      <section class="panel" style="grid-row:1/3">
        <div class="panel-head"><h2>Weather years in ${name}${tip("Each cell is a monthly mean against the 1991–2020 average for that month. For wind and solar, blue means more output and orange less; for temperature, orange is warmer. Click a cell to open that month.")}</h2>
          <div class="seg" id="chips">${Object.keys(series)
            .map((k) => `<button data-k="${k}" class="${k === state.yearsVar ? "active" : ""}">${labels[k]}</button>`)
            .join("")}</div></div>
        <div class="sub">Every month against the 1991–2020 average for that month. Click a cell to open that year.</div>
        <div class="chart" id="heat"></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h3>Annual mean${tip("Mean over each complete calendar year. Orange: the selected year.")}</h3><span class="sub">full years · orange is the selected year</span></div>
        <div class="chart" id="annual"></div>
      </section>
      <section class="panel accent">
        <div class="panel-head"><h3 id="winterTitle"></h3>${tip("December to February means, ranked from low to high, with the difference from 1991–2020. Click a row to open that winter.")}<span class="sub">December to February, low to high</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Winter</th><th class="num">Mean</th><th class="num">vs 1991–2020</th></tr></thead>
          <tbody id="winters"></tbody>
        </table></div>
      </section>
    </div>`;

  const heat = chart(root.querySelector("#heat"));
  const annual = chart(root.querySelector("#annual"));
  let years = [];
  let ann = [];
  let annStyle = {};
  const annData = () =>
    ann.map((a) => ({
      value: a[1] * annStyle.scale,
      itemStyle: { color: Number(a[0]) === state.year ? "#FF6428" : annStyle.base },
    }));

  function draw() {
    const k = state.yearsVar;
    const isT = k === "t2m";
    const mm = monthlyMeans(series[k], country.start);
    years = mm.years;
    const values = mm.values;
    const ref = MONTHS.map((_, m) => {
      const v = years.map((y, i) => (y >= 1991 && y <= 2020 ? values[i][m] : null)).filter((x) => x != null);
      return v.reduce((a, b) => a + b, 0) / v.length;
    });
    const anomaly = (v, m) => (v == null ? null : isT ? v - ref[m] : v / ref[m] - 1);
    const data = [];
    years.forEach((y, i) => values[i].forEach((v, m) => v != null && data.push([m, i, anomaly(v, m), v])));
    const lim = isT ? 4 : k === "dem" ? 0.15 : 0.5;
    const fmtA = (a) => (isT ? `${a >= 0 ? "+" : ""}${a.toFixed(1)} °C` : `${a >= 0 ? "+" : ""}${(a * 100).toFixed(0)}%`);

    heat.setOption(
      {
        textStyle: { fontFamily: FONT },
        grid: { left: 40, right: 64, top: 22, bottom: 4 },
        tooltip: {
          ...tooltipCommon,
          trigger: "item",
          formatter: (p) => {
            const [m, i, a, v] = p.data;
            return `<b>${MONTHS[m]} ${years[i]}</b><br>${labels[k]}: ${fmtVar(k === "mix" ? "spv" : k, v)}<br>${fmtA(a)} vs 1991–2020`;
          },
        },
        xAxis: { type: "category", data: MONTHS, ...axisCommon, splitLine: { show: false }, position: "top" },
        yAxis: {
          type: "category",
          data: years,
          inverse: true,
          ...axisCommon,
          splitLine: { show: false },
          axisLabel: { ...axisCommon.axisLabel, interval: (i, y) => Number(y) % 10 === 0 },
        },
        visualMap: {
          type: "continuous",
          min: -lim,
          max: lim,
          dimension: 2,
          right: 0,
          top: "middle",
          itemHeight: 180,
          itemWidth: 10,
          calculable: false,
          inRange: {
            color: isT || k === "dem"
              ? ["#003584", "#A0C4E8", "#F5F7FA", "#FFC2A9", "#FF6428"]
              : ["#FF6428", "#FFC2A9", "#F5F7FA", "#A0C4E8", "#003584"],
          },
          text: isT ? [`+${lim}°`, `−${lim}°`] : [`+${lim * 100}%`, `−${lim * 100}%`],
          textStyle: { color: MUTED, fontFamily: FONT, fontSize: 11 },
        },
        series: [
          {
            type: "heatmap",
            data,
            itemStyle: { borderColor: "#fff", borderWidth: 0.4 },
            emphasis: { itemStyle: { borderColor: "#1A2B4A", borderWidth: 1 } },
          },
        ],
      },
      { notMerge: true },
    );

    const full = years.map((y, i) => [y, values[i]]).filter(([, v]) => v.every((x) => x != null));
    ann = full.map(([y, v]) => [String(y), v.reduce((a, b) => a + b, 0) / 12]);
    annStyle = { scale: isT ? 1 : 100, base: isT ? "#A0C4E8" : "#3C8CFA" };
    const scale = annStyle.scale;
    annual.setOption(
      {
        textStyle: { fontFamily: FONT },
        grid: { left: 40, right: 8, top: 8, bottom: 22 },
        tooltip: { ...tooltipCommon, valueFormatter: (v) => (isT ? `${v.toFixed(1)} °C` : `${v.toFixed(1)}%`) },
        xAxis: { type: "category", data: ann.map((a) => a[0]), ...axisCommon, splitLine: { show: false } },
        yAxis: { type: "value", scale: true, ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: isT ? "{value}°" : "{value}%" } },
        series: [
          {
            type: "bar",
            data: annData(),
          },
        ],
      },
      { notMerge: true },
    );

    const idx = new Map(years.map((y, i) => [y, i]));
    const refW = (ref[11] + ref[0] + ref[1]) / 3;
    const winters = [];
    for (const y of years) {
      const prev = idx.get(y - 1);
      if (prev == null) continue;
      const v = [values[prev][11], values[idx.get(y)][0], values[idx.get(y)][1]];
      if (v.some((x) => x == null)) continue;
      const m = (v[0] + v[1] + v[2]) / 3;
      winters.push({ label: `${y - 1}/${String(y).slice(2)}`, year: y, mean: m, diff: isT ? m - refW : m / refW - 1 });
    }
    winters.sort((a, b) => (k === "dem" ? b.mean - a.mean : a.mean - b.mean));
    root.querySelector("#winterTitle").textContent = isT ? "Coldest winters" : k === "dem" ? "Highest-demand winters" : k === "spv" ? "Darkest winters" : "Weakest winters";
    root.querySelector("#winters").innerHTML = winters
      .map(
        (w) => `<tr data-y="${w.year}" class="${w.year === state.year ? "selected" : ""}"><td>${w.label}</td>
          <td class="num">${isT ? fmtVar("t2m", w.mean) : pct(w.mean, 1)}</td><td class="num">${fmtA(w.diff)}</td></tr>`,
      )
      .join("");
  }

  root.querySelector("#chips").addEventListener("click", (e) => {
    if (!e.target.dataset.k) return;
    state.yearsVar = e.target.dataset.k;
    for (const b of root.querySelectorAll("#chips button")) b.classList.toggle("active", b.dataset.k === state.yearsVar);
    draw();
  });
  root.querySelector("#winters").addEventListener("click", (e) => {
    const y = Number(e.target.closest("tr")?.dataset.y);
    if (y) state.set({ view: "country", date: `${y}-01-15` });
  });
  heat.on("click", (p) => {
    const y = years[p.data[1]];
    state.set({ view: "country", date: `${y}-${String(p.data[0] + 1).padStart(2, "0")}-15` });
  });

  draw();

  return {
    onYear: () => {
      annual.setOption({ series: [{ data: annData() }] });
      for (const tr of root.querySelectorAll("#winters tr")) tr.classList.toggle("selected", Number(tr.dataset.y) === state.year);
    },
  };
}
