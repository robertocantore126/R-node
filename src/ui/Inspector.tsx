import { useEffect, useState } from "react";
import { useStore } from "../editor/context";
import type { Group, Relationship, Summary, TaskStatus, Priority, TopicShape } from "../core/types";
import { makeOp, type Op } from "../core/ops";
import { plainToRuns } from "../core/text";
import { MAX_IMAGE_W } from "../layout/measure";

const SHAPES: TopicShape[] = ["rounded", "rect", "capsule", "circle", "diamond", "hexagon", "underline", "none"];
const STATUSES: TaskStatus[] = ["not-started", "in-progress", "blocked", "completed", "cancelled"];
const PRIORITIES: Priority[] = ["none", "low", "medium", "high", "urgent"];
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
