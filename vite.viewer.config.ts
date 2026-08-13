/**
 * Builds the standalone viewer into ONE self-contained script.
 *
 * The HTML export has to carry the renderer, and the renderer is TypeScript
 * spread over a dozen modules — a running app cannot serialise that. So it is
 * bundled ahead of time into a single IIFE that the exporter inlines as text.
 *
 * Output is generated, never committed: `predev` and `prebuild` rebuild it, so
 * it cannot drift from the renderer it is supposed to be a copy of. That
 * matters more here than usual — a stale bundle would export a map drawn by
 * last week's renderer while claiming perfect fidelity.
 */
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/viewer/main.ts"),
      formats: ["iife"],
      name: "RnodeViewer",
      fileName: () => "viewer.bundle.js",
    },
    outDir: "src/export/generated",
    emptyOutDir: true,
    // One file, no split chunks: the exporter inlines a string, not a graph.
    rollupOptions: { output: { inlineDynamicImports: true } },
    minify: "esbuild",
    target: "es2022",
    sourcemap: false,
  },
  define: { "import.meta.env.DEV": "false" },
});
