import { describe, expect, it } from "vitest";
import { $createLineBreakNode, $createParagraphNode, $createTextNode, $getRoot, createEditor } from "lexical";
import { ListItemNode, ListNode } from "@lexical/list";
import { editorStateToRuns, setEditorRuns } from "../src/ui/lexicalRuns";
import type { TextRun } from "../src/core/types";

// FORMAT_* bits mirroring Lexical's TextNode format flags.
const F_BOLD = 1;
const F_ITALIC = 2;

async function makeEditorWith(texts: Array<{ text: string; format?: number; style?: string }>): Promise<ReturnType<typeof createEditor>> {
  const editor = createEditor();
  await editor.update(() => {
    const root = $getRoot();
    root.clear();
    const p = $createParagraphNode();
    for (const t of texts) {
      const n = $createTextNode(t.text);
      if (t.format) n.setFormat(t.format);
      if (t.style) n.setStyle(t.style);
      p.append(n);
    }
    root.append(p);
  });
  return editor;
}

describe("lexicalRuns bridge", () => {
  it("converts bold/italic/underline/color editor state into TextRuns", async () => {
    const editor = await makeEditorWith([
      { text: "Bold", format: F_BOLD },
      { text: " italic", format: F_ITALIC },
      { text: " color", style: "color: #ff0000" },
      { text: " plain" },
    ]);
    const runs = editorStateToRuns(editor.getEditorState());
    const find = (s: string) => runs.find((r) => r.text.includes(s))!;
    expect(find("Bold").bold).toBe(true);
    expect(find("italic").italic).toBe(true);
    expect(find("color").color).toBe("#ff0000");
    expect(find("plain").bold ?? false).toBe(false);
  });

  it("flattens line breaks and paragraphs into \\n-separated runs", async () => {
    const editor = createEditor();
    await editor.update(() => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      p.append($createTextNode("line1"), $createLineBreakNode(), $createTextNode("line2"));
      root.append(p);
    });
    const runs = editorStateToRuns(editor.getEditorState());
    const plain = runs.map((r) => r.text).join("");
    expect(plain).toBe("line1\nline2");
  });

  it("seeds an editor from runs (bold + color) and reads them back unchanged", async () => {
    const editor = createEditor();
    setEditorRuns(editor, [
      { text: "Rich ", bold: true },
      { text: "text", color: "#d43a3a" },
    ]);
    // editor.update() schedules the commit on a microtask even though its
    // declared return type is void.
    await Promise.resolve();
    const runs = editorStateToRuns(editor.getEditorState());
    expect(runs).toEqual([
      { text: "Rich ", bold: true },
      { text: "text", color: "#d43a3a" },
    ]);
  });

  it("drops zero-length runs when normalizing", async () => {
    const editor = createEditor();
    setEditorRuns(editor, [{ text: "" }, { text: "x" }]);
    await Promise.resolve();
    const runs = editorStateToRuns(editor.getEditorState());
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe("x");
  });
});

describe("lexicalRuns round trip (runs → editor → runs)", () => {
  async function roundTrip(runs: TextRun[]): Promise<TextRun[]> {
    const editor = createEditor({ nodes: [ListNode, ListItemNode], onError: (e) => { throw e; } });
    setEditorRuns(editor, runs);
    await Promise.resolve();
    return editorStateToRuns(editor.getEditorState());
  }

  const LIST: TextRun[] = [
    { text: "one", listIndent: 1 },
    { text: "\n" },
    { text: "two", listIndent: 1 },
    { text: "\n" },
    { text: "nested", listIndent: 2 },
  ];

  it("keeps nested list depth (structural nesting and getIndent are one level, not two)", async () => {
    const out = await roundTrip(LIST);
    expect(out.filter((r) => r.listIndent).map((r) => r.listIndent)).toEqual([1, 1, 2]);
  });

  it("is idempotent: editing a title twice must not change it", async () => {
    // The canvas lays out whatever comes back from here, so any drift between
    // cycles shows up as the node silently growing/indenting on every edit.
    const once = await roundTrip(LIST);
    const twice = await roundTrip(once);
    expect(twice).toEqual(once);
    const thrice = await roundTrip(twice);
    expect(thrice).toEqual(once);
  });

  it("does not accumulate the newline that closes a list", async () => {
    const once = await roundTrip(LIST);
    const twice = await roundTrip(once);
    const tail = (rs: TextRun[]): string => rs.map((r) => r.text).join("").match(/\n*$/)![0];
    expect(tail(twice)).toBe(tail(once));
    expect(tail(once).length).toBeLessThanOrEqual(1);
  });

  it("keeps paragraphs separate across a round trip", async () => {
    const out = await roundTrip([{ text: "first" }, { text: "second", paraGap: true }]);
    expect(out.map((r) => r.text)).toEqual(["first", "second"]);
    expect(out[1].paraGap).toBe(true);
  });
});
