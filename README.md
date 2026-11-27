<img width="128" height="128" alt="R-node" src="src/assets/logo.png" />

# R-node

**A local-first visual thinking and mind-mapping workspace.**

R-node is a keyboard-first app for mind maps and draw.io-style diagrams. Each
document is a single `.rnode` file — a SQLite database holding the map and its
images — that opens on desktop and in the browser.

- **Fast** — one canvas, no element per topic; smooth at 10,000+ topics.
- **Keyboard-first** — Enter/Tab to grow the map, arrows to move, everything
  undoable.
- **Local-first** — saves only when you press Ctrl+S; no hidden autosave.
- **Maps and diagrams** — rich text, pictures and freeform canvases in the same
  file.

## Install

Download the latest Windows build — installer, MSI or portable `.exe`:

**[R-node releases](https://github.com/robertocantore126/R-node/releases/latest)**

## Develop

Requires Node.js 18+, Rust stable and the Tauri CLI.

```bash
npm install
cargo install tauri-cli --locked

npm run dev        # web version → http://localhost:5173
cargo tauri dev    # desktop app
```

Build the desktop installer:

```bash
cargo tauri build  # src-tauri/target/release/bundle/
```

## Docs

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md)

```bash
npm test
```
