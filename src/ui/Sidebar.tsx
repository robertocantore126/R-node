import { useEffect, useRef, useState } from "react";
import { useSyncExternalStore } from "react";
import { useStore } from "../editor/context";
import type { RnodeDocument } from "../core/types";
import logoUrl from "../assets/logo.png";

export function Sidebar(): JSX.Element {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  useEffect(() => {
    const onFocus = (): void => searchRef.current?.focus();
    window.addEventListener("r-node:focus-search", onFocus);
    return () => window.removeEventListener("r-node:focus-search", onFocus);
  }, []);

  const docs = state.docs.filter((d) => !d.archived && (query === "" || d.title.toLowerCase().includes(query.toLowerCase())));
  const archived = state.docs.filter((d) => d.archived);

  return (
    <aside className="sidebar">
      <div className="brand">
        <img className="brand-logo" src={logoUrl} alt="R-node logo" />
        <span className="brand-name">R-node</span>
      </div>

      <div className="sidebar-search">
        <input
          ref={searchRef}
          placeholder="Search documents…  (Ctrl+F)"
          data-help="Search documents"
          data-help-more="Filters the document list by title (Ctrl+F)."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
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

    </aside>
  );
}

function DocRow({ doc, active, renaming, onRename, onStartRename, archived }: { doc: RnodeDocument; active: boolean; renaming: boolean; onRename: (t: string) => void; onStartRename: () => void; archived?: boolean }): JSX.Element {
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
    <div
      className={`doc-row${active ? " active" : ""}`}
      data-help={`Document: ${doc.title}`}
      data-help-more={archived ? "Archived — click to open, double-click to rename." : "Click to open this document, double-click to rename."}
      onClick={() => store.switchToDoc(doc.documentId)}
      onDoubleClick={onStartRename}
    >
      <span className="doc-title">{doc.title}</span>
      <span className="doc-row-actions">
        <button
          data-help="Duplicate document"
          data-help-more="Creates a copy of this document."
          title="Duplicate"
          onClick={(e) => { e.stopPropagation(); store.duplicateDocument(doc.documentId); }}
        >
          ⧉
        </button>
        {archived ? (
          <button
            data-help="Restore document"
            data-help-more="Un-archives this document."
            title="Restore"
            onClick={(e) => { e.stopPropagation(); store.toggleArchive(doc.documentId); }}
          >
            ↺
          </button>
        ) : (
          <button
            data-help="Archive document"
            data-help-more="Moves the document to the Archived section. Not deleted."
            title="Archive"
            onClick={(e) => { e.stopPropagation(); store.toggleArchive(doc.documentId); }}
          >
            🗄
          </button>
        )}
        <button
          data-help="Close document"
          data-help-more="Removes the document from the open list. The file on disk is kept."
          title="Close document"
          onClick={(e) => { e.stopPropagation(); store.deleteDocument(doc.documentId); }}
        >
          🗑
        </button>
      </span>
    </div>
  );
}
