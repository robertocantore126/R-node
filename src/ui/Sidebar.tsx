import { useEffect, useRef, useState } from "react";
import { useSyncExternalStore } from "react";
import { useStore } from "../editor/context";
import type { RmindDocument } from "../core/types";

export function Sidebar(): JSX.Element {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  useEffect(() => {
    const onFocus = (): void => searchRef.current?.focus();
    window.addEventListener("r-mind:focus-search", onFocus);
    return () => window.removeEventListener("r-mind:focus-search", onFocus);
  }, []);

  const docs = state.docs.filter((d) => !d.archived && (query === "" || d.title.toLowerCase().includes(query.toLowerCase())));
  const archived = state.docs.filter((d) => d.archived);

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-dot" />
        <span className="brand-name">R-mind</span>
      </div>

      <div className="sidebar-search">
        <input
          ref={searchRef}
          placeholder="Search documents…  (Ctrl+F)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="sidebar-actions">
        <button className="btn primary" onClick={() => store.newDocument()}>
          + New document
        </button>
        <button className="btn" onClick={() => store.switchToDoc(store.duplicateSample())} title="Create a doc from the roadmap template">
          From template
        </button>
      </div>

      <div className="sidebar-list">
        <div className="sidebar-label">Documents</div>
        {docs.map((d) => (
          <DocRow key={d.documentId} doc={d} active={d.documentId === state.activeDocId} renaming={renaming === d.documentId} onRename={(t) => { store.renameDocument(d.documentId, t); setRenaming(null); }} onStartRename={() => setRenaming(d.documentId)} />
        ))}
        {docs.length === 0 && <div className="sidebar-empty">No documents match</div>}
      </div>

      {archived.length > 0 && (
        <div className="sidebar-list">
          <div className="sidebar-label">Archived</div>
          {archived.map((d) => (
            <DocRow key={d.documentId} doc={d} active={d.documentId === state.activeDocId} renaming={false} archived onRename={() => undefined} onStartRename={() => undefined} />
          ))}
        </div>
      )}

      <div className="sidebar-footer">
        <span>Enter: sibling · Tab: child · Shift+Tab: promote · Space: collapse</span>
      </div>
    </aside>
  );
}

function DocRow({ doc, active, renaming, onRename, onStartRename, archived }: { doc: RmindDocument; active: boolean; renaming: boolean; onRename: (t: string) => void; onStartRename: () => void; archived?: boolean }): JSX.Element {
  const store = useStore();
  const [text, setText] = useState(doc.title);

  if (renaming) {
    return (
      <input
        className="doc-rename"
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onRename(text)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onRename(text);
          if (e.key === "Escape") onRename(doc.title);
        }}
      />
    );
  }

  return (
    <div className={`doc-row${active ? " active" : ""}`} onClick={() => store.switchToDoc(doc.documentId)} onDoubleClick={onStartRename}>
      <span className="doc-title">{doc.title}</span>
      <span className="doc-row-actions">
        <button
          title="Duplicate"
          onClick={(e) => { e.stopPropagation(); store.duplicateDocument(doc.documentId); }}
        >
          ⧉
        </button>
        {archived ? (
          <button
            title="Restore"
            onClick={(e) => { e.stopPropagation(); store.toggleArchive(doc.documentId); }}
          >
            ↺
          </button>
        ) : (
          <button
            title="Archive"
            onClick={(e) => { e.stopPropagation(); store.toggleArchive(doc.documentId); }}
          >
            🗄
          </button>
        )}
        <button
          title="Delete permanently"
          onClick={(e) => { e.stopPropagation(); store.deleteDocument(doc.documentId); }}
        >
          🗑
        </button>
      </span>
    </div>
  );
}
