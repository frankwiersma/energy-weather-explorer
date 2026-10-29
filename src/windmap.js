// 100 m wind over the Netherlands and the southern North Sea, from the HARMONIE field in the outlook.
// The colour field shows the wind speed in the bands that matter for a turbine at hub height: too little wind
// to turn (below cut-in), part load, full power, and shut down in a storm (above cut-out). Thin particles drift
// slowly with the wind to show its direction. Coastlines and offshore wind farms are drawn on top.

// Typical modern turbine: cut-in about 3 m/s, rated power from about 12 m/s, cut-out at 25 m/s.
export const BANDS = [
  { from: 0, to: 3, label: "idle", note: "below cut-in, turbines stand still" },
  { from: 3, to: 12, label: "part load", note: "output rises steeply with the wind" },
  { from: 12, to: 25, label: "full power", note: "at or near rated power" },
  { from: 25, to: 40, label: "storm stop", note: "above cut-out, turbines shut down" },
];

const STOPS = [
  [0, [28, 38, 66]],
  [3, [32, 66, 128]],
  [7, [45, 112, 214]],
  [11.5, [110, 170, 245]],
  [12.5, [255, 176, 120]],
  [20, [255, 110, 50]],
  [25, [235, 60, 40]],
  [26, [190, 30, 70]],
];

function rgb(s) {
  let i = 1;
  while (i < STOPS.length - 1 && s > STOPS[i][0]) i++;
  const [s0, c0] = STOPS[i - 1];
  const [s1, c1] = STOPS[i];
  const f = Math.max(0, Math.min(1, (s - s0) / (s1 - s0)));
  return c0.map((c, j) => Math.round(c + (c1[j] - c) * f));
}

export const bandOf = (s) => BANDS.find((b) => s < b.to) ?? BANDS[BANDS.length - 1];

// CSS gradient for the legend, 0 to 30 m/s.
export const LEGEND_GRADIENT = `linear-gradient(90deg, ${STOPS.map(([s, c]) => `rgb(${c.join(",")}) ${((s / 30) * 100).toFixed(1)}%`).join(", ")})`;

export function createWindMap(container, { field, wind, geo, farms, onHover }) {
  const { nlat, nlon, lat0, lon0, dlat, dlon, scale, frames } = field;
  const lat1 = lat0 + dlat * (nlat - 1);
  const lon1 = lon0 + dlon * (nlon - 1);
  const kx = Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180); // equirectangular, true to scale mid-map
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Three layers: the speed field, the particle trails, and coastlines with wind farms on top.
  const base = document.createElement("canvas");
  const trails = document.createElement("canvas");
  const top = document.createElement("canvas");
  for (const c of [base, trails, top]) {
    c.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
    container.appendChild(c);
  }
  const bctx = base.getContext("2d");
  const tctx = trails.getContext("2d");
  const octx = top.getContext("2d");
  // The speed field at grid resolution, scaled up smoothly when drawn.
  const grid = document.createElement("canvas");
  grid.width = nlon;
  grid.height = nlat;
  const gctx = grid.getContext("2d");

  let w = 0;
  let h = 0;
  let px = 1; // canvas pixels per degree of longitude
  let ox = 0;
  let oy = 0;
  let frame = 0;
  let particles = [];
  let raf = 0;
  let dpr = 1;

  const toXY = (lon, lat) => [ox + (lon - lon0) * px, oy + (lat1 - lat) * (px / kx)];
  const toLonLat = (x, y) => [lon0 + (x - ox) / px, lat1 - ((y - oy) * kx) / px];
  const n = nlat * nlon;

  // Bilinear wind (m/s) at a position, for the current frame.
  function sample(lon, lat) {
    const fx = (lon - lon0) / dlon;
    const fy = (lat - lat0) / dlat;
    if (fx < 0 || fy < 0 || fx > nlon - 1 || fy > nlat - 1) return null;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, nlon - 1);
    const y1 = Math.min(y0 + 1, nlat - 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const o = frame * 2 * n;
    const at = (k, y, x) => wind[o + k * n + y * nlon + x] * scale;
    const lerp = (k) =>
      (at(k, y0, x0) * (1 - tx) + at(k, y0, x1) * tx) * (1 - ty) + (at(k, y1, x0) * (1 - tx) + at(k, y1, x1) * tx) * ty;
    return [lerp(0), lerp(1)];
  }

  function outline(ctx) {
    ctx.beginPath();
    for (const f of geo.features) {
      for (const poly of f.geometry.coordinates) {
        for (const ring of poly) {
          ring.forEach(([lon, lat], i) => {
            const [x, y] = toXY(lon, lat);
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          });
          ctx.closePath();
        }
      }
    }
  }

  function drawField() {
    const img = gctx.createImageData(nlon, nlat);
    const o = frame * 2 * n;
    for (let y = 0; y < nlat; y++) {
      for (let x = 0; x < nlon; x++) {
        const j = y * nlon + x;
        const c = rgb(Math.hypot(wind[o + j], wind[o + n + j]) * scale);
        const p = ((nlat - 1 - y) * nlon + x) * 4; // grid rows run south to north
        img.data[p] = c[0];
        img.data[p + 1] = c[1];
        img.data[p + 2] = c[2];
        img.data[p + 3] = 255;
      }
    }
    gctx.putImageData(img, 0, 0);
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.fillStyle = "#001E50";
    bctx.fillRect(0, 0, w, h);
    const [x0, y0] = toXY(lon0, lat1);
    const [x1, y1] = toXY(lon1, lat0);
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = "high";
    bctx.drawImage(grid, x0, y0, x1 - x0, y1 - y0);
    // Land slightly darker, so the coast stays readable under the colours.
    bctx.save();
    clipToField(bctx);
    outline(bctx);
    bctx.fillStyle = "rgba(0,20,60,0.22)";
    bctx.fill("evenodd");
    bctx.restore();
  }

  // Coastlines and farms only inside the field, where there is data.
  function clipToField(ctx) {
    const [x0, y0] = toXY(lon0, lat1);
    const [x1, y1] = toXY(lon1, lat0);
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
  }

  function drawTop() {
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, w, h);
    octx.save();
    clipToField(octx);
    outline(octx);
    octx.strokeStyle = "rgba(255,255,255,0.7)";
    octx.lineWidth = 0.9;
    octx.stroke();
    for (const f of farms) {
      const [x, y] = toXY(f.lon, f.lat);
      octx.beginPath();
      octx.arc(x, y, farmRadius(f), 0, Math.PI * 2);
      octx.fillStyle = f.nl ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.35)";
      octx.fill();
      octx.lineWidth = 1.2;
      octx.strokeStyle = f.nl ? "#001E50" : "rgba(0,30,80,0.6)";
      octx.stroke();
    }
    octx.restore();
  }

  function seed(p) {
    p.x = Math.random() * w;
    p.y = Math.random() * h;
    p.age = Math.floor(Math.random() * 60);
    return p;
  }

  function resize() {
    const r = container.getBoundingClientRect();
    w = Math.max(1, r.width);
    h = Math.max(1, r.height);
    dpr = Math.min(2, devicePixelRatio || 1);
    for (const c of [base, trails, top]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    // Fit the field's box in the container, keeping its shape.
    const spanX = lon1 - lon0;
    const spanY = (lat1 - lat0) / kx;
    px = Math.min(w / spanX, h / spanY);
    ox = (w - spanX * px) / 2;
    oy = (h - spanY * px) / 2;
    drawField();
    drawTop();
    particles = Array.from({ length: Math.round((w * h) / 1800) }, () => seed({}));
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    tctx.clearRect(0, 0, w, h);
    if (reduced) drawArrows();
  }

  // Without motion: short strokes along the wind on a regular grid.
  function drawArrows() {
    tctx.clearRect(0, 0, w, h);
    tctx.strokeStyle = "rgba(255,255,255,0.6)";
    tctx.lineWidth = 1;
    for (let y = 12; y < h; y += 22) {
      for (let x = 12; x < w; x += 22) {
        const [lon, lat] = toLonLat(x, y);
        const v = sample(lon, lat);
        if (!v) continue;
        const s = Math.hypot(v[0], v[1]) || 1;
        tctx.beginPath();
        tctx.moveTo(x, y);
        tctx.lineTo(x + (v[0] / s) * 7, y - (v[1] / s) * 7);
        tctx.stroke();
      }
    }
  }

  function step() {
    // Short trails: most of the previous frame fades away.
    tctx.globalCompositeOperation = "destination-in";
    tctx.fillStyle = "rgba(0,0,0,0.86)";
    tctx.fillRect(0, 0, w, h);
    tctx.globalCompositeOperation = "source-over";
    tctx.strokeStyle = "rgba(255,255,255,0.55)";
    tctx.lineWidth = 0.8;
    const k = px * 0.0035; // canvas pixels per frame per m/s
    tctx.beginPath();
    for (const p of particles) {
      const [lon, lat] = toLonLat(p.x, p.y);
      const v = sample(lon, lat);
      if (!v || p.age++ > 70) {
        seed(p);
        p.age = 0;
        continue;
      }
      const nx = p.x + v[0] * k;
      const ny = p.y - (v[1] * k) / kx;
      tctx.moveTo(p.x, p.y);
      tctx.lineTo(nx, ny);
      p.x = nx;
      p.y = ny;
    }
    tctx.stroke();
    raf = requestAnimationFrame(step);
  }

  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();
  if (!reduced) raf = requestAnimationFrame(step);

  container.addEventListener("mousemove", (e) => {
    const r = container.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const near = farms.find((f) => {
      const [fx, fy] = toXY(f.lon, f.lat);
      return Math.hypot(fx - x, fy - y) < farmRadius(f) + 2;
    });
    const [lon, lat] = toLonLat(x, y);
    const v = sample(lon, lat);
    const speed = v ? Math.hypot(v[0], v[1]) : null;
    onHover?.({ x, y, farm: near, speed, band: speed == null ? null : bandOf(speed), dir: v ? fromDirection(v) : null });
  });
  container.addEventListener("mouseleave", () => onHover?.(null));

  return {
    frames,
    setFrame(i) {
      frame = Math.max(0, Math.min(frames - 1, i));
      drawField();
      if (reduced) drawArrows();
    },
    // Share of the Dutch offshore wind farms' capacity in each band, for the current frame.
    farmBands(i) {
      const keep = frame;
      frame = i;
      const out = Object.fromEntries(BANDS.map((b) => [b.label, 0]));
      let total = 0;
      for (const f of farms.filter((f) => f.nl)) {
        const v = sample(f.lon, f.lat);
        if (!v) continue;
        out[bandOf(Math.hypot(v[0], v[1])).label] += f.mw;
        total += f.mw;
      }
      frame = keep;
      for (const k in out) out[k] = total ? out[k] / total : 0;
      return out;
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
    },
  };
}

const farmRadius = (f) => 2.5 + Math.sqrt(f.mw) / 7;

// Meteorological convention: the compass direction the wind comes from.
function fromDirection([u, v]) {
  const deg = (Math.atan2(-u, -v) * 180) / Math.PI;
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return names[Math.round(((deg + 360) % 360) / 45) % 8];
}
