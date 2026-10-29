import { chart, axisCommon, tooltipCommon, FONT } from "../charts.js";
import { VARS, ICONS, loadCountry, loadZones, climatology, dayIndex, doy365, isoAt, fmtVar, pct, demandGW } from "../data.js";
import { tip } from "../ui.js";

const KPI_TIPS = {
  spv: "Mean capacity factor of the national PV fleet over the year so far: output as a share of installed peak capacity. The four PECD PV types (industrial and residential rooftop, utility fixed and tracking) are weighted by each country's capacity per type. Compared with the same calendar days in 1991–2020.",
  won: "Mean capacity factor of the existing onshore wind fleet over the year so far. PECD delivers wind per zone; zones are weighted by their installed capacity. Compared with the same calendar days in 1991–2020.",
  wof: "Mean capacity factor of the operating offshore wind fleet over the year so far. PECD delivers wind per zone; zones are weighted by their installed capacity, zones without turbines do not count. Compared with the same calendar days in 1991–2020.",
  t2m: "Mean 2 m air temperature over the country for the year so far, against the same calendar days in 1991–2020.",
  dem: "Electricity demand estimated from temperature with a degree-day model (Van Duinen et al., 2026): more demand for every degree below 15 °C (heating) and above 20 °C (cooling). Shown against the 1991–2020 average day; in GW scaled to ERAA 2025's average demand for 2028. Weather alone, so no growth, holidays or weekdays.",
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

const ZONE_COLORS = ["#003584", "#3C8CFA", "#33A92F", "#FF6428", "#A0C4E8", "#3C465A", "#7FB2F8", "#8BC98A", "#FFA47F", "#1A2B4A"];

export async function renderCountry(root, state, alive) {
  const hasZones = state.meta.zones?.includes(state.country);
  const [country, zones] = await Promise.all([loadCountry(state.country), hasZones ? loadZones(state.country) : null]);
  if (!alive()) return;
  state.zoneView ??= {};
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
    <div class="view" style="grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:auto repeat(${Math.ceil(keys.length / 2)},minmax(0,1fr))">
      <div class="kpis" style="grid-column:1/-1">
        ${kpis
          .map(({ k, value, ref }) => {
            const diff = value != null && ref != null ? value - ref : null;
            const cls = diff == null || k === "t2m" || k === "dem" ? "" : diff >= 0 ? "up" : "down";
            const delta =
              diff == null
                ? ""
                : k === "t2m"
                  ? `<span class="${cls}">${diff >= 0 ? "+" : ""}${diff.toFixed(1)} °C</span> vs 1991–2020`
                  : k === "dem"
                    ? `<span>${diff >= 0 ? "+" : ""}${((diff / ref) * 100).toFixed(1)}%</span> vs 1991–2020${demandGW(state.meta, state.country, value) != null ? ` · ${demandGW(state.meta, state.country, value).toFixed(1)} GW average` : ""}`
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
          (k, i) => `<section class="panel" style="border-left-color:${VARS[k].color}${keys.length % 2 && i === keys.length - 1 ? ";grid-column:1/-1" : ""}">
            <div class="panel-head"><h3 style="display:flex;gap:6px;align-items:center"><span style="width:18px;height:18px;color:${VARS[k].color};display:inline-flex">${ICONS[k]}</span>${VARS[k].label}${tip("Line: daily value. Light band: normal range, 10th to 90th percentile of the same calendar day (±7 days) in 1991–2020. Dashed: the median. Orange line: the selected date; click a day to move it.")}</h3>
            <span class="sub" id="sub-${k}"></span>
            ${zones?.[k] ? `<div class="seg" data-zone-toggle="${k}" style="margin-left:auto"><button data-mode="national">National</button><button data-mode="zones">Per zone</button></div>${tip(`PECD delivers wind per zone. National: the zones weighted by their installed capacity (${zones[k].length} zones with turbines). Per zone: each zone's own capacity factor, with its share of the national capacity in the legend.`)}` : ""}</div>
            <div class="chart" id="c-${k}"></div>
          </section>`,
        )
        .join("")}
    </div>`;

  const charts = {};

  function draw(k) {
    const c = charts[k];
    const isT = k === "t2m";
    const scale = isT ? 1 : 100;
    const perZone = zones?.[k] && state.zoneView[k] === "zones";
    for (const b of root.querySelectorAll(`[data-zone-toggle="${k}"] button`)) b.classList.toggle("active", (b.dataset.mode === "zones") === !!perZone);
    root.querySelector(`#sub-${k}`).textContent = perZone
      ? "daily per PECD zone, share of national capacity in the legend"
      : `daily, with the normal range 1991–2020 · click a day to select it`;
    const national = country[k].slice(i0, i1).map((v) => (v == null ? null : v * scale));
    const marker = {
      silent: true,
      symbol: "none",
      animation: false,
      label: { show: false },
      lineStyle: { color: "#FF6428", width: 1.5, type: "solid" },
      data: [{ xAxis: state.date }],
    };
    let series;
    let legend;
    let tooltipFmt;
    if (perZone) {
      const zi = Math.max(0, dayIndex(zones.start, dates[0]));
      const list = zones[k];
      series = [
        ...list.map((z, n) => ({
          type: "line",
          name: `${z.zone} ${Math.round(z.share * 100)}%`,
          data: z.values.slice(zi, zi + dates.length).map((v) => (v == null ? null : v * 100)),
          symbol: "none",
          lineStyle: { width: 1, color: ZONE_COLORS[n % ZONE_COLORS.length], opacity: 0.8 },
          itemStyle: { color: ZONE_COLORS[n % ZONE_COLORS.length] },
        })),
        { type: "line", name: "National", data: national, symbol: "none", lineStyle: { color: "#1A2B4A", width: 2.2 }, itemStyle: { color: "#1A2B4A" }, markLine: marker },
      ];
      legend = { type: "scroll", top: 0, right: 0, left: 40, itemWidth: 12, textStyle: { fontFamily: FONT, fontSize: 10 } };
      tooltipFmt = undefined;
    } else {
      const clim = climatology(country[k], country.start);
      const band = dates.map((d) => clim[doy365(d)]);
      series = [
        { type: "line", data: band.map((b) => b.p10 * scale), stack: "band", stackStrategy: "all", symbol: "none", lineStyle: { opacity: 0 }, silent: true },
        {
          type: "line",
          data: band.map((b) => (b.p90 - b.p10) * scale),
          stack: "band",
          stackStrategy: "all",
          symbol: "none",
          lineStyle: { opacity: 0 },
          areaStyle: { color: "rgba(160, 196, 232, 0.35)" },
          silent: true,
        },
        { type: "line", data: band.map((b) => b.p50 * scale), symbol: "none", lineStyle: { color: "#A0C4E8", width: 1.2, type: "dashed" }, silent: true },
        { type: "line", data: national, symbol: "none", lineStyle: { color: VARS[k].color, width: 1.5 }, markLine: marker },
      ];
      legend = undefined;
      tooltipFmt = (ps) => {
        const j = ps[0].dataIndex;
        return `<b>${dates[j]}</b><br>${VARS[k].label}: ${fmtVar(k, country[k][i0 + j])}<br>Normal: ${fmtVar(k, band[j].p10)} – ${fmtVar(k, band[j].p90)}`;
      };
    }
    c.setOption(
      {
        textStyle: { fontFamily: FONT },
        legend,
        grid: { left: 6, right: 10, top: perZone ? 26 : 8, bottom: 22, containLabel: true },
        tooltip: { ...tooltipCommon, ...(tooltipFmt ? { formatter: tooltipFmt } : { valueFormatter: (v) => (v == null ? "–" : `${v.toFixed(1)}%`) }) },
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
          min: isT || k === "dem" ? null : 0,
          scale: k === "dem",
          axisLabel: { ...axisCommon.axisLabel, formatter: isT ? "{value}°" : "{value}%" },
        },
        series,
      },
      { notMerge: true },
    );
  }

  for (const k of keys) {
    const c = chart(root.querySelector(`#c-${k}`));
    charts[k] = c;
    draw(k);
    c.getZr().on("click", (e) => {
      if (!c.containPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY])) return;
      const j = Math.round(c.convertFromPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY])[0]);
      if (dates[j]) state.set({ date: dates[j] });
    });
  }
  root.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-zone-toggle] button");
    if (!btn) return;
    const k = btn.parentElement.dataset.zoneToggle;
    state.zoneView[k] = btn.dataset.mode;
    draw(k);
  });

  return {
    onDate: () => {
      for (const k of keys) draw(k);
    },
  };
}
