import { describe, expect, it } from "vitest";
import { asCodeLang, tokenize, type CodePalette } from "../src/core/codeHighlight";

const P: CodePalette = {
  id: "test",
  plain: "#plain",
  keyword: "#kw",
  string: "#str",
  number: "#num",
  comment: "#com",
  fn: "#fn",
  punct: "#pun",
};

const plainOf = (runs: { text: string }[]): string => runs.map((r) => r.text).join("");
/** Colour of the run that IS this token — exact, so `greet` does not match the
 *  comment that happens to mention it. */
const colourOf = (runs: { text: string; color?: string }[], token: string): string | undefined =>
  runs.find((r) => r.text === token)?.color;
/** Colour of the run that CONTAINS this text — for comments and strings, whose
 *  run carries its delimiters too. */
const colourAround = (runs: { text: string; color?: string }[], needle: string): string | undefined =>
  runs.find((r) => r.text.includes(needle))?.color;

const TS = `// greet someone
function greet(name: string) {
    const n = 42;
    return \`ciao \${name}\`;
}
`;

describe("tokenize — losslessness", () => {
  // The property everything else rests on. The source lives in node.title and
  // I5 requires title === runsToPlain(titleRuns), so a tokenizer that drops a
  // space corrupts the document instead of merely mis-colouring it.
  it("reproduces the source exactly, whitespace and newlines included", () => {
    for (const lang of ["ts", "js", "cpp", "text"] as const) {
      expect(plainOf(tokenize(TS, lang, P))).toBe(TS);
    }
  });

  it("survives the awkward inputs without losing a character", () => {
    const cases = [
      "",
      "\n\n\n",
      "    indented only",
      "unterminated 'quote here\nnext line",
      "/* unterminated block comment",
      "trailing backslash \\",
      "emoji 🌱 and àccènti",
      "a\tb\tc",
    ];
    for (const src of cases) {
      expect(plainOf(tokenize(src, "ts", P))).toBe(src);
    }
  });

  it("keeps the newline OUT of a line comment, so line splitting still sees it", () => {
    const runs = tokenize("// note\ncode", "ts", P);
    expect(runs.find((r) => r.text.startsWith("//"))?.text).toBe("// note");
    expect(plainOf(runs)).toBe("// note\ncode");
  });
});

describe("tokenize — colouring", () => {
  it("separates keywords, strings, numbers, comments and calls", () => {
    const runs = tokenize(TS, "ts", P);
    expect(colourOf(runs, "function")).toBe(P.keyword);
    expect(colourOf(runs, "greet")).toBe(P.fn);
    expect(colourOf(runs, "42")).toBe(P.number);
    expect(colourAround(runs, "// greet someone")).toBe(P.comment);
    expect(colourAround(runs, "ciao")).toBe(P.string);
  });

  it("gives every keyword of a language the SAME colour", () => {
    // The tell of a hand-painted snippet rather than a tokenizer is `int` and
    // `return` coming out different colours. They must not.
    const runs = tokenize("int x = 1;\nreturn x;", "cpp", P);
    expect(colourOf(runs, "int")).toBe(P.keyword);
    expect(colourOf(runs, "return")).toBe(P.keyword);
  });

  it("treats an unknown language as plain text in one run", () => {
    const runs = tokenize("function whatever()", "text", P);
    expect(runs).toHaveLength(1);
    expect(runs[0].color).toBe(P.plain);
  });

  it("takes its colours from the palette, never from the source", () => {
    const other: CodePalette = { ...P, id: "other", keyword: "#zzz" };
    expect(colourOf(tokenize(TS, "ts", other), "function")).toBe("#zzz");
  });
});

describe("tokenize — cache", () => {
  it("returns the identical array for a repeated call", () => {
    const a = tokenize(TS, "ts", P);
    expect(tokenize(TS, "ts", P)).toBe(a); // same reference, not merely equal
  });

  it("does not confuse two palettes or two languages", () => {
    const light: CodePalette = { ...P, id: "light", keyword: "#111" };
    const dark: CodePalette = { ...P, id: "dark", keyword: "#eee" };
    expect(colourOf(tokenize(TS, "ts", light), "function")).toBe("#111");
    expect(colourOf(tokenize(TS, "ts", dark), "function")).toBe("#eee");
    expect(tokenize(TS, "ts", light)).not.toBe(tokenize(TS, "js", light));
  });
});

describe("asCodeLang", () => {
  it("passes through what it knows and falls back to text", () => {
    expect(asCodeLang("ts")).toBe("ts");
    expect(asCodeLang("cpp")).toBe("cpp");
    expect(asCodeLang("rust")).toBe("text");
    expect(asCodeLang(undefined)).toBe("text");
  });
});
