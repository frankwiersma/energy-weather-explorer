// Animated 100 m wind over the Netherlands and the southern North Sea, from the HARMONIE field in the outlook.
// Particles drift with the wind and leave fading trails; their colour shows the wind speed. Coastlines come
// from the app's country outlines and offshore wind farms are drawn on top.

const SPEED_COLORS = [
  [0, [160, 196, 232]],
  [6, [60, 140, 250]],
  [11, [255, 255, 255]],
  [16, [255, 164, 127]],
  [22, [255, 100, 40]],
];

export function speedColor(s, alpha = 1) {
  let i = 1;
  while (i < SPEED_COLORS.length - 1 && s > SPEED_COLORS[i][0]) i++;
  const [s0, c0] = SPEED_COLORS[i - 1];
  const [s1, c1] = SPEED_COLORS[i];
  const f = Math.max(0, Math.min(1, (s - s0) / (s1 - s0)));
  return `rgba(${c0.map((c, j) => Math.round(c + (c1[j] - c) * f)).join(",")},${alpha})`;
}

export const SPEED_LEGEND = SPEED_COLORS.map(([s, c]) => [s, `rgb(${c.join(",")})`]);

export function createWindMap(container, { field, wind, geo, farms, onHover }) {
  const { nlat, nlon, lat0, lon0, dlat, dlon, scale, frames } = field;
  const lat1 = lat0 + dlat * (nlat - 1);
  const lon1 = lon0 + dlon * (nlon - 1);
  const kx = Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180); // equirectangular, true to scale mid-map
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Three layers: sea and land, the particle trails, and coastlines with wind farms on top.
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
    const n = nlat * nlon;
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

  function drawBase() {
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.fillStyle = "#001E50";
    bctx.fillRect(0, 0, w, h);
    outline(bctx);
    bctx.fillStyle = "#1B3F7A";
    bctx.fill("evenodd");

    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, w, h);
    outline(octx);
    octx.strokeStyle = "rgba(160,196,232,0.9)";
    octx.lineWidth = 1;
    octx.stroke();
    for (const f of farms) {
      const [x, y] = toXY(f.lon, f.lat);
      octx.beginPath();
      octx.arc(x, y, farmRadius(f), 0, Math.PI * 2);
      octx.fillStyle = f.nl ? "#FF6428" : "rgba(255,255,255,0.45)";
      octx.fill();
      octx.lineWidth = 1;
      octx.strokeStyle = f.nl ? "#fff" : "rgba(255,255,255,0.8)";
      octx.stroke();
    }
  }

  function seed(p) {
    p.x = Math.random() * w;
    p.y = Math.random() * h;
    p.age = Math.floor(Math.random() * 80);
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
    drawBase();
    const n = Math.round((w * h) / 700);
    particles = Array.from({ length: n }, () => seed({}));
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    tctx.clearRect(0, 0, w, h);
    if (reduced) drawArrows();
  }

  // Without motion: short strokes along the wind on a regular grid.
  function drawArrows() {
    tctx.clearRect(0, 0, w, h);
    for (let y = 10; y < h; y += 18) {
      for (let x = 10; x < w; x += 18) {
        const [lon, lat] = toLonLat(x, y);
        const v = sample(lon, lat);
        if (!v) continue;
        const s = Math.hypot(v[0], v[1]);
        tctx.strokeStyle = speedColor(s, 0.9);
        tctx.lineWidth = 1.4;
        tctx.beginPath();
        tctx.moveTo(x, y);
        tctx.lineTo(x + (v[0] / s) * 7, y - (v[1] / s) * 7);
        tctx.stroke();
      }
    }
  }

  function step() {
    tctx.globalCompositeOperation = "destination-in";
    tctx.fillStyle = "rgba(0,0,0,0.9)";
    tctx.fillRect(0, 0, w, h);
    tctx.globalCompositeOperation = "source-over";
    tctx.lineWidth = 1;
    const k = px * 0.0009; // degrees per frame per m/s, scaled to the canvas
    for (const p of particles) {
      const [lon, lat] = toLonLat(p.x, p.y);
      const v = sample(lon, lat);
      if (!v || p.age++ > 90) {
        seed(p);
        p.age = 0;
        continue;
      }
      const nx = p.x + v[0] * k * 10;
      const ny = p.y - v[1] * k * 10 / kx;
      tctx.strokeStyle = speedColor(Math.hypot(v[0], v[1]), 0.7);
      tctx.beginPath();
      tctx.moveTo(p.x, p.y);
      tctx.lineTo(nx, ny);
      tctx.stroke();
      p.x = nx;
      p.y = ny;
    }
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
    onHover?.({ x, y, farm: near, speed: v ? Math.hypot(v[0], v[1]) : null, dir: v ? fromDirection(v) : null });
  });
  container.addEventListener("mouseleave", () => onHover?.(null));

  return {
    frames,
    setFrame(i) {
      frame = Math.max(0, Math.min(frames - 1, i));
      if (reduced) drawArrows();
    },
    meanSpeed(i) {
      const n = nlat * nlon;
      const o = i * 2 * n;
      let s = 0;
      for (let j = 0; j < n; j++) s += Math.hypot(wind[o + j], wind[o + n + j]);
      return (s / n) * scale;
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
