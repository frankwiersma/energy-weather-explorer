import { chart, axisCommon, tooltipCommon, FONT } from "../charts.js";
import { VARS, ICONS, loadCountry, climatology, dayIndex, doy365, isoAt, fmtVar, pct } from "../data.js";
import { tip } from "../ui.js";

const KPI_TIPS = {
  spv: "Mean capacity factor of utility-scale fixed solar PV over the year so far: output as a share of installed peak capacity. Compared with the same calendar days in 1991–2020.",
  won: "Mean capacity factor of the existing onshore wind fleet over the year so far, averaged over the PECD onshore zones. Compared with the same calendar days in 1991–2020.",
  wof: "Mean capacity factor of the existing offshore wind fleet over the year so far, averaged over the PECD offshore zones. Compared with the same calendar days in 1991–2020.",
  t2m: "Mean 2 m air temperature over the country for the year so far, against the same calendar days in 1991–2020.",
};

function yearSlice(country, year) {
  const i0 = Math.max(0, dayIndex(country.start, `${year}-01-01`));
  const i1 = Math.min(country.length, dayIndex(country.start, `${year + 1}-01-01`));
  return { i0, i1 };
}

function mean(arr) {
  const v = arr.filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export async function renderCountry(root, state, alive) {
  const country = await loadCountry(state.country);
  if (!alive()) return;
  const name = state.meta.countries[state.country];
  const { i0, i1 } = yearSlice(country, state.year);
  const dates = Array.from({ length: i1 - i0 }, (_, j) => isoAt(country.start, i0 + j));
  const keys = Object.keys(VARS).filter((k) => country[k]);
  const partial = dates.length < 360;

  const kpis = keys.map((k) => {
    const doys = new Set(dates.map(doy365));
    // Reference: the same calendar days in 1991-2020, so a partial year compares fairly.
    const ref = [];
    for (let y = 1991; y <= 2020; y++) {
      const s = yearSlice(country, y);
      for (let i = s.i0; i < s.i1; i++) if (doys.has(doy365(isoAt(country.start, i)))) ref.push(country[k][i]);
    }
    return { k, value: mean(country[k].slice(i0, i1)), ref: mean(ref) };
  });

  root.innerHTML = `
    <div class="view" style="grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:auto repeat(2,minmax(0,1fr))">
      <div class="kpis" style="grid-column:1/-1">
        ${kpis
          .map(({ k, value, ref }) => {
            const diff = value != null && ref != null ? value - ref : null;
            const cls = diff == null || k === "t2m" ? "" : diff >= 0 ? "up" : "down";
            const delta =
              diff == null
                ? ""
                : k === "t2m"
                  ? `<span class="${cls}">${diff >= 0 ? "+" : ""}${diff.toFixed(1)} °C</span> vs 1991–2020`
                  : `<span class="${cls}">${diff >= 0 ? "+" : ""}${((diff / ref) * 100).toFixed(0)}%</span> vs 1991–2020 (${pct(ref, 1)})`;
            return `<div class="kpi" style="border-left-color:${VARS[k].color}">
              <div class="kpi-label">${VARS[k].label} · ${state.year}${partial ? " so far" : ""}${tip(KPI_TIPS[k])}</div>
              <div class="kpi-value">${fmtVar(k, value)}</div>
              <div class="kpi-delta">${delta}</div>
            </div>`;
          })
          .join("")}
      </div>
      ${keys
        .map(
          (k) => `<section class="panel" style="border-left-color:${VARS[k].color}">
            <div class="panel-head"><h3 style="display:flex;gap:6px;align-items:center"><span style="width:18px;height:18px;color:${VARS[k].color};display:inline-flex">${ICONS[k]}</span>${VARS[k].label}${tip("Line: daily value. Light band: normal range, 10th to 90th percentile of the same calendar day (±7 days) in 1991–2020. Dashed: the median. Orange line: the selected date; click a day to move it.")}</h3>
            <span class="sub">daily, with the normal range 1991–2020 · click a day to select it</span></div>
            <div class="chart" id="c-${k}"></div>
          </section>`,
        )
        .join("")}
    </div>`;

  const charts = [];
  for (const k of keys) {
    const clim = climatology(country[k], country.start);
    const band = dates.map((d) => clim[doy365(d)]);
    const isT = k === "t2m";
    const scale = isT ? 1 : 100;
    const c = chart(root.querySelector(`#c-${k}`));
    c.setOption({
      textStyle: { fontFamily: FONT },
      grid: { left: 40, right: 10, top: 8, bottom: 22 },
      tooltip: {
        ...tooltipCommon,
        formatter: (ps) => {
          const j = ps[0].dataIndex;
          return `<b>${dates[j]}</b><br>${VARS[k].label}: ${fmtVar(k, country[k][i0 + j])}<br>Normal: ${fmtVar(k, band[j].p10)} – ${fmtVar(k, band[j].p90)}`;
        },
      },
      xAxis: {
        type: "category",
        data: dates,
        ...axisCommon,
        splitLine: { show: false },
        axisLabel: {
          ...axisCommon.axisLabel,
          interval: (i, d) => d.endsWith("-01"),
          formatter: (d) => new Date(d).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }),
        },
      },
      yAxis: {
        type: "value",
        ...axisCommon,
        min: isT ? null : 0,
        axisLabel: { ...axisCommon.axisLabel, formatter: isT ? "{value}°" : "{value}%" },
      },
      series: [
        { type: "line", data: band.map((b) => b.p10 * scale), stack: "band", symbol: "none", lineStyle: { opacity: 0 }, silent: true },
        {
          type: "line",
          data: band.map((b) => (b.p90 - b.p10) * scale),
          stack: "band",
          symbol: "none",
          lineStyle: { opacity: 0 },
          areaStyle: { color: "rgba(160, 196, 232, 0.35)" },
          silent: true,
        },
        { type: "line", data: band.map((b) => b.p50 * scale), symbol: "none", lineStyle: { color: "#A0C4E8", width: 1.2, type: "dashed" }, silent: true },
        {
          type: "line",
          data: country[k].slice(i0, i1).map((v) => (v == null ? null : v * scale)),
          symbol: "none",
          lineStyle: { color: VARS[k].color, width: 1.5 },
          markLine: {
            silent: true,
            symbol: "none",
            animation: false,
            label: { show: false },
            lineStyle: { color: "#FF6428", width: 1.5, type: "solid" },
            data: [{ xAxis: state.date }],
          },
        },
      ],
    });
    c.getZr().on("click", (e) => {
      const j = Math.round(c.convertFromPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY])[0]);
      if (dates[j]) state.set({ date: dates[j] });
    });
    charts.push(c);
  }

  return {
    onDate: (iso) => {
      for (const c of charts) c.setOption({ series: [{}, {}, {}, { markLine: { data: [{ xAxis: iso }] } }] });
    },
  };
}
