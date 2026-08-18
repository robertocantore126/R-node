import { useEffect, useRef, useState } from "react";
import { useStore } from "../editor/context";
import type { Group, Relationship, Summary, TaskStatus, Priority, TopicShape } from "../core/types";
import { makeOp, type Op } from "../core/ops";
import { runExportNodeImage } from "../editor/exportBridge";
import { plainToRuns } from "../core/text";
import { GALLERY_ASPECT, GALLERY_CELL_W, MAX_IMAGE_W, TIER_CELL_W, TIER_COLS } from "../layout/measure";

const SHAPES: TopicShape[] = ["rounded", "rect", "capsule", "circle", "diamond", "hexagon", "underline", "none"];
const STATUSES: TaskStatus[] = ["not-started", "in-progress", "blocked", "completed", "cancelled"];
const PRIORITIES: Priority[] = ["none", "low", "medium", "high", "urgent"];
/** Cell shapes offered for a gallery grid, as width ÷ height. */
const CELL_SHAPES: [string, number][] = [
  ["square", 1],
  ["landscape 4:3", 4 / 3],
  ["portrait 3:4", 3 / 4],
  ["wide 16:9", 16 / 9],
  ["tall 2:3", 2 / 3],
];

const STRUCTURES = ["mindmap", "logic", "tree", "org", "timeline", "fishbone", "matrix", "treetable", "freeform"] as const;

export function Inspector(): JSX.Element {
  const store = useStore();
  const node = store.selectionNode;
  const [title, setTitle] = useState(node?.title ?? "");
  const [notes, setNotes] = useState(node?.notes ?? "");

  // Sync when the selection changes OR the same node's title/notes change
  // from elsewhere (canvas editing, undo/redo, Tab defaults). While the user
  // types here, node.title is untouched, so this does not fight the input.
  useEffect(() => {
    setTitle(node?.title ?? "");
    setNotes(node?.notes ?? "");
  }, [node?.id, node?.title, node?.notes]); // eslint-disable-line react-hooks/exhaustive-deps

  const snap = store.getSnapshot();
  const rel = snap.relSel ? store.sheet.relationships.find((r) => r.id === snap.relSel) : undefined;
  const grp = snap.groupSel ? store.sheet.boundaries.find((g) => g.id === snap.groupSel) : undefined;
  const sum = snap.summarySel ? store.sheet.summaries.find((s) => s.id === snap.summarySel) : undefined;

  if (!node && (rel || grp || sum)) {
    return (
      <aside className="inspector">
        {rel && <RelationshipSection rel={rel} />}
        {grp && <GroupSection grp={grp} />}
        {sum && <SummarySection sum={sum} />}
        <SheetControls />
      </aside>
    );
  }

  if (!node) {
    return (
      <aside className="inspector">
        <div className="inspector-empty">
          <p>Select a topic to edit its style, task and notes.</p>
          <p className="muted">Double-click the canvas to create a floating topic.</p>
        </div>
        <SheetControls />
      </aside>
    );
  }

  return (
    <aside className="inspector">
      <div className="inspector-section">
        <div className="inspector-label">Topic</div>
        <input
          className="inspector-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => { if (title !== node.title) store.execOps([makeOp<Op & { type: "setTitle" }>("setTitle", { id: node.id, title, prev: node.title, titleRuns: plainToRuns(title), prevRuns: node.titleRuns })]); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        />
        <div className="inspector-actions">
          <button className="btn small" onClick={() => store.createChild()}>+ Child</button>
          <button className="btn small" onClick={() => store.createSibling()}>+ Sibling</button>
          <button className="btn small" onClick={() => store.promote()}>↑ Promote</button>
          <button className="btn small" onClick={() => store.demote()}>↓ Demote</button>
          <button className="btn small" onClick={() => store.duplicateTopic()}>⧉ Duplicate</button>
          <button className="btn small danger" onClick={() => store.deleteNodes([node.id])}>Delete</button>
          <button className="btn small" onClick={() => store.beginRelationship(node.id)}>⇄ Link…</button>
          {snap.selection.length >= 2 && (
            <>
              <button className="btn small" onClick={() => store.createGroupFromSelection()}>❐ Group</button>
              <button className="btn small" onClick={() => store.createSummaryFromSelection()}>❨ Summary</button>
            </>
          )}
          <button className="btn small" onClick={() => store.toggleCollapsed(node.id)}>
            {node.collapsed ? "Expand" : "Collapse"}
          </button>
        </div>
        {node.type === "main" && (
          <label className="field branch-free-position">
            <span>Free positioning branch</span>
            <input
              type="checkbox"
              checked={node.position.manual}
              onChange={(e) => store.setBranchFreePosition(node.id, e.target.checked)}
            />
          </label>
        )}
      </div>

      <div className="inspector-section">
        <div className="inspector-label">Style</div>
        {node.style.code ? (
          <p className="muted">
            Code topic — view only: colours and style come from the theme and cannot be edited.
          </p>
        ) : (
          <>
            <div className="field">
              <span>Fill</span>
              <input type="color" value={node.style.fill ?? "#4f46e5"} onChange={(e) => store.setNodeStyle(node.id, { fill: e.target.value })} />
            </div>
            <div className="field">
              <span>Text</span>
              <input type="color" value={node.style.textColor ?? "#ffffff"} onChange={(e) => store.setNodeStyle(node.id, { textColor: e.target.value })} />
            </div>
            <div className="field">
              <span>Font size</span>
              <input type="number" min={10} max={48} value={node.style.fontSize ?? 14} onChange={(e) => store.setNodeStyle(node.id, { fontSize: Number(e.target.value) || 14 })} />
            </div>
            <div className="field">
              <span>Node width</span>
              <input
                type="range"
                min={90}
                max={640}
                step={5}
                value={node.style.width ?? 280}
                onChange={(e) => store.setNodeStyle(node.id, { width: Number(e.target.value) })}
                title="Fixed node width — the text re-wraps and the height follows"
              />
              <span className="muted">{node.style.width ? `${node.style.width}px` : "auto"}</span>
              <button className="btn small" title="Fit the box to the text again" onClick={() => store.setNodeStyle(node.id, { width: undefined })}>
                Auto
              </button>
            </div>
            {node.style.image && (() => {
              const att = store.sheet.attachments.find((a) => a.id === node.style.image);
              if (!att) return null;
              const natural = Math.min(att.w, MAX_IMAGE_W);
              const value = node.style.imageWidth ?? natural;
              const imgH = Math.round((value * att.h) / att.w);
              return (
                <div className="field">
                  <span>Image size</span>
                  <input
                    type="range"
                    min={48}
                    max={640}
                    step={5}
                    value={value}
                    onChange={(e) => store.setImageResizeDraft(node.id, Number(e.target.value))}
                    onPointerUp={() => store.commitImageResize()}
                    onKeyUp={() => store.commitImageResize()}
                    onBlur={() => store.commitImageResize()}
                    title="Display width — the height keeps the aspect ratio; one undo undoes the whole drag"
                  />
                  <span className="muted">
                    {value}×{imgH}px
                  </span>
                  <button
                    className="btn small"
                    title="Back to the natural display size"
                    onClick={() => store.resetImageWidth(node.id)}
                  >
                    Natural
                  </button>
                </div>
              );
            })()}
            <div className="field">
              <span>Bold</span>
              <input type="checkbox" checked={(node.style.fontWeight ?? 400) >= 600} onChange={(e) => store.setNodeStyle(node.id, { fontWeight: e.target.checked ? 600 : 400 })} />
            </div>
            <div className="field">
              <span>Shape</span>
              <select value={node.style.shape ?? "rounded"} onChange={(e) => store.setNodeStyle(node.id, { shape: e.target.value as TopicShape })}>
                {SHAPES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <button className="btn small" onClick={() => store.setNodeStyle(node.id, { fill: undefined, textColor: undefined })}>
              Reset to branch color
            </button>
          </>
        )}
      </div>

      <TierListSection nodeId={node.id} />

      <GallerySection nodeId={node.id} />

      <div className="inspector-section">
        <div className="inspector-label">Task</div>
        <div className="field">
          <span>Status</span>
          <select value={node.task?.status ?? "not-started"} onChange={(e) => store.setTask(node.id, { status: e.target.value as TaskStatus })}>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="field">
          <span>Priority</span>
          <select value={node.task?.priority ?? "none"} onChange={(e) => store.setTask(node.id, { priority: e.target.value as Priority })}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className="field">
          <span>Progress</span>
          <input type="range" min={0} max={100} step={5} value={node.task?.progress ?? 0} onChange={(e) => store.setTask(node.id, { progress: Number(e.target.value), status: Number(e.target.value) >= 100 ? "completed" : (node.task?.status ?? "not-started") })} />
          <span className="muted">{node.task?.progress ?? 0}%</span>
        </div>
        <div className="field">
          <span>Assignee</span>
          <input value={node.task?.assignee ?? ""} placeholder="—" onChange={(e) => store.setTask(node.id, { assignee: e.target.value })} />
        </div>
      </div>

      <div className="inspector-section">
        <div className="inspector-label">Notes</div>
        <textarea
          className="notes-input"
          placeholder="Rich notes land in Phase 4; plain text for now…"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => { if (notes !== node.notes) store.execOps([makeOp<Op & { type: "setNotes" }>("setNotes", { id: node.id, notes, prev: node.notes })]); }}
        />
      </div>

      <SheetControls />
    </aside>
  );
}

function SheetControls(): JSX.Element {
  const store = useStore();
  const sheet = store.sheet;
  const [title, setTitle] = useState(sheet.title);

  useEffect(() => setTitle(sheet.title), [sheet.title]);

  return (
    <div className="inspector-section">
      <div className="inspector-label" data-help="Sheet" data-help-more="The current map's settings: its name and the layout algorithm used to arrange topics.">Sheet</div>
      <input
        className="inspector-title"
        data-help="Sheet title"
        data-help-more="The name of this map (a document can hold several maps)."
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => { if (title !== sheet.title) store.setSheetTitle(title); }}
      />
      <div className="field">
        <span data-help="Structure" data-help-more="The layout algorithm: mindmap (radial), logic, tree, org, timeline, fishbone, matrix, treetable or freeform (manual).">Structure</span>
        <select value={sheet.structure.structureType} onChange={(e) => store.setStructure({ structureType: e.target.value as typeof STRUCTURES[number] })}>
          {STRUCTURES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="field">
        <span data-help="Orientation" data-help-more="Whether the map grows horizontally or vertically. Not available for mindmap/freeform.">Orientation</span>
        <select value={sheet.structure.orientation} onChange={(e) => store.setStructure({ orientation: e.target.value as "horizontal" | "vertical" })} disabled={sheet.structure.structureType === "mindmap" || sheet.structure.structureType === "freeform"}>
          <option value="horizontal">Horizontal</option>
          <option value="vertical">Vertical</option>
        </select>
      </div>
      <div className="field">
        <span data-help="Level spacing" data-help-more="Horizontal distance between a topic and its children (80–400).">Level spacing</span>
        <input type="range" min={80} max={400} step={10} value={sheet.structure.spacing} onChange={(e) => store.setStructure({ spacing: Number(e.target.value) })} />
        <span className="muted">{sheet.structure.spacing}</span>
      </div>
      <div className="field">
        <span data-help="Branch spacing" data-help-more="Vertical distance between sibling branches (4–80).">Branch spacing</span>
        <input type="range" min={4} max={80} step={2} value={sheet.structure.branchSpacing} onChange={(e) => store.setStructure({ branchSpacing: Number(e.target.value) })} />
        <span className="muted">{sheet.structure.branchSpacing}</span>
      </div>
      <div className="muted count" data-help="Visible topics" data-help-more="How many topics the map contains (hidden/collapsed subtrees excluded).">Visible topics: {store.doc.visibleNodeCount}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tier list (T26)
// ---------------------------------------------------------------------------

/**
 * The structure of a tier-list topic: its rank bands, and the cards waiting in
 * the pool.
 *
 * Ranking happens on the CANVAS by dragging — that is the gesture the chart
 * exists for and no panel should compete with it. This panel is for the things
 * a drag cannot express: adding and deleting rows, reordering the ladder,
 * renaming a rank, picking its colour, and getting cards into the pool in the
 * first place.
 */
function TierListSection({ nodeId }: { nodeId: string }): JSX.Element {
  const store = useStore();
  const node = store.selectionNode;
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState("");

  const tier = node?.style.tierList;

  const pick = async (list: FileList | null): Promise<void> => {
    if (!list || list.length === 0) return;
    setBusy(true);
    setNote("");
    const res = await store.addTierImageFiles(nodeId, Array.from(list), -1);
    setBusy(false);
    if (res.failed > 0) setNote(`${res.added} added, ${res.failed} refused${res.reason ? ` — ${res.reason}` : ""}`);
    else if (res.added > 0) setNote(`${res.added} card${res.added === 1 ? "" : "s"} in the pool`);
  };

  if (!tier) {
    return (
      <div className="inspector-section">
        <div
          className="inspector-label"
          data-help="Tier list"
          data-help-more="Turns the topic into a ranked chart: coloured rank rows, plus a pool of cards not yet ranked. Drag cards between rows on the canvas."
        >
          Tier list
        </div>
        <p className="muted">Make this topic a tier list — ranked rows plus a pool of unranked cards.</p>
        <button className="btn small" onClick={() => store.createTierList(nodeId)}>
          Make a tier list
        </button>
      </div>
    );
  }

  return (
    <div className="inspector-section">
      <div
        className="inspector-label"
        data-help="Tier list"
        data-help-more="Drag cards between rows on the canvas to rank them. This panel edits the rows themselves and fills the pool."
      >
        Tier list
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          void pick(e.target.files);
          e.target.value = "";
        }}
      />

      <ul className="gallery-list">
        {tier.rows.map((row, i) => (
          <TierRowControls key={row.id} nodeId={nodeId} index={i} last={i === tier.rows.length - 1} label={row.label} color={row.color} count={row.items.length} />
        ))}
      </ul>
      <div className="field">
        <button className="btn small" onClick={() => store.addTierRow(nodeId)}>
          Add row
        </button>
        <span className="muted">{tier.rows.length} rank{tier.rows.length === 1 ? "" : "s"}</span>
      </div>

      <div className="inspector-label" style={{ marginTop: 10 }}>Pool</div>
      <div className="field">
        <button className="btn small" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? "Adding…" : "Upload images…"}
        </button>
        <span className="muted">{tier.pool.length} waiting</span>
      </div>
      {note && <p className="muted">{note}</p>}
      <div className="field">
        <input
          className="gallery-row-caption"
          type="text"
          value={draft}
          placeholder="text card…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              store.addTierTextItem(nodeId, draft);
              setDraft("");
            }
          }}
          title="A card with no picture — type a name and press Enter"
        />
        <button
          className="btn small"
          disabled={!draft.trim()}
          onClick={() => {
            store.addTierTextItem(nodeId, draft);
            setDraft("");
          }}
        >
          Add
        </button>
      </div>

      <div className="field">
        <span>Card size</span>
        <input
          type="range"
          min={24}
          max={160}
          step={4}
          value={tier.cellW ?? TIER_CELL_W}
          onChange={(e) => store.setTierLayout(nodeId, { cellW: Number(e.target.value) })}
        />
        <span className="muted">{tier.cellW ?? TIER_CELL_W}px</span>
      </div>
      <div className="field">
        <span>Card shape</span>
        <select
          value={String(tier.aspect ?? GALLERY_ASPECT)}
          onChange={(e) => store.setTierLayout(nodeId, { aspect: Number(e.target.value) })}
        >
          {CELL_SHAPES.map(([label, value]) => (
            <option key={label} value={String(value)}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <span>Download</span>
        <button className="btn small" onClick={() => runExportNodeImage(nodeId, "image/png")} title="This chart alone, as a PNG at 2x — no page chrome, no neighbouring topics">
          PNG
        </button>
        <button className="btn small" onClick={() => runExportNodeImage(nodeId, "image/jpeg")} title="This chart alone, as a JPEG at 2x on the page background">
          JPEG
        </button>
      </div>

      <div className="field">
        <span>Per row</span>
        <input
          type="number"
          min={1}
          max={40}
          value={tier.cols ?? TIER_COLS}
          onChange={(e) => store.setTierLayout(nodeId, { cols: Math.max(1, Number(e.target.value) || 1) })}
          title="Cards before a row wraps — every row keeps the same width, so a full row grows taller"
        />
      </div>
    </div>
  );
}

/** One rank band: its label, its colour, its place in the ladder. */
function TierRowControls({
  nodeId,
  index,
  last,
  label,
  color,
  count,
}: {
  nodeId: string;
  index: number;
  last: boolean;
  label: string;
  color: string;
  count: number;
}): JSX.Element {
  const store = useStore();
  const [text, setText] = useState(label);
  useEffect(() => setText(label), [label, index]);

  return (
    <li className="gallery-row">
      <input
        type="color"
        value={color}
        onChange={(e) => store.setTierRow(nodeId, index, { color: e.target.value })}
        title="Rank colour — it is content, not theming: S is red and D is green by convention"
      />
      <input
        className="gallery-row-caption"
        type="text"
        value={text}
        placeholder="rank"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (text !== label) store.setTierRow(nodeId, index, { label: text }); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setText(label);
        }}
      />
      <span className="gallery-row-name" title={`${count} card${count === 1 ? "" : "s"}`}>{count}</span>
      <button className="btn tiny" title="Move up" disabled={index === 0} onClick={() => store.moveTierRow(nodeId, index, index - 1)}>
        ↑
      </button>
      <button className="btn tiny" title="Move down" disabled={last} onClick={() => store.moveTierRow(nodeId, index, index + 1)}>
        ↓
      </button>
      <button className="btn tiny" title="Delete this rank — its cards go back to the pool" onClick={() => store.removeTierRow(nodeId, index)}>
        ✕
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Gallery (T25)
// ---------------------------------------------------------------------------

/**
 * The cells of a gallery topic: their order, their size, and their captions.
 *
 * Captions are edited HERE and nowhere else, and that is the design rather
 * than a limitation. Editing them on the canvas would mean a Lexical overlay
 * over the caption, which is a second renderer over the same text and drags
 * the whole editor-canvas parity contract (AGENT_GUIDE §3) along with it — for
 * a label that is one short line at a fixed size. Kept in this panel, a
 * caption is a plain string the canvas draws and nothing has to agree with
 * anything.
 *
 * There are no thumbnails on purpose: the pictures are already on the canvas
 * a few centimetres away, and rendering them again here would mean object URLs
 * per row, with their revocation, for a second view of the same thing.
 */
function GallerySection({ nodeId }: { nodeId: string }): JSX.Element {
  const store = useStore();
  const node = store.selectionNode;
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const gallery = node?.style.gallery;
  const items = gallery?.items ?? [];

  const pick = async (list: FileList | null): Promise<void> => {
    if (!list || list.length === 0) return;
    setBusy(true);
    setNote("");
    const res = await store.addGalleryImageFiles(nodeId, Array.from(list));
    setBusy(false);
    // Say why, every time, rather than dropping a file silently (§4bis).
    if (res.failed > 0) setNote(`${res.added} added, ${res.failed} refused${res.reason ? ` — ${res.reason}` : ""}`);
    else if (res.added > 0) setNote(`${res.added} image${res.added === 1 ? "" : "s"} added`);
  };

  return (
    <div className="inspector-section">
      <div
        className="inspector-label"
        data-help="Gallery"
        data-help-more="Fills the topic with a grid of captioned pictures — a tier-list row, a mood board, a cast list. The title stays above the grid."
      >
        Gallery
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          void pick(e.target.files);
          e.target.value = ""; // so re-picking the same file fires again
        }}
      />

      <div className="field">
        <button className="btn small" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? "Adding…" : items.length > 0 ? "Add more images…" : "Add images…"}
        </button>
        {items.length > 0 && <span className="muted">{items.length} in the grid</span>}
      </div>
      {note && <p className="muted">{note}</p>}

      {items.length === 0 ? (
        <p className="muted">No pictures yet. Added images fill the body of the topic as a grid, each captioned with its file name.</p>
      ) : (
        <>
          <div className="field">
            <span>Cell size</span>
            <input
              type="range"
              min={24}
              max={200}
              step={4}
              value={gallery?.cellW ?? GALLERY_CELL_W}
              onChange={(e) => store.setGalleryLayout(nodeId, { cellW: Number(e.target.value) })}
              title="Side of one cell — the pictures are cropped square to fill it"
            />
            <span className="muted">{gallery?.cellW ?? GALLERY_CELL_W}px</span>
          </div>
          <div className="field">
            <span>Cell shape</span>
            <select
              value={String(gallery?.aspect ?? GALLERY_ASPECT)}
              onChange={(e) => store.setGalleryLayout(nodeId, { aspect: Number(e.target.value) })}
              title="Every cell takes this shape; the pictures are cropped to their centre to fill it"
            >
              {CELL_SHAPES.map(([label, value]) => (
                <option key={label} value={String(value)}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <span>Columns</span>
            <input
              type="number"
              min={0}
              max={40}
              value={gallery?.cols ?? 0}
              onChange={(e) => {
                const v = Number(e.target.value);
                store.setGalleryLayout(nodeId, { cols: v > 0 ? Math.floor(v) : undefined });
              }}
              title="0 wraps the grid to the topic's width"
            />
            <span className="muted">{gallery?.cols ? "fixed" : "auto"}</span>
          </div>

          <ul className="gallery-list">
            {items.map((item, i) => (
              <GalleryRow
                key={`${item.id}-${i}`}
                nodeId={nodeId}
                index={i}
                last={i === items.length - 1}
                caption={item.caption ?? ""}
                name={store.sheet.attachments.find((a) => a.id === item.id)?.name ?? item.id.slice(0, 8)}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** One cell's row: its caption, its place in the order, and its removal. */
function GalleryRow({
  nodeId,
  index,
  last,
  caption,
  name,
}: {
  nodeId: string;
  index: number;
  last: boolean;
  caption: string;
  name: string;
}): JSX.Element {
  const store = useStore();
  const [text, setText] = useState(caption);
  // Follow the document when it changes under us (undo, reorder), but never
  // while the field is being typed into — the commit is on blur/Enter, so
  // node state and this state only meet at those points.
  useEffect(() => setText(caption), [caption, index]);

  const commit = (): void => {
    if (text.trim() !== caption) store.setGalleryCaption(nodeId, index, text);
  };

  return (
    <li className="gallery-row">
      <span className="gallery-row-name" title={name}>
        {name}
      </span>
      <input
        className="gallery-row-caption"
        type="text"
        value={text}
        placeholder="caption"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setText(caption);
        }}
      />
      <button className="btn tiny" title="Move earlier" disabled={index === 0} onClick={() => store.moveGalleryItem(nodeId, index, index - 1)}>
        ↑
      </button>
      <button className="btn tiny" title="Move later" disabled={last} onClick={() => store.moveGalleryItem(nodeId, index, index + 1)}>
        ↓
      </button>
      <button className="btn tiny" title="Remove from the grid (the picture itself is kept)" onClick={() => store.removeGalleryItem(nodeId, index)}>
        ✕
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Overlay sections: relationship, group, summary
// ---------------------------------------------------------------------------

function RelationshipSection({ rel }: { rel: Relationship }): JSX.Element {
  const store = useStore();
  const [label, setLabel] = useState(rel.label ?? "");
  useEffect(() => setLabel(rel.label ?? ""), [rel.id, rel.label]); // eslint-disable-line react-hooks/exhaustive-deps
  const a = store.doc.node(rel.fromId);
  const b = store.doc.node(rel.toId);
  return (
    <div className="inspector-section">
      <div className="inspector-label">Relationship</div>
      <p className="muted">{a?.title ?? "?"} → {b?.title ?? "?"}</p>
      <div className="field">
        <span>Label</span>
        <input
          value={label}
          placeholder="(none)"
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => { if (label !== (rel.label ?? "")) store.setRelationship(rel.id, { label: label.trim() || undefined }); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        />
      </div>
      <label className="field">
        <span>Bidirectional arrows</span>
        <input type="checkbox" checked={!!rel.bidirectional} onChange={(e) => store.setRelationship(rel.id, { bidirectional: e.target.checked })} />
      </label>
      <div className="field">
        <span>Line style</span>
        <select value={rel.lineStyle ?? "dashed"} onChange={(e) => store.setRelationship(rel.id, { lineStyle: e.target.value as Relationship["lineStyle"] })}>
          <option value="solid">solid</option>
          <option value="dashed">dashed</option>
          <option value="dotted">dotted</option>
        </select>
      </div>
      <button className="btn small danger" onClick={() => store.deleteSelectedRelationship()}>Delete relationship</button>
    </div>
  );
}

function GroupSection({ grp }: { grp: Group }): JSX.Element {
  const store = useStore();
  return (
    <div className="inspector-section">
      <div className="inspector-label">Group</div>
      <p className="muted">{grp.memberIds.length} topics enclosed</p>
      <button className="btn small danger" onClick={() => store.deleteGroup(grp.id)}>Delete group</button>
    </div>
  );
}

function SummarySection({ sum }: { sum: Summary }): JSX.Element {
  const store = useStore();
  const [label, setLabel] = useState(sum.label ?? "");
  useEffect(() => setLabel(sum.label ?? ""), [sum.id, sum.label]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="inspector-section">
      <div className="inspector-label">Summary</div>
      <p className="muted">{sum.memberIds.length} topics spanned</p>
      <div className="field">
        <span>Label</span>
        <input
          value={label}
          placeholder="Summary"
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => { if (label !== (sum.label ?? "")) store.setSummary(sum.id, { label: label.trim() || undefined }); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        />
      </div>
      <button className="btn small danger" onClick={() => store.deleteSummary(sum.id)}>Delete summary</button>
    </div>
  );
}
