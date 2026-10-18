import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorStore } from "../src/editor/store";
import { normalizeQuiz, quizMistakeNodeIds, quizTopicOutline } from "../src/core/quiz";
import { displayedMistakeNodes, drawQuizMistakeArrow } from "../src/render/quizMarkers";
import type { QuizQuestion } from "../src/core/types";

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const store = new EditorStore({ label: "test", async load(){return [];}, async save(){} });
  const root = store.sheet.rootNodeId;
  store.createFreeformTopic(root);
  const board = store.getSnapshot().selection[0];
  const a = store.createFreeformItem(board,undefined,undefined,"Azure Load Balancer")!;
  const b = store.createFreeformItem(board,undefined,undefined,"Azure DNS")!;
  const question = (id: string): QuizQuestion => ({q:`Question ${id}`,answers:["a","b","c","d"],correct:0,sourceNodeIds:[id]});
  store.attachQuiz(root,{questions:[question(a),question(b)]});
  const quizId = store.doc.requireNode(root).style.quizzes![0].id;
  return {store,root,board,a,b,quizId};
}

describe("quiz mistake review", () => {
  it("marks only missed freeform topics and replaces old mistakes on a successful retry", () => {
    const {store,root,a,b,quizId} = setup();
    store.submitQuizScore(root,quizId,[1,0]);
    expect(quizMistakeNodeIds(store.sheet).size).toBe(0);
    store.setQuizMistakesVisible(root,true);
    expect([...quizMistakeNodeIds(store.sheet)]).toEqual([a]);
    expect(quizMistakeNodeIds(store.sheet).has(b)).toBe(false);
    store.submitQuizScore(root,quizId,[0,0]);
    expect(quizMistakeNodeIds(store.sheet).size).toBe(0);
    store.undo();
    expect([...quizMistakeNodeIds(store.sheet)]).toEqual([a]);
    store.setQuizMistakesVisible(root,false);
    expect(quizMistakeNodeIds(store.sheet).size).toBe(0);
    store.undo();
    expect([...quizMistakeNodeIds(store.sheet)]).toEqual([a]);
  });

  it("keeps other quizzes' mistakes until those quizzes are corrected or removed", () => {
    const {store,root,a,b,quizId} = setup();
    store.attachQuiz(root,{questions:[{q:"DNS?",answers:["a","b","c","d"],correct:0,sourceNodeIds:[b]}]});
    const second = store.doc.requireNode(root).style.quizzes![1].id;
    store.submitQuizScore(root,quizId,[1,0]); store.submitQuizScore(root,second,[1]);
    store.setQuizMistakesVisible(root,true);
    expect(quizMistakeNodeIds(store.sheet)).toEqual(new Set([a,b]));
    store.submitQuizScore(root,quizId,[0,0]);
    expect(quizMistakeNodeIds(store.sheet)).toEqual(new Set([b]));
    store.removeQuiz(root,second);
    expect(quizMistakeNodeIds(store.sheet).size).toBe(0);
  });

  it("uses the quiz owner for unlinked, deleted and out-of-branch sources", () => {
    const {store,root,board,a} = setup();
    store.attachQuiz(board,{questions:[{q:"Old quiz",answers:["a","b","c","d"],correct:0}]});
    const id = store.doc.requireNode(board).style.quizzes![0].id;
    store.submitQuizScore(board,id,[1]); store.setQuizMistakesVisible(board,true);
    expect(quizMistakeNodeIds(store.sheet)).toEqual(new Set([board]));
    store.doc.requireNode(board).style.quizzes![0].questions[0].sourceNodeIds=[root,"deleted"];
    expect(quizMistakeNodeIds(store.sheet)).toEqual(new Set([board]));
    store.doc.requireNode(board).style.quizzes![0].questions[0].sourceNodeIds=[a];
    expect(quizMistakeNodeIds(store.sheet)).toEqual(new Set([a]));
    store.deleteNodes([a]);
    expect(quizMistakeNodeIds(store.sheet)).toEqual(new Set([board]));
  });

  it("rejects partial/invalid attempts and keeps older numeric score callers compatible", () => {
    const {store,root,quizId} = setup();
    store.submitQuizScore(root,quizId,[1]); store.submitQuizScore(root,quizId,[0,9]);
    expect(store.doc.requireNode(root).style.quizzes![0].score).toBeUndefined();
    store.submitQuizScore(root,quizId,1); store.setQuizMistakesVisible(root,true);
    expect(quizMistakeNodeIds(store.sheet)).toEqual(new Set([root]));
  });

  it("puts exact IDs and nested freeform text into the generation prompt, including floating roots", async () => {
    const {store,root,board,a} = setup();
    const writeText=vi.fn(async (_text:string)=>{});
    vi.stubGlobal("navigator",{clipboard:{writeText}});
    await store.copyQuizPrompt(root);
    const prompt=writeText.mock.calls[0][0];
    expect(prompt).toContain(`[topic ${JSON.stringify(a)}] "Azure Load Balancer"`);
    expect(prompt).toContain('"sourceNodeIds"');
    store.doc.requireNode(board).parentId=null;
    expect(quizTopicOutline(store.sheet,board)).toContain("Azure Load Balancer");
  });

  it("validates question links while accepting legacy quiz JSON", () => {
    const base={app:"r-node",kind:"quiz",questions:[{q:"?",answers:["a","b","c","d"],correct:0}]};
    expect(normalizeQuiz(base)).not.toBeNull();
    expect(normalizeQuiz({...base,questions:[{...base.questions[0],sourceNodeIds:["a","a"]}]})!.questions[0].sourceNodeIds).toEqual(["a"]);
    for(const sourceNodeIds of [[],[null],[3],"a"]) expect(normalizeQuiz({...base,questions:[{...base.questions[0],sourceNodeIds}]})).toBeNull();
  });

  it("remaps question sources when a freeform branch is copied and pasted", async () => {
    const {store,board,a,root} = setup();
    store.attachQuiz(board,{questions:[{q:"Balancer?",answers:["a","b","c","d"],correct:0,sourceNodeIds:[a]}]});
    let text="";
    vi.stubGlobal("navigator",{clipboard:{writeText:async(value:string)=>{text=value;},readText:async()=>text}});
    store.select(board); await store.copySelection(); store.select(root); await store.paste();
    const pasted=store.doc.requireNode(store.getSnapshot().selection[0]);
    expect(pasted.id).not.toBe(board);
    expect(pasted.style.quizzes![0].questions[0].sourceNodeIds).toEqual([pasted.childrenIds[0]]);
    expect(store.doc.requireNode(board).style.quizzes![0].questions[0].sourceNodeIds).toEqual([a]);
  });

  it("moves an arrow to the collapsed ancestor and keeps its size stable when zooming", () => {
    const {store,root,board,a}=setup();
    expect(displayedMistakeNodes(store.sheet,new Set([root,board]),new Set([a]))).toEqual(new Set([board]));
    function widthAt(scale:number) {
      const points:number[]=[];
      const ctx=new Proxy({}, {get:(_target,key)=>key==="lineTo"||key==="moveTo" ? (x:number)=>points.push(x) : ()=>{},set:()=>true}) as CanvasRenderingContext2D;
      drawQuizMistakeArrow(ctx,{x:0,y:0,w:100},scale);
      return (Math.max(...points)-Math.min(...points))*scale;
    }
    expect(widthAt(.1)).toBeCloseTo(widthAt(2));
  });
});
