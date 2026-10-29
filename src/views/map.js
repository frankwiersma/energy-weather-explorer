import { chart, echarts, FONT } from "../charts.js";
import {
  VARS,
  ICONS,
  SCALES,
  loadYear,
  loadCountry,
  climatology,
  dayIndex,
  doy365,
  isoAt,
  fmtDate,
  fmtVar,
  scaleLabel,
  demandGW,
} from "../data.js";
import { tip } from "../ui.js";

let geoReady = null;

function registerGeo() {
  geoReady ??= fetch("/data/europe.geojson")
    .then((r) => r.json())
    .then((geo) => echarts.registerMap("europe", geo));
  return geoReady;
}

const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const ordinal = (n) => `${n}${["th", "st", "nd", "rd"][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10 < 4 ? n % 10 : 0]}`;

export async function renderMap(root, state, alive) {
  const [year, , country] = await Promise.all([loadYear(state.year), registerGeo(), loadCountry(state.country)]);
  if (!alive()) return;

  root.innerHTML = `
    <div class="view" style="grid-template-columns:minmax(0,1fr) 320px">
      <section class="panel">
        <div class="panel-head">
          <h2>Europe on one day${tip("Daily mean per country from PECD v4.2 (ERA5 reanalysis). Wind and solar are capacity factors: output as a share of installed capacity. Click a country to select it.")}</h2>
          <span class="sub" id="mapSub"></span>
        </div>
        <div class="chart map-chart" id="map"></div>
        <div class="scrubber">
          <button class="play" id="play" aria-label="Play">${ICONS.play}</button>
          <div class="scrub-track">
            <input type="range" id="day" min="0" max="${year.days - 1}" aria-label="Day of the year" />
            <div class="scrub-months">${MONTHS.map((m) => `<span>${m}</span>`).join("")}</div>
          </div>
          <div class="seg speed" id="speed" aria-label="Speed">
            <button data-ms="250">1×</button><button data-ms="90" class="active">2×</button><button data-ms="30">4×</button>
          </div>
          <span class="scrub-date" id="dateLabel"></span>${tip("Drag to pick a day in the selected year. Play runs through the year at 1×, 2× or 4× speed. Change the year with the timeline at the bottom.")}
        </div>
      </section>
      <section class="panel accent">
        <div class="panel-head"><h2 id="sideTitle"></h2>${tip("The dot is the value on this day. The light band is the normal range: 10th to 90th percentile of the same calendar days (±7 days) in 1991–2020. The rank compares this day with the same date in every year since 1950.")}</div>
        <div class="sub" id="sideLead" style="margin-bottom:12px"></div>
        <div class="stats" id="stats"></div>
      </section>
    </div>`;

  const map = chart(root.querySelector("#map"));
  const slider = root.querySelector("#day");
  const climCache = {};
  const clim = (k) => (climCache[k] ??= country[k] ? climatology(country[k], country.start) : null);
  const firstYear = Number(country.start.slice(0, 4));

  function mapOption() {
    const k = state.metric;
    const s = SCALES[k];
    return {
      textStyle: { fontFamily: FONT },
      tooltip: {
        trigger: "item",
        formatter: (p) => `<b>${state.meta.countries[p.name] ?? p.name}</b><br>${VARS[k].label}: ${fmtVar(k, p.value)}`,
        textStyle: { fontFamily: FONT },
      },
      visualMap: {
        min: s.min,
        max: s.max,
        orient: "vertical",
        left: 4,
        bottom: 4,
        itemWidth: 10,
        itemHeight: 120,
        inRange: { color: s.colors },
        text: [scaleLabel(k, s.max), scaleLabel(k, s.min)],
        textStyle: { color: "#3C465A", fontFamily: FONT, fontSize: 11 },
      },
      series: [
        {
          type: "map",
          map: "europe",
          nameProperty: "NUTS_ID",
          roam: false,
          aspectScale: 0.66,
          layoutCenter: ["52%", "52%"],
          layoutSize: "118%",
          selectedMode: false,
          itemStyle: { borderColor: "#fff", borderWidth: 0.8, areaColor: "#E8EDF4" },
          emphasis: { label: { show: false }, itemStyle: { areaColor: "#FFB08F" } },
          data: [],
        },
      ],
    };
  }

  function draw() {
    const k = state.metric;
    const di = dayIndex(year.start, state.date);
    slider.value = di;
    root.querySelector("#dateLabel").textContent = fmtDate(state.date, { weekday: "short", day: "numeric", month: "short" });
    root.querySelector("#mapSub").textContent = `${VARS[k].label}, daily mean per country · click a country to select it`;
    const data = Object.entries(year[k] ?? {}).map(([cc, arr]) => ({
      name: cc,
      value: arr[di],
      itemStyle: cc === state.country ? { borderColor: "#FF6428", borderWidth: 2.5 } : undefined,
    }));
    map.setOption({ series: [{ data }] });
    drawSide();
  }

  function drawSide() {
    const iso = state.date;
    root.querySelector("#sideTitle").textContent = fmtDate(iso, { day: "numeric", month: "long", year: "numeric" });
    root.querySelector("#sideLead").textContent =
      `${state.meta.countries[state.country]} against the same calendar days in 1991–2020. The band is the normal range (10th–90th percentile).`;
    const ci = dayIndex(country.start, iso);
    const d = doy365(iso);
    root.querySelector("#stats").innerHTML = Object.entries(VARS)
      .map(([k, v]) => {
        const val = country[k]?.[ci];
        if (val == null)
          return `<div class="stat" style="color:${v.color}">${ICONS[k]}<span class="stat-name" style="color:var(--text)">${v.label}</span><span class="stat-val">–</span><span class="stat-note">No data for this country</span></div>`;
        const c = clim(k)[d];
        const lo = k === "t2m" ? Math.min(c.p10, val) - 4 : k === "dem" ? Math.min(c.p10, val) - 0.08 : 0;
        const hi = k === "t2m" ? Math.max(c.p90, val) + 4 : k === "dem" ? Math.max(c.p90, val) + 0.08 : Math.max(c.p90 * 1.25, val * 1.05, 0.05);
        const x = (vv) => `${Math.max(0, Math.min(100, ((vv - lo) / (hi - lo)) * 100))}%`;
        // Rank of this day among the same calendar day in every year.
        const same = [];
        for (let y = firstYear; y <= state.meta.lastYear; y++) {
          const j = dayIndex(country.start, `${y}${iso.slice(4)}`);
          if (country[k][j] != null) same.push(country[k][j]);
        }
        same.sort((a, b) => b - a);
        const rank = same.indexOf(val) + 1;
        const word = { t2m: ["warmest", "coldest"], spv: ["sunniest", "dullest"], dem: ["highest-demand", "lowest-demand"] }[k] ?? ["windiest", "calmest"];
        const top = rank <= same.length / 2;
        const dayName = fmtDate(iso, { day: "numeric", month: "long" });
        const rankText = `${ordinal(top ? rank : same.length - rank + 1)} ${top ? word[0] : word[1]} ${dayName} of ${same.length}`;
        const verdict = val < c.p10 ? `<span class="down">below normal</span>` : val > c.p90 ? `<span class="up">above normal</span>` : "normal";
        return `<div class="stat" style="color:${v.color}">
          ${ICONS[k]}
          <span class="stat-name" style="color:var(--text)">${v.label}</span>
          <span class="stat-val">${fmtVar(k, val)}${k === "dem" && demandGW(state.meta, state.country, val) != null ? ` <small>${demandGW(state.meta, state.country, val).toFixed(1)} GW</small>` : ""}</span>
          <div class="gauge"><span class="band" style="left:${x(c.p10)};width:calc(${x(c.p90)} - ${x(c.p10)})"></span>
            <span class="dot" style="left:${x(val)};background:${v.color}"></span></div>
          <span class="stat-note">${verdict} · ${rankText} since ${firstYear}</span>
        </div>`;
      })
      .join("");
  }

  map.setOption(mapOption());
  draw();

  map.on("click", (p) => state.meta.countries[p.name] && state.set({ country: p.name }));
  slider.addEventListener("input", () => state.set({ date: isoAt(year.start, Number(slider.value)) }));

  let timer = null;
  let stepMs = 90;
  let until = null;
  const playBtn = root.querySelector("#play");
  const stop = () => {
    clearInterval(timer);
    timer = null;
    until = null;
    playBtn.innerHTML = ICONS.play;
    playBtn.setAttribute("aria-label", "Play");
  };
  const start = () => {
    playBtn.innerHTML = ICONS.pause;
    playBtn.setAttribute("aria-label", "Pause");
    timer = setInterval(() => {
      if (!alive()) return stop();
      // Loop within the selected year so the view does not reload.
      if (until && state.date >= until) return stop();
      let i = dayIndex(year.start, state.date) + 1;
      if (i >= year.days) {
        if (until) return stop();
        i = 0;
      }
      state.set({ date: isoAt(year.start, i) });
    }, stepMs);
  };
  playBtn.addEventListener("click", () => (timer ? stop() : start()));
  root.querySelector("#speed").addEventListener("click", (e) => {
    const ms = Number(e.target.dataset.ms);
    if (!ms) return;
    stepMs = ms;
    for (const b of root.querySelectorAll("#speed button")) b.classList.toggle("active", b === e.target);
    if (timer) {
      stop();
      start();
    }
  });
  // A replay from the Dunkelflaute view plays at 1x and stops after the event.
  if (state.autoplay) {
    until = state.autoplay.until;
    state.autoplay = null;
    stepMs = 250;
    for (const b of root.querySelectorAll("#speed button")) b.classList.toggle("active", b.dataset.ms === "250");
    start();
  }

  return {
    onDate: draw,
    onMetric: () => {
      map.setOption(mapOption(), { replaceMerge: ["series"] });
      draw();
    },
  };
}
