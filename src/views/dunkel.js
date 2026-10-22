import { chart, axisCommon, tooltipCommon, FONT } from "../charts.js";
import { VARS, CF_VARS, loadCountry, loadHourly, portfolio, findEvents, isoAt, fmtDate, pct } from "../data.js";
import { BACKTEST, MODEL, forecast, isCached, isLoaded, loadModel } from "../forecast.js";
import { tip } from "../ui.js";

const FALLBACK_WEIGHTS = { spv: 1, won: 1, wof: 1 };

export async function renderDunkel(root, state, alive) {
  const country = await loadCountry(state.country);
  if (!alive()) return;
  const meta = state.meta;
  const name = meta.countries[state.country];
  const techs = CF_VARS.filter((k) => country[k]);
  state.dunkel ??= { threshold: 0.06, minDays: 2, sort: "deficit" };
  const opts = state.dunkel;
  const weights = { ...(meta.weights?.[state.country]?.gw ?? FALLBACK_WEIGHTS) };
  const weightNote = meta.weights?.[state.country]?.note ?? "No capacity data for this country: equal weights, set your own.";
  const firstYear = Number(country.start.slice(0, 4));
  const lastYear = meta.lastYear;
  const hasHourly = meta.hourly?.includes(state.country);
  const unit = meta.weights?.[state.country] ? "GW" : "";

  root.innerHTML = `
    <div class="view" style="grid-template-columns:minmax(0,0.8fr) minmax(0,1.2fr);grid-template-rows:auto auto minmax(0,0.7fr) minmax(0,1.3fr)">
      <section class="panel" style="grid-column:1/-1">
        <div class="panel-head"><h2>Dunkelflaute in ${name}${tip("A Dunkelflaute is a run of at least the minimum number of days on which the daily mean capacity factor of the wind and solar mix stays below the threshold. There is no official definition, so every setting here is adjustable.")}</h2>
          <span class="sub">days on which the wind and solar mix stays under the threshold · ${weightNote}</span></div>
        <div class="slider-row" style="grid-template-columns:repeat(${techs.length + 2},minmax(0,1fr))">
          ${techs
            .map(
              (k) => `<label class="slider"><span class="slider-top"><span>${VARS[k].label}${tip("Installed capacity of this technology, used to weight it in the mix. Defaults: end of 2024 where known.")}</span><b><span id="w-${k}-v">${weights[k]}</span> ${unit}</b></span>
                <input type="range" id="w-${k}" min="0" max="${Math.max(10, Math.ceil(weights[k] * 2))}" step="0.5" value="${weights[k]}" /></label>`,
            )
            .join("")}
          <label class="slider"><span class="slider-top"><span>Threshold${tip("A day counts as dark and calm when the mix delivers less than this share of its installed capacity, as a daily mean.")}</span><b id="thr-v">${pct(opts.threshold)}</b></span>
            <input type="range" id="thr" min="0.03" max="0.2" step="0.01" value="${opts.threshold}" /></label>
          <label class="slider"><span class="slider-top"><span>Minimum length${tip("Only runs of at least this many consecutive days count as an event.")}</span><b><span id="min-v">${opts.minDays}</span> days</b></span>
            <input type="range" id="min" min="1" max="7" step="1" value="${opts.minDays}" /></label>
        </div>
      </section>
      <div class="kpis" id="kpis" style="grid-column:1/-1"></div>
      <section class="panel" style="grid-column:1/-1">
        <div class="panel-head"><h3>Dunkelflaute days per year${tip("Days per calendar year that belong to an event. Orange: the selected year. Click a bar to select that year.")}</h3><span class="sub">click a bar to select the year</span></div>
        <div class="chart" id="perYear"></div>
      </section>
      <section class="panel accent">
        <div class="panel-head"><h3>Worst events${tip("Events sorted by shortfall, length or date. Shortfall: how far the mix stayed under the threshold, summed over the event days, in days of full output. Click a row to see it hour by hour.")}</h3>
          <div class="seg" id="sort">
            <button data-s="deficit">Largest shortfall</button><button data-s="days">Longest</button><button data-s="start">Most recent</button>
          </div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Start</th><th class="num">Days</th><th class="num">Mean mix</th><th class="num" title="How far the mix stayed under the threshold, summed over the event, in days of full output">Shortfall</th></tr></thead>
          <tbody id="events"></tbody>
        </table></div>
      </section>
      <section class="panel">
        <div class="panel-head" style="flex-wrap:nowrap"><h3 id="detailTitle" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Pick an event</h3>${tip(hasHourly
            ? "Hourly capacity factors around the event; the shaded part is the event itself. Replay plays it day by day on the map."
            : "Daily capacity factors around the event (hourly data is only included for NL and DE); the shaded part is the event itself. Replay plays it day by day on the map.")}
          <button class="link-btn" id="replay" style="white-space:nowrap">Replay ▸</button>
          ${hasHourly ? `<span style="margin-left:auto;display:flex;gap:6px;align-items:center">
            <div class="seg" id="fcHorizon"><button data-h="24">24h</button><button data-h="48">48h</button><button data-h="96">96h</button></div>
            <button class="ai-btn" id="fcBtn">TimesFM</button>${tip("TimesFM 3.0, Google's time-series foundation model, forecasts the next 24, 48 or 96 hours of the mix from the previous 512 hours alone, without a weather forecast. It runs in your browser (353 MB, downloaded once). Scored against persistence (the last value) and the hourly normal of the past 30 days.")}</span>` : ""}</div>
        <div class="chart" id="detail"></div>
        ${hasHourly ? `<div class="fc-status" id="fcStatus"></div>` : ""}
      </section>
    </div>`;

  const perYear = chart(root.querySelector("#perYear"));
  const detail = chart(root.querySelector("#detail"));
  let events = [];
  let selected = null;

  let stats = null;

  function compute() {
    const mix = portfolio(country, weights);
    events = findEvents(mix, country.start, opts.threshold, opts.minDays);
    const days = new Map();
    for (const e of events) {
      for (let j = 0; j < e.days; j++) {
        const y = Number(isoAt(country.start, e.startIndex + j).slice(0, 4));
        days.set(y, (days.get(y) ?? 0) + 1);
      }
    }
    const years = Array.from({ length: lastYear - firstYear + 1 }, (_, i) => firstYear + i);
    stats = { days, years, counts: years.map((y) => days.get(y) ?? 0) };
    drawKpis();
    perYear.setOption({
      textStyle: { fontFamily: FONT },
      grid: { left: 32, right: 8, top: 8, bottom: 22 },
      tooltip: { ...tooltipCommon, formatter: (p) => `<b>${p[0].axisValue}</b><br>${p[0].value} Dunkelflaute days` },
      xAxis: { type: "category", data: years, ...axisCommon, splitLine: { show: false } },
      yAxis: { type: "value", ...axisCommon, minInterval: 1 },
      series: [{ type: "bar", barCategoryGap: "22%", data: barData() }],
    });
    renderTable();
  }

  const barData = () =>
    stats.counts.map((v, i) => ({ value: v, itemStyle: { color: stats.years[i] === state.year ? "#FF6428" : "#003584" } }));

  function drawKpis() {
    const { days, years, counts } = stats;
    // The running year is incomplete, so the 30-year average ends with the last full year.
    const lastFull = meta.lastDate.endsWith("12-31") ? lastYear : lastYear - 1;
    const recent = counts.slice(lastFull - firstYear - 29, lastFull - firstYear + 1);
    const early = counts.slice(0, 30);
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const longest = events.reduce((m, e) => (e.days > (m?.days ?? 0) ? e : m), null);
    const worstYear = years[counts.indexOf(Math.max(...counts))];
    root.querySelector("#kpis").innerHTML = [
      ["Events since " + firstYear, events.length.toLocaleString("en-GB"), `${state.year}: ${days.get(state.year) ?? 0} days`,
        "Number of separate Dunkelflaute events since 1950 with the current settings. Below: Dunkelflaute days in the selected year."],
      ["Days per year", avg(recent).toFixed(1), `${lastFull - 29}–${lastFull} · ${firstYear}–${firstYear + 29}: ${avg(early).toFixed(1)}`,
        "Average Dunkelflaute days per year over the last 30 full years, with the first 30 years of the record for comparison."],
      ["Longest event", longest ? `${longest.days} days` : "–", longest ? `from ${fmtDate(longest.start)}` : "",
        "The longest single event with the current settings."],
      ["Worst year", worstYear ?? "–", `${Math.max(...counts)} Dunkelflaute days`, "The calendar year with the most Dunkelflaute days."],
    ]
      .map(([l, v, dd, t]) => `<div class="kpi"><div class="kpi-label">${l}${tip(t)}</div><div class="kpi-value">${v}</div><div class="kpi-delta">${dd}</div></div>`)
      .join("");
  }

  function renderTable() {
    for (const b of root.querySelectorAll("#sort button")) b.classList.toggle("active", b.dataset.s === opts.sort);
    const sorted = [...events].sort((a, b) => (opts.sort === "start" ? b.startIndex - a.startIndex : b[opts.sort] - a[opts.sort]));
    root.querySelector("#events").innerHTML = sorted
      .slice(0, 80)
      .map(
        (e) => `<tr data-i="${e.startIndex}" class="${selected?.startIndex === e.startIndex ? "selected" : ""}">
          <td>${fmtDate(e.start)}</td><td class="num">${e.days}</td><td class="num">${pct(e.mean, 1)}</td>
          <td class="num">${e.deficit.toFixed(2)}</td></tr>`,
      )
      .join("");
    if (!selected && sorted.length) showEvent(sorted[0]);
  }

  // Hourly data around the selected event, kept continuous from the year before so a
  // forecast always has a full context window behind its starting hour.
  let ev = null;

  async function showEvent(e) {
    selected = e;
    for (const tr of root.querySelectorAll("#events tr")) tr.classList.toggle("selected", Number(tr.dataset.i) === e.startIndex);
    root.querySelector("#detailTitle").textContent = `${fmtDate(e.start, { day: "numeric", month: "short" })} – ${fmtDate(e.end)} · ${e.days} days · ${pct(e.mean, 1)}`;
    const pad = 3;
    const from = Math.max(0, e.startIndex - pad);
    const to = Math.min(country.length - 1, e.startIndex + e.days - 1 + pad);
    const fromIso = isoAt(country.start, from);
    const toIso = isoAt(country.start, to);

    if (hasHourly) {
      const y0 = Math.max(firstYear, Number(fromIso.slice(0, 4)) - 1);
      const y1 = Number(toIso.slice(0, 4));
      const parts = await Promise.all(Array.from({ length: y1 - y0 + 1 }, (_, i) => loadHourly(state.country, y0 + i)));
      if (selected !== e || !alive()) return;
      const t0 = Date.parse(`${parts[0].start}Z`);
      const all = Object.fromEntries(techs.map((k) => [k, parts.flatMap((h) => h[k])]));
      const n = all[techs[0]].length;
      const labels = Array.from({ length: n }, (_, i) => {
        const t = new Date(t0 + i * 3600000).toISOString();
        return `${t.slice(0, 10)} ${t.slice(11, 13)}:00`;
      });
      const mixAll = Array.from({ length: n }, (_, i) => mixAt(Object.fromEntries(techs.map((k) => [k, all[k][i]]))));
      const w0 = labels.indexOf(`${fromIso} 00:00`);
      const w1 = labels.indexOf(`${toIso} 23:00`) + 1;
      ev = { e, labels, all, mixAll, w0, w1, origin: Math.max(w0 + 1, labels.indexOf(`${e.start} 00:00`) - 24), fc: null };
    } else {
      const labels = [];
      for (let i = from; i <= to; i++) labels.push(isoAt(country.start, i));
      const all = Object.fromEntries(techs.map((k) => [k, country[k].slice(from, to + 1)]));
      const mixAll = labels.map((_, i) => mixAt(Object.fromEntries(techs.map((k) => [k, all[k][i]]))));
      ev = { e, labels, all, mixAll, w0: 0, w1: labels.length, origin: null, fc: null };
    }
    drawDetail();
    if (fcOpts.on && hasHourly) runForecast();
  }

  function mixAt(values) {
    let s = 0;
    let w = 0;
    for (const k of techs) {
      if (values[k] == null || !weights[k]) continue;
      s += values[k] * weights[k];
      w += weights[k];
    }
    return w ? s / w : null;
  }

  function drawDetail() {
    const { e, labels, all, mixAll, w0, w1, fc, origin } = ev;
    const x = labels.slice(w0, w1);
    const win = (arr) => arr.slice(w0, w1).map((v) => (v == null ? null : v * 100));
    const fcSeries = [];
    if (fc) {
      const at = (vals) => x.map((_, j) => {
        const k = w0 + j - fc.origin;
        return k >= 0 && k < vals.length ? vals[k] * 100 : null;
      });
      const lo = at(fc.p10);
      const hi = at(fc.p90);
      fcSeries.push(
        { type: "line", name: "fc-lo", data: lo, stack: "fc", stackStrategy: "all", symbol: "none", lineStyle: { opacity: 0 }, silent: true, tooltip: { show: false } },
        {
          type: "line",
          name: "TimesFM p10–p90",
          data: hi.map((h, j) => (h == null ? null : h - lo[j])),
          stack: "fc", stackStrategy: "all",
          symbol: "none",
          lineStyle: { opacity: 0 },
          areaStyle: { color: "rgba(0, 53, 132, 0.14)" },
          itemStyle: { color: "rgba(0, 53, 132, 0.3)" },
          silent: true,
          tooltip: { show: false },
        },
        {
          type: "line",
          name: "TimesFM",
          data: at(fc.median),
          symbol: "none",
          lineStyle: { color: "#003584", width: 2, type: "dashed" },
          itemStyle: { color: "#003584" },
        },
      );
    }
    detail.setOption(
      {
        textStyle: { fontFamily: FONT },
        legend: {
          top: 0,
          right: 0,
          itemWidth: 14,
          textStyle: { fontFamily: FONT, fontSize: 11 },
          data: [...techs.map((k) => VARS[k].short), "Mix", ...(fc ? ["TimesFM"] : [])],
        },
        grid: { left: 6, right: 8, containLabel: true, top: 26, bottom: 22 },
        tooltip: { ...tooltipCommon, valueFormatter: (v) => (v == null ? "–" : `${v.toFixed(1)}%`) },
        xAxis: {
          type: "category",
          data: x,
          ...axisCommon,
          splitLine: { show: false },
          axisLabel: {
            ...axisCommon.axisLabel,
            interval: hasHourly ? (i, d) => d.endsWith("00:00") : "auto",
            hideOverlap: true,
            formatter: (d) => fmtDate(d.slice(0, 10), { day: "numeric", month: "short" }),
          },
        },
        yAxis: { type: "value", min: 0, max: 100, ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: "{value}%" } },
        series: [
          ...techs.map((k) => ({
            type: "line",
            name: VARS[k].short,
            data: win(all[k]),
            symbol: "none",
            lineStyle: { color: VARS[k].color, width: 1, opacity: fc ? 0.45 : 1 },
            itemStyle: { color: VARS[k].color },
          })),
          {
            type: "line",
            name: "Mix",
            data: win(mixAll),
            symbol: "none",
            lineStyle: { color: "#33A92F", width: 2.4 },
            itemStyle: { color: "#33A92F" },
            markArea: {
              silent: true,
              itemStyle: { color: "rgba(255, 100, 40, 0.08)" },
              data: [[{ xAxis: hasHourly ? `${e.start} 00:00` : e.start }, { xAxis: hasHourly ? `${e.end} 23:00` : e.end }]],
            },
            markLine: {
              silent: true,
              symbol: "none",
              animation: false,
              data: [
                { yAxis: opts.threshold * 100, lineStyle: { color: "#FF6428", type: "dashed" }, label: { formatter: "threshold", position: "insideEndTop", color: "#3C465A", fontSize: 11 } },
                ...(fcOpts.on && origin != null
                  ? [{ xAxis: labels[origin], lineStyle: { color: "#003584", type: "solid", width: 1.5 }, label: { formatter: "forecast from", position: "insideEndTop", color: "#003584", fontSize: 11 } }]
                  : []),
              ],
            },
          },
          ...fcSeries,
        ],
      },
      { notMerge: true },
    );
  }

  // ---- TimesFM: what could the hourly history alone have told you? ----
  state.dunkelForecast ??= { on: false, horizon: 48 };
  const fcOpts = state.dunkelForecast;
  const status = root.querySelector("#fcStatus");
  let fcToken = 0;

  async function runForecast() {
    if (!ev || ev.origin == null) return;
    const token = ++fcToken;
    const target = ev;
    const { mixAll, origin } = target;
    const H = fcOpts.horizon;
    try {
      if (!isLoaded()) {
        status.textContent = (await isCached()) ? "Loading TimesFM from the browser cache…" : "Downloading TimesFM (353 MB, once; cached after that)…";
        await loadModel((f) => token === fcToken && (status.textContent = `Downloading TimesFM: ${Math.round(f * 100)}% of 353 MB`));
        if (token === fcToken) status.textContent = "Starting TimesFM…";
      }
      const ctx = mixAll.slice(Math.max(0, origin - MODEL.window), origin).map((v) => v ?? 0);
      const res = await forecast(ctx, H);
      if (token !== fcToken || target !== ev || !alive()) return;
      ev.fc = { origin, ...res };
      drawDetail();
      status.innerHTML = scoreText(res, mixAll, origin, H);
    } catch (err) {
      if (token === fcToken) status.innerHTML = `<span class="down">TimesFM could not run: ${err.message}</span>`;
    }
  }

  // Compare with persistence (last value) and the normal (mean for that hour over the previous 30 days).
  function scoreText(res, mixAll, origin, H) {
    const truth = mixAll.slice(origin, origin + H);
    const n = truth.filter((v) => v != null).length;
    if (!n) return "No data after this hour to score against.";
    const err = (pred) => truth.reduce((a, v, i) => (v == null ? a : a + Math.abs(pred[i] - v)), 0) / n;
    const persist = Array(H).fill(mixAll[origin - 1]);
    const normal = Array.from({ length: H }, (_, t) => {
      let s = 0;
      let c = 0;
      for (let d = 1; d <= 30; d++) {
        const j = origin + (t % 24) - 24 * d;
        if (j >= 0 && mixAll[j] != null) (s += mixAll[j]), (c += 1);
      }
      return c ? s / c : 0;
    });
    const tf = err(res.median);
    const ps = err(persist);
    const nm = err(normal);
    const best = Math.min(ps, nm);
    const skill = 1 - tf / best;
    const inside = truth.filter((v, i) => v != null && v >= res.p10[i] && v <= res.p90[i]).length / n;
    return `Next ${H} h, error in CF points: <b>TimesFM ${(tf * 100).toFixed(1)}</b> · persistence ${(ps * 100).toFixed(1)} ·
      normal ${(nm * 100).toFixed(1)} → <span class="${skill >= 0 ? "up" : "down"}">${skill >= 0 ? "+" : "−"}${Math.abs(skill * 100).toFixed(0)}% vs best</span>
      · ${Math.round(inside * 100)}% in band · ${Math.round(res.ms)} ms<br><span class="fc-note">${backtestText(H)} Click the chart to start elsewhere.</span>`;
  }

  function backtestText(H) {
    const b = BACKTEST[state.country]?.[H];
    return b == null ? "" : `Backtest (300 starts, 2015–2025): +${Math.round(b * 100)}% vs best baseline at ${H} h.`;
  }

  if (hasHourly) {
    const btn = root.querySelector("#fcBtn");
    const seg = root.querySelector("#fcHorizon");
    const sync = () => {
      btn.classList.toggle("active", fcOpts.on);
      btn.textContent = fcOpts.on ? "TimesFM ✓" : "TimesFM";
      btn.title = "Forecast the next hours with Google's TimesFM, in your browser";
      seg.style.display = fcOpts.on ? "" : "none";
      for (const b of seg.querySelectorAll("button")) b.classList.toggle("active", Number(b.dataset.h) === fcOpts.horizon);
      if (!fcOpts.on) status.textContent = "TimesFM: forecast the next hours from the hourly history alone, with Google's time-series model running in your browser.";
    };
    btn.addEventListener("click", () => {
      fcOpts.on = !fcOpts.on;
      sync();
      if (!ev) return;
      if (fcOpts.on) runForecast();
      else {
        ev.fc = null;
        fcToken++;
        drawDetail();
      }
    });
    seg.addEventListener("click", (e2) => {
      const h = Number(e2.target.dataset.h);
      if (!h) return;
      fcOpts.horizon = h;
      sync();
      runForecast();
    });
    detail.getZr().on("click", (e2) => {
      if (!fcOpts.on || !ev) return;
      if (!detail.containPixel({ gridIndex: 0 }, [e2.offsetX, e2.offsetY])) return;
      const j = Math.round(detail.convertFromPixel({ gridIndex: 0 }, [e2.offsetX, e2.offsetY])[0]);
      const idx = ev.w0 + j;
      if (!Number.isFinite(j) || idx <= 0 || idx >= ev.w1) return;
      ev.origin = idx;
      drawDetail();
      runForecast();
    });
    sync();
  }

  const recompute = () => {
    selected = null;
    compute();
  };
  for (const k of techs) {
    const input = root.querySelector(`#w-${k}`);
    input.addEventListener("input", () => {
      weights[k] = Number(input.value);
      root.querySelector(`#w-${k}-v`).textContent = weights[k];
      recompute();
    });
  }
  root.querySelector("#thr").addEventListener("input", (ev) => {
    opts.threshold = Number(ev.target.value);
    root.querySelector("#thr-v").textContent = pct(opts.threshold);
    recompute();
  });
  root.querySelector("#min").addEventListener("input", (ev) => {
    opts.minDays = Number(ev.target.value);
    root.querySelector("#min-v").textContent = opts.minDays;
    recompute();
  });
  root.querySelector("#sort").addEventListener("click", (ev) => {
    if (!ev.target.dataset.s) return;
    opts.sort = ev.target.dataset.s;
    renderTable();
  });
  root.querySelector("#events").addEventListener("click", (ev) => {
    const e = events.find((x) => x.startIndex === Number(ev.target.closest("tr")?.dataset.i));
    if (e) showEvent(e);
  });
  root.querySelector("#replay").addEventListener("click", () => {
    if (!selected) return;
    state.autoplay = { until: isoAt(country.start, selected.startIndex + selected.days + 2) };
    state.set({ view: "map", date: isoAt(country.start, Math.max(0, selected.startIndex - 3)), metric: "won" });
  });
  perYear.on("click", (p) => state.set({ year: Number(p.name) }));

  compute();

  // Another year only moves the highlight and the first KPI; the events and detail stay put.
  return {
    onYear: () => {
      drawKpis();
      perYear.setOption({ series: [{ data: barData() }] });
    },
  };
}
