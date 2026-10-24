/**
 * Web search panel: find an album, a film, a book or a Wikipedia page and
 * drag the result onto the map (see `EditorStore.placeWebItem`). DOM chrome
 * beside the canvas, like the Outliner — the single-canvas rule (I1) governs
 * the map, not the panels around it.
 */
import { useEffect, useRef, useState, type DragEvent } from "react";
import { useStore } from "../editor/context";
import { searchWeb, WEB_ITEM_DRAG_TYPE, WEB_SOURCES, type WebItem, type WebLang, type WebSource } from "../editor/webSearch";

/** Remembered between sessions per browser: the tab and the language. */
const PREFS_KEY = "rnode.webSearch";

function loadPrefs(): { source: WebSource; lang: WebLang } {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as { source?: WebSource; lang?: WebLang };
    return { source: WEB_SOURCES.some((s) => s.id === p.source) ? p.source! : "albums", lang: p.lang === "en" ? "en" : "it" };
  } catch {
    return { source: "albums", lang: "it" };
  }
}

export function WebSearchPanel(): JSX.Element {
  const store = useStore();
  const [prefs, setPrefs] = useState(loadPrefs);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WebItem[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "empty">("idle");
  const [error, setError] = useState("");
  const seq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode: not remembered */ }
  }, [prefs]);

  // Search as you type, a moment after the last key; a newer search wins
  // over an older one still in flight.
  useEffect(() => {
    const q = query.trim();
    if (q === "") {
      setResults([]);
      setStatus("idle");
      return;
    }
    const mine = ++seq.current;
    const timer = window.setTimeout(async () => {
      setStatus("loading");
      try {
        const found = await searchWeb(prefs.source, q, prefs.lang);
        if (mine !== seq.current) return;
        setResults(found);
        setStatus(found.length === 0 ? "empty" : "idle");
      } catch (e) {
        if (mine !== seq.current) return;
        setResults([]);
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [query, prefs.source, prefs.lang]);

  const onDragStart = (e: DragEvent, item: WebItem): void => {
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData(WEB_ITEM_DRAG_TYPE, JSON.stringify(item));
    // The plain image URL too, so the canvas's drop hints (and other apps)
    // see an image coming.
    if (item.imageUrl) e.dataTransfer.setData("text/uri-list", item.imageUrl);
    e.dataTransfer.setData("text/plain", item.title);
  };

  return (
    <div className="websearch" role="complementary" aria-label="Web search">
      <div className="websearch-header">
        <span>Web search</span>
        <button className="btn icon" title="Close" aria-label="Close web search" onClick={() => store.toggleWebSearch()}>×</button>
      </div>
      <div className="websearch-tabs" role="tablist">
        {WEB_SOURCES.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={prefs.source === s.id}
            className={prefs.source === s.id ? "on" : ""}
            onClick={() => setPrefs({ ...prefs, source: s.id })}
          >
            {s.label}
          </button>
        ))}
        <select
          aria-label="Language"
          title="Language (Wikipedia, store country)"
          value={prefs.lang}
          onChange={(e) => setPrefs({ ...prefs, lang: e.target.value === "en" ? "en" : "it" })}
        >
          <option value="it">IT</option>
          <option value="en">EN</option>
        </select>
      </div>
      <input
        ref={inputRef}
        className="websearch-input"
        type="search"
        placeholder={prefs.source === "wikipedia" ? "Search Wikipedia…" : `Search ${prefs.source}…`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        // Keys typed here belong to the field, not to the map's shortcuts.
        onKeyDown={(e) => e.stopPropagation()}
      />
      <div className="websearch-hint">Drag a result onto a chart box, a topic or the canvas.</div>
      <div className="websearch-results">
        {status === "loading" && <div className="websearch-status">Searching…</div>}
        {status === "empty" && <div className="websearch-status">No results</div>}
        {status === "error" && <div className="websearch-status error">{error}</div>}
        {results.map((item, i) => (
          <div
            key={`${item.url ?? item.title}:${i}`}
            className="websearch-item"
            draggable
            onDragStart={(e) => onDragStart(e, item)}
            title={[item.title, item.subtitle].filter(Boolean).join(" — ")}
          >
            {item.thumbUrl ? <img src={item.thumbUrl} alt="" draggable={false} loading="lazy" /> : <div className="websearch-noimg">?</div>}
            <div className="websearch-text">
              <div className="websearch-title">{item.title}</div>
              {item.subtitle && <div className="websearch-sub">{item.subtitle}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
