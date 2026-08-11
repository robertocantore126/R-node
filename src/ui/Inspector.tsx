import { useEffect, useState } from "react";
import { useStore } from "../editor/context";
import type { TaskStatus, Priority, TopicShape } from "../core/types";
import { makeOp, type Op } from "../core/ops";
import { plainToRuns } from "../core/text";

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
      <div className="inspector-label">Sheet</div>
      <input
        className="inspector-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => { if (title !== sheet.title) store.setSheetTitle(title); }}
      />
      <div className="field">
        <span>Structure</span>
        <select value={sheet.structure.structureType} onChange={(e) => store.setStructure({ structureType: e.target.value as typeof STRUCTURES[number] })}>
          {STRUCTURES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="field">
        <span>Orientation</span>
        <select value={sheet.structure.orientation} onChange={(e) => store.setStructure({ orientation: e.target.value as "horizontal" | "vertical" })} disabled={sheet.structure.structureType === "mindmap" || sheet.structure.structureType === "freeform"}>
          <option value="horizontal">Horizontal</option>
          <option value="vertical">Vertical</option>
        </select>
      </div>
      <div className="field">
        <span>Level spacing</span>
        <input type="range" min={80} max={400} step={10} value={sheet.structure.spacing} onChange={(e) => store.setStructure({ spacing: Number(e.target.value) })} />
        <span className="muted">{sheet.structure.spacing}</span>
      </div>
      <div className="field">
        <span>Branch spacing</span>
        <input type="range" min={4} max={80} step={2} value={sheet.structure.branchSpacing} onChange={(e) => store.setStructure({ branchSpacing: Number(e.target.value) })} />
        <span className="muted">{sheet.structure.branchSpacing}</span>
      </div>
      <button className="btn small" onClick={() => store.autoLayoutAll()}>⟳ Auto layout</button>
      <div className="muted count">Visible topics: {store.doc.visibleNodeCount}</div>
    </div>
  );
}
