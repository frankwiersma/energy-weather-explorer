import { chart, axisCommon, tooltipCommon, FONT } from "../charts.js";
import { VARS, CF_VARS, loadOutlook, pct } from "../data.js";
import { emptyState, tip } from "../ui.js";
import { BANDS, LEGEND_GRADIENT, createWindMap } from "../windmap.js";

const HOUR = 3600e3;
const THRESHOLD = 0.06; // the app's default Dunkelflaute threshold
const SOURCES = {
  pecd: { label: "PECD", color: "#003584", note: "published capacity factors" },
  harmonie: { label: "HARMONIE runs", color: "#3C8CFA", note: "first day of each earlier forecast run" },
  forecast: { label: "Forecast", color: "#FF6428", note: "newest HARMONIE run" },
};
const RANGES = { 3: "3 days", 10: "10 days", 28: "4 weeks" };

const local = (t, opts) => new Date(t).toLocaleString("en-GB", { timeZone: "Europe/Amsterdam", ...opts });
const when = (t) => local(t, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

let geoReady;

export async function renderOutlook(root, state, alive) {
  if (state.country !== "NL") {
    root.innerHTML = emptyState(
      "The outlook covers the Netherlands",
      "It combines the KNMI HARMONIE forecast, which is run for the Netherlands and the southern North Sea, with the Dutch PECD zones. Pick <b>NL</b> on the map to see it.",
    );
    return {};
  }
  geoReady ??= fetch("/data/europe.geojson").then((r) => r.json());
  const [o, geo] = await Promise.all([loadOutlook(), geoReady]);
  if (!alive()) return {};

  const t0 = Date.parse(o.start);
  const times = Array.from({ length: o.hours }, (_, i) => t0 + i * HOUR);
  const cf = Object.fromEntries(Object.entries(o.cf).map(([k, a]) => [k, a.map((v) => (v == null ? null : v / 1000))]));
  const normal = Object.fromEntries(
    Object.entries(o.normal).map(([k, b]) => [k, Object.fromEntries(Object.entries(b).map(([p, a]) => [p, a.map((v) => v / 1000)]))]),
  );
  const fc = o.segments.find((s) => s.source === "forecast");
  const runT = Date.parse(o.run);
  const runIndex = Math.round((runT - t0) / HOUR);
  const totalGw = CF_VARS.reduce((s, k) => s + (o.gw[k] ?? 0), 0);
  const sourceAt = (i) => o.segments.find((s) => i >= s.from && i <= s.to)?.source;
  const opts = (state.outlook ??= { days: 10 });
  const skill = o.skill.harmonie
    ? ` Checked against PECD on archived HARMONIE runs of ${Number(o.start.slice(0, 4))}: over the first forecast day the mean error is ${CF_VARS.map((k) => `${(o.skill.harmonie[k].mae * 100).toFixed(1)} points for ${VARS[k].short.toLowerCase()}`).join(", ")} (correlation ${Math.min(...CF_VARS.map((k) => o.skill.harmonie[k].r)).toFixed(2)} or better).`
    : "";

  root.innerHTML = `
    <div class="view outlook" style="grid-template-columns:minmax(0,1fr) var(--map-w, 36%);grid-template-rows:auto auto minmax(0,1fr)">
      <section class="panel" style="grid-column:1/-1">
        <div class="panel-head">
          <h2>Outlook for the Netherlands${tip("Wind and solar output of the Dutch fleet over the past weeks and the next 60 hours. The past comes from PECD where it is published, then from the first day of earlier HARMONIE runs; the future is the newest KNMI HARMONIE forecast. Weather is turned into capacity factors with curves fitted on ERA5 against PECD, and HARMONIE is scaled to reproduce PECD, so all parts are on the same scale as the rest of the app." + skill)}</h2>
          <span class="sub">HARMONIE run ${when(runT)} · updated ${local(Date.parse(o.generated.replace("Z", ":00Z")), { hour: "2-digit", minute: "2-digit" })}</span>
          <span class="legend-chips">${o.segments
            .map((s) => `<span class="chip"><i style="background:${SOURCES[s.source].color}"></i>${SOURCES[s.source].label}</span>`)
            .join("")}${tip(o.segments.map((s) => `${SOURCES[s.source].label}: ${SOURCES[s.source].note}, ${when(times[s.from])} to ${when(times[s.to])}.`).join(" "))}</span>
          <div class="seg" id="range" style="margin-left:auto">${Object.entries(RANGES)
            .map(([d, l]) => `<button data-d="${d}">${l}</button>`)
            .join("")}</div>
        </div>
      </section>
      <div class="kpis" id="kpis" style="grid-column:1/-1"></div>
      <section class="panel">
        <div class="panel-head"><h3>Wind and solar mix${tip(`Capacity factor of the mix (${CF_VARS.map((k) => `${VARS[k].short.toLowerCase()} ${o.gw[k]} GW`).join(", ")}) and of each technology. The blue band is the normal range for that hour of the year (10th to 90th percentile, 1991–2020, ±10 days); the dashed line the Dunkelflaute threshold of ${pct(THRESHOLD)}. Hover to move the wind map to that hour.`)}</h3>
          <span class="sub">share of installed capacity · Amsterdam time</span></div>
        <div class="chart" id="series"></div>
      </section>
      <section class="panel map-panel">
        <div class="panel-head"><h3>Where turbines run at full power${tip(`Wind at turbine hub height (100 m) from the newest KNMI HARMONIE-AROME run (2 km grid), coloured by what it means for a modern turbine: ${BANDS.map((b) => `${b.label} ${b.from}–${b.to === 40 ? "" : b.to} m/s (${b.note})`).join("; ")}. The line under the map gives the share of Dutch offshore wind capacity in each band. Faint lines drift with the wind to show its direction. Dots are offshore wind farms (white: Dutch), sized by capacity, from the Open European offshore wind turbine database (mid 2025). Drag the slider or press play to run through the forecast; hovering the chart moves the map along.`)}</h3>
          <span class="sub" id="mapTime"></span></div>
        <div class="farm-bands" id="farmBands"></div>
        <div class="windmap" id="windmap"><div class="map-hover" id="mapHover"></div></div>
        <div class="map-controls">
          <button class="play-btn" id="play" aria-label="Play forecast">▶</button>
          <input type="range" id="frame" min="0" max="${o.field.frames - 1}" step="1" value="0" aria-label="Forecast hour" />
          <span class="band-legend"><span class="band-bar" style="background:${LEGEND_GRADIENT}"></span>
            <span class="band-ticks">${[3, 12, 25].map((v) => `<span style="left:${(v / 30) * 100}%">${v}</span>`).join("")}<span style="left:100%">m/s</span></span></span>
        </div>
      </section>
    </div>`;

  // ---------- KPIs over the forecast
  const ahead = (k) => cf[k].slice(fc.from, fc.to + 1);
  const aheadNorm = (k) => normal[k].p50.slice(fc.from, fc.to + 1);
  const mean = (a) => a.reduce((s, v) => s + (v ?? 0), 0) / a.filter((v) => v != null).length;
  const mixAhead = ahead("mix");
  const lowI = mixAhead.indexOf(Math.min(...mixAhead.filter((v) => v != null)));
  const daily = mixAhead.map((_, i) => (i < 23 ? null : mean(mixAhead.slice(i - 23, i + 1))));
  const calmHours = daily.filter((v) => v != null && v < THRESHOLD).length;
  const nowI = o.now;
  const wofNow = cf.wof[nowI];
  const kpi = (label, value, delta, help, accent) =>
    `<div class="kpi${accent ? " accent" : ""}"><div class="kpi-label">${label}${tip(help)}</div><div class="kpi-value">${value}</div><div class="kpi-delta">${delta}</div></div>`;
  const vsNormal = (a, b) => {
    const d = a - b;
    return `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(1)} pts vs normal`;
  };
  root.querySelector("#kpis").innerHTML = [
    kpi("Mix, next 60 h", pct(mean(mixAhead), 1), `${vsNormal(mean(mixAhead), mean(aheadNorm("mix")))} · ${(mean(mixAhead) * totalGw).toFixed(1)} GW average`,
      "Mean capacity factor of the wind and solar mix over the forecast, against the normal for these hours."),
    kpi("Lowest hour ahead", pct(mixAhead[lowI], 1), when(times[fc.from + lowI]),
      "The hour in the forecast with the lowest output of the mix."),
    kpi("Dunkelflaute risk", calmHours ? `${calmHours} h` : "none", calmHours ? `24-hour mean under ${pct(THRESHOLD)}` : `24-hour mean stays above ${pct(THRESHOLD)}`,
      "Forecast hours at which the mean of the mix over the previous 24 hours is under the Dunkelflaute threshold. A Dunkelflaute in the app's sense needs at least two such days.", calmHours > 0),
    kpi("Offshore now", wofNow == null ? "–" : pct(wofNow), `${o.ws.wof[nowI] != null ? `${(o.ws.wof[nowI] / 10).toFixed(1)} m/s at 100 m · ` : ""}${wofNow == null ? "" : (wofNow * o.gw.wof).toFixed(1)} GW`,
      "Offshore wind right now according to the forecast: capacity factor, mean wind speed at hub height over the Dutch offshore zones, and the output of the installed fleet."),
    kpi("Solar, next 60 h", pct(mean(ahead("spv")), 1), vsNormal(mean(ahead("spv")), mean(aheadNorm("spv"))),
      "Mean solar capacity factor over the forecast, day and night, from HARMONIE's global radiation."),
  ].join("");

  // ---------- Series chart: mix on top, the three technologies below
  const panels = [
    { k: "mix", label: "Mix", color: "#003584" },
    ...CF_VARS.map((k) => ({ k, label: VARS[k].short, color: VARS[k].color })),
  ];
  const tops = [4, 46, 64, 82];
  const heights = [36, 14, 14, 14];
  const grids = panels.map((_, i) => ({ left: 46, right: 14, top: `${tops[i]}%`, height: `${heights[i]}%` }));
  const pair = (a) => a.map((v, i) => [times[i], v == null ? null : v * 100]);
  const series = [];
  panels.forEach((p, gi) => {
    const n = normal[p.k];
    series.push(
      { type: "line", xAxisIndex: gi, yAxisIndex: gi, data: pair(n.p10), stack: `n${gi}`, symbol: "none", lineStyle: { width: 0 }, silent: true, stackStrategy: "all" },
      { type: "line", xAxisIndex: gi, yAxisIndex: gi, data: n.p90.map((v, i) => [times[i], (v - n.p10[i]) * 100]), stack: `n${gi}`, symbol: "none", lineStyle: { width: 0 }, areaStyle: { color: "rgba(160,196,232,0.35)" }, silent: true, stackStrategy: "all" },
      { type: "line", xAxisIndex: gi, yAxisIndex: gi, data: pair(n.p50), symbol: "none", lineStyle: { width: 1, type: "dashed", color: "#A0C4E8" }, silent: true },
      {
        name: p.label, type: "line", xAxisIndex: gi, yAxisIndex: gi, symbol: "none", data: pair(cf[p.k].map((v, i) => (i <= fc.from ? v : null))),
        lineStyle: { width: gi ? 1.5 : 2.2, color: p.color },
      },
      {
        name: `${p.label} forecast`, type: "line", xAxisIndex: gi, yAxisIndex: gi, symbol: "none", data: pair(cf[p.k].map((v, i) => (i >= fc.from ? v : null))),
        lineStyle: { width: gi ? 1.5 : 2.4, color: "#FF6428" }, areaStyle: gi ? undefined : { color: "rgba(255,100,40,0.10)" },
        markLine: gi
          ? undefined
          : {
              symbol: "none", silent: true,
              data: [
                { yAxis: THRESHOLD * 100, lineStyle: { color: "#FF6428", type: "dashed", width: 1 }, label: { formatter: "Dunkelflaute threshold", position: "insideStartTop", color: "#3C465A", fontSize: 11 } },
              ],
            },
      },
    );
  });
  // Shading per source and the "now" line, on every grid.
  const bands = o.segments.map((s) => [
    { xAxis: times[s.from], itemStyle: { color: s.source === "forecast" ? "rgba(255,100,40,0.06)" : "rgba(0,0,0,0)" } },
    { xAxis: times[s.to] },
  ]);
  panels.forEach((_, gi) =>
    series.push({
      type: "line", xAxisIndex: gi, yAxisIndex: gi, data: [], silent: true,
      markArea: { silent: true, data: bands },
      markLine: {
        symbol: "none", silent: true, animation: false,
        data: [
          { xAxis: times[nowI], lineStyle: { color: "#3C465A", width: 1 }, label: { show: gi === 0, formatter: "now", color: "#3C465A", fontSize: 11 } },
          ...o.segments.filter((s) => s.source !== "pecd").map((s) => ({
            xAxis: times[s.from], lineStyle: { color: SOURCES[s.source].color, width: 1, type: "dotted", opacity: 0.8 }, label: { show: false },
          })),
        ],
      },
    }),
  );
  const mapLineIndex = series.length;
  series.push({ type: "line", xAxisIndex: 0, yAxisIndex: 0, data: [], silent: true, markLine: { symbol: "none", silent: true, animation: false, data: [] } });

  const el = chart(root.querySelector("#series"));
  el.setOption({
    textStyle: { fontFamily: FONT },
    animation: false,
    grid: grids,
    axisPointer: { link: [{ xAxisIndex: "all" }], lineStyle: { color: "#3C465A", width: 1 } },
    tooltip: {
      ...tooltipCommon,
      formatter: (ps) => {
        const t = ps[0].axisValue;
        const i = Math.round((t - t0) / HOUR);
        const src = SOURCES[sourceAt(i)];
        const row = (k, label) =>
          cf[k][i] == null ? "" : `<tr><td>${label}</td><td class="num"><b>${pct(cf[k][i], 1)}</b></td><td class="num muted">${k === "mix" ? (cf[k][i] * totalGw).toFixed(1) : (cf[k][i] * o.gw[k]).toFixed(1)} GW</td><td class="num muted">normal ${pct(normal[k].p50[i])}</td></tr>`;
        const wsRow = ["won", "wof"].filter((k) => o.ws[k][i] != null).map((k) => `${VARS[k].short} ${(o.ws[k][i] / 10).toFixed(1)} m/s`).join(" · ");
        return `<b>${when(t)}</b> <span style="color:${src?.color}">● ${src?.label ?? ""}</span>
          <table class="tt">${row("mix", "Mix")}${CF_VARS.map((k) => row(k, VARS[k].short)).join("")}</table>
          ${wsRow ? `<span class="muted">Wind at 100 m: ${wsRow}</span>` : ""}`;
      },
    },
    xAxis: panels.map((_, gi) => ({
      ...axisCommon, type: "time", gridIndex: gi, min: "dataMin", max: "dataMax",
      axisLabel: { ...axisCommon.axisLabel, show: gi === panels.length - 1, hideOverlap: true, formatter: (v) => local(v, { weekday: "short", day: "numeric" }) },
      splitLine: { show: false },
    })),
    yAxis: panels.map((p, gi) => ({
      ...axisCommon, type: "value", gridIndex: gi, min: 0, max: gi === 0 ? null : p.k === "spv" ? 60 : 100,
      ...(gi ? { interval: p.k === "spv" ? 60 : 100 } : { splitNumber: 4 }),
      name: gi ? p.label : "", nameLocation: "middle", nameGap: 32, nameTextStyle: { color: "#3C465A", fontSize: 11 },
      axisLabel: { ...axisCommon.axisLabel, fontSize: 10, formatter: "{value}%" },
    })),
    dataZoom: [{ type: "inside", xAxisIndex: panels.map((_, i) => i), filterMode: "none" }],
    series,
  });

  function setRange(days) {
    opts.days = days;
    for (const b of root.querySelectorAll("#range button")) b.classList.toggle("active", Number(b.dataset.d) === days);
    const end = times[times.length - 1];
    el.dispatchAction({ type: "dataZoom", startValue: Math.max(t0, times[nowI] - days * 24 * HOUR), endValue: end });
  }
  root.querySelector("#range").addEventListener("click", (e) => {
    const d = Number(e.target.closest("button")?.dataset.d);
    if (d) setRange(d);
  });
  setRange(opts.days);

  // ---------- Wind map, synced with the chart
  const mapEl = root.querySelector("#windmap");
  const hover = root.querySelector("#mapHover");
  const slider = root.querySelector("#frame");
  const map = createWindMap(mapEl, {
    field: o.field, wind: o.wind, geo, farms: o.farms,
    onHover: (h) => {
      if (!h || (!h.farm && h.speed == null)) return (hover.style.display = "none");
      hover.style.display = "block";
      hover.style.left = `${Math.min(h.x + 12, mapEl.clientWidth - 170)}px`;
      hover.style.top = `${h.y + 12}px`;
      const wind = h.speed != null ? `${h.speed.toFixed(1)} m/s from ${h.dir} · <b>${h.band.label}</b>` : "";
      hover.innerHTML = h.farm ? `<b>${h.farm.name}</b><br>${h.farm.mw} MW · since ${h.farm.since}<br>${wind}` : wind;
    },
  });
  // The map column is as wide as the map at the height it gets, so there are no empty bands beside it.
  const view = root.querySelector(".outlook");
  const panel = root.querySelector(".map-panel");
  const fitMap = () => {
    const extra = panel.clientWidth - mapEl.clientWidth;
    const width = Math.round(mapEl.clientHeight * map.aspect + extra);
    view.style.setProperty("--map-w", `${Math.max(300, Math.min(width, view.clientWidth * 0.5))}px`);
  };
  const fitObserver = new ResizeObserver(fitMap);
  fitObserver.observe(view);
  fitMap();

  const frameTime = (f) => runT + f * HOUR;
  function showFrame(f, fromChart) {
    map.setFrame(f);
    slider.value = f;
    root.querySelector("#mapTime").textContent = `${when(frameTime(f))} · +${f} h`;
    const shares = map.farmBands(f);
    root.querySelector("#farmBands").innerHTML = `<span class="fb-label">Dutch offshore capacity</span>${BANDS.map(
      (b) => `<span class="fb-seg" style="flex:${Math.max(shares[b.label], 0.0001)};background:var(--band-${b.label.replace(" ", "-")})" title="${b.label}: ${Math.round(shares[b.label] * 100)}%">${shares[b.label] >= 0.12 ? `${b.label} ${Math.round(shares[b.label] * 100)}%` : ""}</span>`,
    ).join("")}`;
    if (!fromChart) {
      el.setOption({ series: Array.from({ length: mapLineIndex + 1 }, (_, i) => (i === mapLineIndex
        ? { markLine: { data: [{ xAxis: frameTime(f), lineStyle: { color: "#FF6428", width: 1.5 }, label: { show: Math.abs(frameTime(f) - times[nowI]) > 2 * HOUR, formatter: "map", color: "#FF6428", fontSize: 11 } }] } }
        : {})) });
    }
  }
  const firstFrame = Math.max(0, Math.min(o.field.frames - 1, nowI - runIndex));
  showFrame(firstFrame);
  slider.addEventListener("input", () => {
    stop();
    showFrame(Number(slider.value));
  });
  el.on("updateAxisPointer", (e) => {
    const t = e.axesInfo?.[0]?.value;
    if (t == null || playing) return;
    const f = Math.round((t - runT) / HOUR);
    if (f >= 0 && f < o.field.frames) showFrame(f, true);
  });

  let playing = 0;
  const playBtn = root.querySelector("#play");
  function stop() {
    clearInterval(playing);
    playing = 0;
    playBtn.textContent = "▶";
    playBtn.setAttribute("aria-label", "Play forecast");
  }
  playBtn.addEventListener("click", () => {
    if (playing) return stop();
    playBtn.textContent = "❚❚";
    playBtn.setAttribute("aria-label", "Pause");
    playing = setInterval(() => showFrame((Number(slider.value) + 1) % o.field.frames), 450);
  });

  return {
    dispose() {
      stop();
      fitObserver.disconnect();
      map.destroy();
    },
  };
}
