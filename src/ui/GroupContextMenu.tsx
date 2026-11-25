import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { groupLabel } from "../core/types";
import { useStore } from "../editor/context";
import { StudyMenuStrips } from "./StudyMenuStrips";

export interface GroupMenuState {
  x: number;
  y: number;
  groupId: string;
}

interface Props {
  menu: GroupMenuState;
  onClose: () => void;
  onRename?: () => void;
}

/**
 * Right-click context menu for a group boundary: title edit, quiz & flashcard
 * strips, mistake-arrow toggle, and study prompt generation over the enclosed
 * topics.
 */
export function GroupContextMenu({ menu, onClose, onRename }: Props): JSX.Element {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, store.getUiSnapshot);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    const wrap = el?.parentElement?.getBoundingClientRect();
    if (!el || !wrap) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(6, Math.min(menu.x, wrap.width - r.width - 6)),
      y: Math.max(6, Math.min(menu.y, wrap.height - r.height - 6)),
    });
  }, [menu.x, menu.y]);

  useEffect(() => {
    const inside = (target: EventTarget | null): boolean => !!(target && ref.current?.contains(target as Node));
    const onDown = (e: PointerEvent): void => {
      if (!inside(e.target)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    const onWheel = (e: WheelEvent): void => {
      if (!inside(e.target)) onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("wheel", onWheel, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("wheel", onWheel, true);
    };
  }, [onClose]);

  const group = store.sheet.boundaries.find((g) => g.id === menu.groupId);
  if (!group) return <></>;

  const act = (fn: () => void) => (): void => {
    fn();
    onClose();
  };

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      aria-label="Group"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {onRename && (
        <>
          <button role="menuitem" onClick={act(onRename)}>
            {groupLabel(group) ? "Rename group" : "Add group title"}
          </button>
          <div className="ctx-sep" />
        </>
      )}
      <StudyMenuStrips
        quizzes={group.quizzes ?? []}
        flashcards={group.flashcards ?? []}
        showQuizMistakes={!!group.showQuizMistakes}
        activeQuizId={state.quizOpen?.quizId ?? null}
        activeDeckId={state.flashcardsOpen?.deckId ?? null}
        onOpenQuiz={(quizId) => act(() => store.openGroupQuiz(group.id, quizId))()}
        onRemoveQuiz={(quizId) => store.removeGroupQuiz(group.id, quizId)}
        onAddFromClipboard={() => void store.addGroupQuizFromClipboard(group.id)}
        onToggleMistakes={() => store.setGroupQuizMistakesVisible(group.id, !group.showQuizMistakes)}
        onCopyQuizPrompt={act(() => void store.copyGroupStudyPrompt(group.id, "quiz"))}
        onOpenFlashcards={(deckId) => act(() => store.openGroupFlashcards(group.id, deckId))()}
        onRemoveFlashcards={(deckId) => store.removeGroupFlashcards(group.id, deckId)}
        onCopyFlashcardsPrompt={act(() => void store.copyGroupStudyPrompt(group.id, "flashcards"))}
      />
    </div>
  );
}
