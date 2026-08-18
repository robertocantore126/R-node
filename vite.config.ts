import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Receives session traces and writes them to `.trace/` on disk.
 *
 * Why: the tracer could only download a file, so every diagnosis went through
 * the person at the keyboard — press the hotkey, save it, hand over the path.
 * Five round trips in one debugging session, with the loop stalled on a human
 * each time. Written to a known path, whoever is investigating just reads it.
 *
 * It lives in the DEV SERVER, so it cannot exist in a production build, and it
 * covers both surfaces at once: the Tauri webview loads from this same server
 * during `cargo tauri dev`, so the desktop app posts here too.
 */
function traceSink(): Plugin {
  return {
    name: "rnode-trace-sink",
    apply: "serve",
    configureServer(server) {
      const dir = resolve(server.config.root, ".trace");
      server.middlewares.use("/__trace", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString("utf8");
            mkdirSync(dir, { recursive: true });
            // `?name=` lets a second producer (the export self-audit) use the
            // same sink without overwriting the session trace. Stripped to a
            // safe stem: this is a local dev server, but a path is a path.
            const asked = new URL(req.url ?? "/", "http://localhost").searchParams.get("name");
            const stem = (asked ?? "latest").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64) || "latest";
            writeFileSync(resolve(dir, `${stem}.json`), body, "utf8");
            // A keypress capture also gets a timestamped copy: those are the
            // ones with a note attached, and they must not be overwritten by
            // the next automatic flush a second later.
            if (req.headers["x-trace-keep"] === "1") {
              const stamp = new Date().toISOString().replace(/[:.]/g, "-");
              writeFileSync(resolve(dir, `capture-${stamp}.json`), body, "utf8");
            }
            res.statusCode = 204;
            res.end();
          } catch (e) {
            res.statusCode = 500;
            res.end(String(e));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), traceSink()],
  server: {
    port: 5173,
    strictPort: true,
    // Node >= 17 resolves "localhost" to ::1 first, so vite binds IPv6-only
    // and the Tauri webview (WebView2 resolves localhost to 127.0.0.1) gets a
    // connection-refused white window. Bind IPv4 explicitly: both the desktop
    // app and browser tabs then reach the same server.
    host: "127.0.0.1",
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
