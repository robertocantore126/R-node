// @vitest-environment jsdom
/**
 * The inline title field of a gallery / chart cell: it opens focused with the
 * title selected (so it can be copied or typed over), commits on Enter and on
 * blur, and Escape cancels without the unmount blur sneaking a commit in.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CaptionField } from "../src/ui/CaptionField";

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; });

function mount(caption: string): { input: HTMLInputElement; onCommit: ReturnType<typeof vi.fn>; onCancel: ReturnType<typeof vi.fn>; root: Root } {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  act(() => {
    root.render(<CaptionField rect={{ left: 0, top: 0, width: 100, height: 20 }} fontSize={11} caption={caption} onCommit={onCommit} onCancel={onCancel} />);
  });
  return { input: container.querySelector("input")!, onCommit, onCancel, root };
}

const type = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const key = (input: HTMLInputElement, k: string): void => {
  act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
};

it("opens focused with the whole title selected, ready to copy or replace", () => {
  const { input } = mount("blame!");
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 6]);
});

it("commits the typed title on Enter", () => {
  const { input, onCommit, onCancel } = mount("old");
  type(input, "new title");
  key(input, "Enter");
  expect(onCommit).toHaveBeenCalledWith("new title");
  expect(onCancel).not.toHaveBeenCalled();
});

it("commits on blur, once", () => {
  const { input, onCommit } = mount("old");
  type(input, "by blur");
  act(() => input.blur());
  key(input, "Enter");
  expect(onCommit).toHaveBeenCalledTimes(1);
  expect(onCommit).toHaveBeenCalledWith("by blur");
});

it("cancels on Escape and never commits through the blur that follows", () => {
  const { input, onCommit, onCancel } = mount("keep");
  type(input, "discard");
  key(input, "Escape");
  act(() => input.blur());
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onCommit).not.toHaveBeenCalled();
});
