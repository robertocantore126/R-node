import { useEffect, useRef, useSyncExternalStore } from "react";
import { useStore } from "../editor/context";

/**
 * In-map search (Ctrl+F).
 *
 * Searches EVERY topic's title and notes — including branches hidden inside a
 * collapsed ancestor, which a jump expands into view — and walks the matches
 * with Enter / Shift+Enter. The canvas paints the highlight for all matches and
 * a stronger ring for the current one; this bar only drives the query and the
 * index. Esc closes it and clears the query, without touching the selection.
 */
export function SearchBar(): JSX.Element | null {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!state.searchOpen) return;
    const focus = (): void => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    focus();
    window.addEventListener("r-node:focus-map-search", focus);
    return () => window.removeEventListener("r-node:focus-map-search", focus);
  }, [state.searchOpen]);

  if (!state.searchOpen) return null;

  const total = state.searchResults.length;
  const current = total > 0 ? state.searchIndex + 1 : 0;
  const hasQuery = state.search.trim().length > 0;

  return (
    <div
      className="map-search"
      data-help="Find in map"
      data-help-more="Searches every topic (title and notes), including collapsed branches. Enter / Shift+Enter walk the matches; Esc closes."
    >
      <span className="map-search-icon" aria-hidden="true">
        ⌕
      </span>
      <input
        ref={inputRef}
        className="map-search-input"
        placeholder="Find in map…"
        value={state.search}
        onChange={(e) => store.setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            store.closeSearch();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Enter") {
            e.preventDefault();
            store.jumpToSearch(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="map-search-count">{hasQuery ? `${current}/${total}` : ""}</span>
      <button
        className="map-search-btn"
        title="Previous match (Shift+Enter)"
        disabled={total === 0}
        onClick={() => store.jumpToSearch(-1)}
      >
        ↑
      </button>
      <button
        className="map-search-btn"
        title="Next match (Enter)"
        disabled={total === 0}
        onClick={() => store.jumpToSearch(1)}
      >
        ↓
      </button>
      <button className="map-search-btn" title="Close (Esc)" onClick={() => store.closeSearch()}>
        ✕
      </button>
    </div>
  );
}
