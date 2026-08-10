import { useState } from "react";
import { useSyncExternalStore } from "react";
import { useStore } from "../editor/context";
import type { MindNode } from "../core/types";
import { makeOp, type Op } from "../core/ops";

export function Outliner(): JSX.Element {
  const store = useStore();
  const root = store.doc.rootNode;

  return (
    <div className="outliner">
      <div className="outliner-header">
        <span>Outline</span>
        <button className="btn small" onClick={() => store.toast("Import from Markdown lands in Phase 4")}>
          Import
        </button>
      </div>
      <div className="outliner-body">
        <OutlinerRow node={root} depth={0} />
      </div>
    </div>
  );
}

function OutlinerRow({ node, depth }: { node: MindNode; depth: number }): JSX.Element {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [text, setText] = useState(node.title);
  const selected = state.selection.includes(node.id);
  const hasChildren = node.childrenIds.length > 0;

  return (
    <div className="outliner-node">
      <div
        className={`outliner-row${selected ? " selected" : ""}`}
        style={{ paddingLeft: 10 + depth * 18 }}
        onClick={() => store.select(node.id, { center: true })}
        onDoubleClick={() => store.startEdit(node.id)}
      >
        <button
          className={`outliner-caret${node.collapsed ? " collapsed" : ""}`}
          disabled={!hasChildren}
          onClick={(e) => { e.stopPropagation(); if (hasChildren) store.toggleCollapsed(node.id); }}
        >
          {hasChildren ? "▾" : "·"}
        </button>
        {node.task ? (
          <button
            className="outliner-check"
            onClick={(e) => { e.stopPropagation(); store.toggleTaskComplete(node.id); }}
          >
            {node.task.status === "completed" ? "☑" : "☐"}
          </button>
        ) : (
          <span className="outliner-check placeholder" />
        )}
        <input
          className="outliner-title"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => { if (text !== node.title) store.execOps([makeOp<Op & { type: "setTitle" }>("setTitle", { id: node.id, title: text, prev: node.title })]); }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          onClick={(e) => e.stopPropagation()}
        />
        {node.task && node.task.priority && node.task.priority !== "none" && <span className={`prio prio-${node.task.priority}`} title={`Priority: ${node.task.priority}`} />}
      </div>
      {!node.collapsed &&
        node.childrenIds.map((id) => {
          const child = store.doc.node(id);
          return child ? <OutlinerRow key={id} node={child} depth={depth + 1} /> : null;
        })}
    </div>
  );
}
