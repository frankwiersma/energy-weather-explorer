import * as echarts from "echarts";

export const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
export const GRID_LINE = "rgba(160, 196, 232, 0.35)";
export const TEXT = "#1A2B4A";
export const MUTED = "#3C465A";

// New charts appear at once (no build-up from zero); changes to an existing chart still animate.
echarts.registerTheme("calm", { animationDuration: 0, animationDurationUpdate: 300 });

// Charts are collected per view layer, so the old layer can stay on screen until the new one is ready.
let layer = new Set();

export function beginLayer() {
  layer = new Set();
  return layer;
}

export function chart(el) {
  const c = echarts.init(el, "calm", { renderer: "canvas" });
  const ro = new ResizeObserver(() => c.resize());
  ro.observe(el);
  c.__ro = ro;
  layer.add(c);
  return c;
}

export function disposeLayer(charts) {
  for (const c of charts ?? []) {
    c.__ro.disconnect();
    c.dispose();
  }
  charts?.clear();
}

export const baseText = { fontFamily: FONT, color: TEXT };

export const axisCommon = {
  axisLine: { lineStyle: { color: "#B7C6DA" } },
  axisTick: { show: false },
  axisLabel: { color: MUTED, fontFamily: FONT, fontSize: 12 },
  splitLine: { lineStyle: { color: GRID_LINE } },
};

export const tooltipCommon = {
  trigger: "axis",
  backgroundColor: "#fff",
  borderColor: "#DDE5F0",
  textStyle: { fontFamily: FONT, color: TEXT, fontSize: 13 },
  extraCssText: "box-shadow: 0 2px 8px rgba(0,53,132,0.12);",
};

export { echarts };
