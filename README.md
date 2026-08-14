<img width="189" height="189" alt="R-node logo" src="https://github.com/user-attachments/assets/5f3b0327-59a9-4e8d-92f9-141164861046" />

# R-node

**A cross-platform visual thinking and mind-mapping workspace.**

R-node is a keyboard-first mind-mapping application for brainstorming, knowledge
organization, project planning and presentations. Code, brand and design system
are original; the interaction model is inspired by the conventions of
established mind-mapping tools such as Xmind.

- **Fast** — single-canvas rendering, no DOM or SVG element per topic; smooth
  at 10,000+ topics.
- **Keyboard-first** — Enter/Tab/Shift+Tab to create and structure topics,
  arrow keys to navigate, every action undoable.
- **Local-first** — documents save when you decide (Ctrl+S, no hidden
  autosave). On the web they live in localStorage; on desktop each document is
  **one `.rnode` file** (a SQLite database holding the document *and* its
  images).
- **Images in nodes** — drop or paste an image onto a topic, resize it, share
  the map as a single `.rnode.zip`. The canvas only decodes pre-scaled levels
  inside a byte budget, so maps with hundreds of images stay fluid.
- **Rich text on the canvas** — bold, italic, colours, headings and bullet
  lists live in the topic itself, drawn by the canvas and edited in an overlay
  that matches it pixel for pixel.

## Install

### End users

Prebuilt installers are not published yet. Until they are, use the developer
build below — or build a release installer locally with `cargo tauri build`
(the installer lands in `src-tauri/target/release/bundle/`).

### Developers

Requirements: [Node.js](https://nodejs.org) 18+ (npm),
[Rust](https://rustup.rs) (stable) and the Tauri CLI:

```bash
npm install
cargo install tauri-cli --locked   # if not already installed
```

Run the app:

```bash
npm run dev          # web version → http://localhost:5173
cargo tauri dev      # desktop version — opens a native window
```

Build a production desktop installer:

```bash
cargo tauri build    # installer in src-tauri/target/release/bundle/
```

## Documentation

Architecture, invariants and task list live in [`docs/`](docs/): start with
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) before changing code. Tests:

```bash
npm test             # 263 tests across 17 suites
```
