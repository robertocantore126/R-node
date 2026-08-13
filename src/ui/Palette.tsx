import { useEffect, useMemo, useRef, useState } from "react";
import { useSyncExternalStore } from "react";
import { useStore } from "../editor/context";
import { runExportPng, runExportSvg, runExportPdf } from "../editor/exportBridge";
import { viewSize } from "../editor/view";

interface PaletteItem {
  label: string;
  hint?: string;
  run: () => void;
}

export function Palette(): JSX.Element | null {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.showPalette) {
      setQuery("");
      setIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [state.showPalette]);

  const items = useMemo<PaletteItem[]>(() => {
    const base: PaletteItem[] = [
      { label: "New document", hint: "", run: () => store.newDocument() },
      { label: "Save document", hint: "Ctrl+S", run: () => void store.saveNow() },
      { label: "Open file…", hint: "Ctrl+O", run: () => void store.loadFile() },
      { label: "Export as JSON", hint: "Ctrl+E", run: () => store.exportJson() },
      { label: "Export with images (.rnode.zip)", hint: "", run: () => void store.exportRnodeZip("complete") },
      { label: "Export with images, compact (.rnode.zip)", hint: "", run: () => void store.exportRnodeZip("compact") },
      { label: "Export as Markdown", hint: "", run: () => store.exportMarkdown() },
      { label: "Export as PNG", hint: "", run: () => runExportPng() },
      { label: "Export as SVG (vector)", hint: "", run: () => runExportSvg() },
      { label: "Export as PDF (experiment)", hint: "", run: () => runExportPdf() },
      { label: "Collect orphaned images (GC)", hint: "not undoable", run: () => void store.gcOrphans() },
      { label: "Toggle outline panel", hint: "", run: () => store.toggleOutliner() },
      { label: "Toggle inspector", hint: "", run: () => store.toggleInspector() },
      { label: "Zen / focus mode", hint: "Ctrl+Shift+F", run: () => store.toggleZen() },
      { label: "Fit map to view", hint: "Ctrl+1", run: () => store.fitView(viewSize.w, viewSize.h) },
      { label: "Undo", hint: "Ctrl+Z", run: () => store.undo() },
      { label: "Redo", hint: "Ctrl+Shift+Z", run: () => store.redo() },
      { label: "Create child topic", hint: "Tab", run: () => store.createChild() },
      { label: "Create sibling topic", hint: "Enter", run: () => store.createSibling() },
      { label: "Promote topic", hint: "Shift+Tab", run: () => store.promote() },
      { label: "Search documents…", hint: "Ctrl+F", run: () => window.dispatchEvent(new CustomEvent("r-node:focus-search")) },
      ...state.docs.filter((d) => !d.archived).map<PaletteItem>((d) => ({ label: `Open: ${d.title}`, hint: "document", run: () => store.switchToDoc(d.documentId) })),
    ];
    const q = query.trim().toLowerCase();
    return q ? base.filter((i) => i.label.toLowerCase().includes(q) || (i.hint ?? "").toLowerCase().includes(q)) : base;
  }, [query, state.docs, store]);

  if (!state.showPalette) return null;
  const clamped = Math.min(index, Math.max(items.length - 1, 0));

  return (
    <div
      className="palette-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) store.togglePalette();
      }}
    >
      <div className="palette">
        <input
          ref={inputRef}
          placeholder="Type a command or document name…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") store.togglePalette();
            else if (e.key === "ArrowDown") setIndex((i) => Math.min(i + 1, items.length - 1));
            else if (e.key === "ArrowUp") setIndex((i) => Math.max(i - 1, 0));
            else if (e.key === "Enter" && items[clamped]) {
              items[clamped].run();
              store.togglePalette();
            }
          }}
        />
        <div className="palette-list">
          {items.map((item, i) => (
            <button
              key={item.label + i}
              className={`palette-item${i === clamped ? " selected" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => { item.run(); store.togglePalette(); }}
            >
              <span>{item.label}</span>
              {item.hint && <span className="palette-hint">{item.hint}</span>}
            </button>
          ))}
          {items.length === 0 && <div className="palette-empty">No matches</div>}
        </div>
        <div className="palette-footer">↑↓ navigate · Enter run · Esc close</div>
      </div>
    </div>
  );
}
