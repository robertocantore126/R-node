import { describe, expect, it } from "vitest";
import { $createLineBreakNode, $createParagraphNode, $createTextNode, $getRoot, createEditor } from "lexical";
import { editorStateToRuns, setEditorRuns } from "../src/ui/lexicalRuns";

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
