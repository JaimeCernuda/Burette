// Builds Burette's Ketcher editor as an ES module the Ketcher view imports from
// the loopback service. Reuses the desktop app's Ketcher plugins and sources.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { ketcherUiPlugin } from "../../../../apps/desktop/vite/ketcher-ui.ts";
import { ketcherRaphaelImportShimPlugin } from "../../../../apps/desktop/vite/build-plugins.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const desktop = resolve(here, "../../../../apps/desktop");
const outDir = process.env.BURETTE_KETCHER_OUT_DIR || resolve(here, "../../src/clio_burette/bundle/assets/ketcher");

export default defineConfig({
  root: here,
  base: "./",
  plugins: [tailwindcss(), react(), ketcherUiPlugin(), ketcherRaphaelImportShimPlugin()],
  resolve: {
    alias: [
      { find: /^miew$/u, replacement: resolve(here, "miew-stub.js") },
      // Same ketcher-core instance the desktop component (and ketcher-react) use.
      { find: /^ketcher-core$/u, replacement: resolve(desktop, "node_modules/ketcher-core") },
      ...Object.entries({
      "@": resolve(desktop, "src"),
      "./lib/ketcher-browser-require": resolve(desktop, "src/lib/hosted-browser-require.ts"),
      // Indigo without its renderer (7.5 MB instead of 11.8 MB): structure I/O and
      // layout work; Ketcher's own canvas draws the molecule. Miew (Ketcher's 3D
      // preview dialog) is left out; Burette's Mol* view is the 3D surface.
      "ketcher-standalone/dist/binaryWasm": "ketcher-standalone/dist/binaryWasmNoRender",
      }).map(([find, replacement]) => ({ find, replacement })),
    ],
    dedupe: ["react", "react-dom", "react/jsx-runtime"],
  },
  define: {
    global: "globalThis",
    process: JSON.stringify({ env: {} }),
    "process.env": "{}",
  },
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      input: resolve(here, "ketcher-app.tsx"),
      preserveEntrySignatures: "exports-only",
      output: {
        entryFileNames: "ketcher-app.js",
        chunkFileNames: "[name]-[hash].js",
        assetFileNames: (info) => (info.names?.some((n) => n.endsWith(".css")) ? "ketcher-app.css" : "[name]-[hash][extname]"),
      },
    },
  },
});
