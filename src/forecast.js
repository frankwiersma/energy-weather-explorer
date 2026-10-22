// TimesFM 3.0 in the browser: Google's time-series foundation model as an int8 ONNX graph,
// run with ONNX Runtime Web 1.29.0 (WASM). Weights and the WASM runtime come from the
// timesfm-plotter R2 bucket, the same export as https://timesfm-plotter.pages.dev.
// Loaded only when a forecast is asked for.

const R2 = "https://pub-888d07dbae3e4003a57aa2c733231919.r2.dev";
export const MODEL = {
  shards: [0, 1, 2, 3].map((i) => `${R2}/models/timesfm3-decode-int8.onnx.0${i}`),
  runtime: `${R2}/vendor/`,
  bytes: 353299102,
  window: 512,
  horizon: 256,
  medianIndex: 4,
  quantiles: 9,
};

// Backtest of the capacity-weighted mix (default weights), 300 random starting hours in 2015–2025:
// improvement in mean absolute error over the better of persistence and the 30-day hourly normal.
export const BACKTEST = {
  NL: { 24: 0.26, 48: 0.11, 96: 0.06 },
  DE: { 24: 0.35, 48: 0.25, 96: 0.05 },
};

let session = null;

async function fetchShards(onProgress) {
  const cache = "caches" in window ? await caches.open("timesfm3-int8") : null;
  const got = MODEL.shards.map(() => 0);
  const tick = () => onProgress?.(got.reduce((a, b) => a + b, 0) / MODEL.bytes);
  const parts = await Promise.all(
    MODEL.shards.map(async (url, i) => {
      const hit = await cache?.match(url);
      if (hit) {
        const buf = new Uint8Array(await hit.arrayBuffer());
        got[i] = buf.byteLength;
        tick();
        return buf;
      }
      const res = await fetch(url);
      if (!res.ok) throw new Error(`model download failed (HTTP ${res.status})`);
      const reader = res.body.getReader();
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got[i] += value.length;
        tick();
      }
      const blob = new Blob(chunks);
      try {
        await cache?.put(url, new Response(blob));
      } catch {
        // Storage can be full or blocked; the model then downloads again next visit.
      }
      return new Uint8Array(await blob.arrayBuffer());
    }),
  );
  const joined = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    joined.set(p, off);
    off += p.byteLength;
  }
  return joined;
}

export const isLoaded = () => !!session;

export async function isCached() {
  if (!("caches" in window)) return false;
  const cache = await caches.open("timesfm3-int8");
  const hits = await Promise.all(MODEL.shards.map((u) => cache.match(u)));
  return hits.every(Boolean);
}

let loading = null;

export function loadModel(onProgress) {
  loading ??= (async () => {
    const ort = await import("onnxruntime-web/all");
    ort.env.wasm.wasmPaths = MODEL.runtime;
    const buf = await fetchShards(onProgress);
    // WebGPU in ORT Web 1.29 returns NaN for this graph, so WASM only.
    const sess = await ort.InferenceSession.create(buf, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    session = { ort, sess };
    return session;
  })().catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

// Forecast `horizon` steps after `context` (oldest first). Shorter contexts are left-padded and masked.
export async function forecast(context, horizon) {
  const { ort, sess } = session ?? (await loadModel());
  const W = MODEL.window;
  const ctx = context.slice(-W);
  const pad = W - ctx.length;
  const input = new Float32Array(W);
  const mask = new Uint8Array(W);
  for (let i = 0; i < pad; i++) mask[i] = 1;
  for (let i = 0; i < ctx.length; i++) input[pad + i] = ctx[i];
  const t0 = performance.now();
  const out = await sess.run({
    context: new ort.Tensor("float32", input, [1, 1, W]),
    mask: new ort.Tensor("bool", mask, [1, W]),
  });
  const q = out[sess.outputNames[0]].data; // (1, 1, horizon, 9)
  const Q = MODEL.quantiles;
  const pick = (k) => Array.from({ length: horizon }, (_, t) => q[t * Q + k]);
  return { median: pick(MODEL.medianIndex), p10: pick(0), p90: pick(Q - 1), ms: performance.now() - t0 };
}
