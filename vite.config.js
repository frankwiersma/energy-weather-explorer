import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    // The ORT build without an embedded WASM file: the runtime (27.8 MB, over the 25 MiB per-file
    // limit of Workers static assets) is loaded from R2 next to the model instead.
    alias: {
      "onnxruntime-web/all": fileURLToPath(new URL("node_modules/onnxruntime-web/dist/ort.all.min.mjs", import.meta.url)),
    },
  },
  // Pre-bundling moves onnxruntime-web into .vite/deps, which breaks its runtime URLs in dev.
  optimizeDeps: { exclude: ["onnxruntime-web"] },
});
