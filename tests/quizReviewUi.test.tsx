// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StoreContext } from "../src/editor/context";
import { EditorStore } from "../src/editor/store";
import { QuizWindow } from "../src/ui/QuizWindow";
import { NodeContextMenu } from "../src/ui/NodeContextMenu";
import { quizMistakeNodeIds } from "../src/core/quiz";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("records actual answers once, shows map arrows from the result, and toggles them beside quizzes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue(null);
  const store=new EditorStore({label:"test",async load(){return [];},async save(){}});
  const owner=store.sheet.rootNodeId;
  store.createFreeformTopic(owner);
  const board=store.getSnapshot().selection[0];
  const source=store.createFreeformItem(board,undefined,undefined,"DNS translates domain names")!;
  store.attachQuiz(owner,{questions:[{q:"What does DNS do?",answers:["Resolve names","Balance requests","Store files","Encrypt disks"],correct:0,sourceNodeIds:[source]}]});
  const quizId=store.doc.requireNode(owner).style.quizzes![0].id;
  store.openQuiz(owner,quizId);
  const container=document.createElement("div");document.body.appendChild(container);
  const root=createRoot(container);
  const click=async (text:string) => {
    const button=Array.from(container.querySelectorAll("button")).find(button=>button.textContent===text);
    expect(button,`button ${text}`).toBeTruthy();
    await act(async()=>button!.click());
  };
  try {
    await act(async()=>root.render(<StoreContext.Provider value={store}><QuizWindow/></StoreContext.Provider>));
    await click("Balance requests"); await click("See result");
    expect(store.doc.requireNode(owner).style.quizzes![0].lastAnswers).toEqual([1]);
    expect(store.doc.requireNode(owner).style.quizzes![0].score?.attempts).toBe(1);
    await click("Show mistakes on map");
    expect(store.getSnapshot().quizOpen).toBeNull();
    expect(quizMistakeNodeIds(store.sheet)).toEqual(new Set([source]));
    await act(async()=>root.render(<StoreContext.Provider value={store}><NodeContextMenu menu={{nodeId:owner,x:0,y:0}} onClose={()=>{}}/></StoreContext.Provider>));
    const toggle=container.querySelector<HTMLButtonElement>('button[aria-label="Show quiz mistakes on map"]')!;
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await act(async()=>toggle.click());
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(quizMistakeNodeIds(store.sheet).size).toBe(0);
  } finally {
    await act(async()=>root.unmount());container.remove();
  }
});
