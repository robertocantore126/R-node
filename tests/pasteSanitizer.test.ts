// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { htmlToRuns, plainTextToRuns, sanitizeHtml } from "../src/ui/pasteSanitizer";
import { runsToPlain } from "../src/core/text";

describe("sanitizeHtml — Word / Google Docs emphasis via CSS", () => {
  it("converts span font-weight:700 to <strong>", () => {
    const out = sanitizeHtml(`<span style="font-weight: 700">bold</span>`);
    expect(out).toContain("<strong>bold</strong>");
    expect(out).not.toContain("font-weight");
  });

  it("converts span font-style:italic to <em>", () => {
    const out = sanitizeHtml(`<span style="font-style: italic">slanted</span>`);
    expect(out).toContain("<em>slanted</em>");
    expect(out).not.toContain("font-style");
  });

  it("keeps both bold and italic on the same text", () => {
    const out = sanitizeHtml(`<span style="font-weight: bold; font-style: italic">combo</span>`);
    expect(out).toContain("<em>");
    expect(out).toContain("<strong>");
    expect(out).toContain("combo");
  });

  it("recognizes numeric bold weights >= 600 and ignores light weights", () => {
    expect(sanitizeHtml(`<span style="font-weight: 700">x</span>`)).toContain("<strong>x</strong>");
    expect(sanitizeHtml(`<span style="font-weight: 400">x</span>`)).not.toContain("<strong>");
  });
});

describe("sanitizeHtml — Word lists (MsoListParagraph / margin-left)", () => {
  it("rebuilds a flat Word list as <ul><li>", () => {
    const out = sanitizeHtml(
      `<p class="MsoListParagraph" style="margin-left:36.0pt">First item</p>` +
        `<p class="MsoListParagraph" style="margin-left:36.0pt">Second item</p>`
    );
    expect(out).toContain("<ul>");
    const lis = out.match(/<li>/g) ?? [];
    expect(lis.length).toBe(2);
    expect(out).toContain("First item");
    expect(out).toContain("Second item");
  });

  it("nests deeper-indented items as sub-lists", () => {
    const out = sanitizeHtml(
      `<p class="MsoListParagraph" style="margin-left:36.0pt">Parent</p>` +
        `<p class="MsoListParagraph" style="margin-left:72.0pt">Child</p>` +
        `<p class="MsoListParagraph" style="margin-left:36.0pt">Next</p>`
    );
    expect(out).toContain("<ul>");
    // the child must live inside a nested <ul>, not as a flat sibling
    const childPos = out.indexOf("Child");
    const parentUlEnd = out.indexOf("</ul>");
    expect(childPos).toBeGreaterThan(-1);
    expect(childPos).toBeLessThan(parentUlEnd);
  });

  it("detects mso-list attributes too", () => {
    const out = sanitizeHtml(`<p mso-list="l1 level1 lfo1">Item</p>`);
    expect(out).toContain("<li>");
    expect(out).toContain("Item");
  });
});

describe("sanitizeHtml — web pages and Draw.io", () => {
  it("keeps semantic strong/em/u and lists from clean HTML", () => {
    const out = sanitizeHtml(`<p><strong>bold</strong> <em>ital</em> <u>under</u></p><ul><li>one</li><li>two</li></ul>`);
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>ital</em>");
    expect(out).toContain("<u>under</u>");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>one</li>");
  });

  it("drops scripts, images, links and junk styles", () => {
    const out = sanitizeHtml(`<script>alert(1)</script><a href="https://evil.example">link text</a><img src="x.png"><p style="color: red; margin: 40px">text</p>`);
    expect(out).not.toContain("script");
    expect(out).not.toContain("href");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("margin");
    expect(out).toContain("link text");
    expect(out).toContain("text");
  });

  it("handles Draw.io inline span styles (font-weight on span inside p)", () => {
    const out = sanitizeHtml(`<p><span style="font-weight: bold; font-family: Arial;">draw io bold</span></p>`);
    expect(out).toContain("<strong>draw io bold</strong>");
    expect(out).not.toContain("font-family");
  });
});

describe("sanitizeHtml — colors", () => {
  it("keeps hex and rgb colors as data-rnode-color spans", () => {
    const hex = sanitizeHtml(`<span style="color: #ff0000">red</span>`);
    expect(hex).toContain('data-rnode-color="#ff0000"');
    const rgb = sanitizeHtml(`<span style="color: rgb(0, 128, 255)">blue</span>`);
    expect(rgb).toContain('data-rnode-color="#0080ff"');
  });
});

describe("htmlToRuns — clean HTML → TextRun[]", () => {
  it("maps strong/em/u to run flags", () => {
    const runs = htmlToRuns(`<p><strong>B</strong><em>I</em><u>U</u> plain</p>`);
    const find = (s: string) => runs.find((r) => r.text.includes(s))!;
    expect(find("B").bold).toBe(true);
    expect(find("I").italic).toBe(true);
    expect(find("U").underline).toBe(true);
    expect(find("plain").bold ?? false).toBe(false);
  });

  it("reads data-rnode-color markers into run colors", () => {
    const runs = htmlToRuns(`<p><span data-rnode-color="#ff0000">red text</span></p>`);
    const run = runs.find((r) => r.text.includes("red text"));
    expect(run?.color).toBe("#ff0000");
  });

  it("marks nested list items with listIndent instead of literal spaces", () => {
    const runs = htmlToRuns(`<ul><li>one<ul><li>one.one</li></ul></li></ul>`);
    const one = runs.find((r) => r.text.includes("one"))!;
    const nested = runs.find((r) => r.text.includes("one.one"))!;
    expect(one.listIndent).toBe(1);
    expect(nested.listIndent).toBe(2);
    // no literal space-indentation in the text anymore — the renderer draws
    // the bullet glyph and hanging indent from listIndent
    expect(one.text).toBe("one");
    expect(nested.text).toBe("one.one");
  });

  it("preserves heading levels as per-run font sizes", () => {
    const runs = htmlToRuns(`<h2>Big header</h2><p>Body text</p>`);
    const head = runs.find((r) => r.text.includes("Big header"))!;
    const body = runs.find((r) => r.text.includes("Body text"))!;
    expect(head.fontSize).toBe(21);
    expect(body.fontSize ?? 14).toBe(14);
    // block boundary → paragraph gap on the following block
    expect(runs.filter((r) => r.paraGap).length).toBeGreaterThan(0);
  });

  it("keeps h1-h6 tags in sanitized HTML (headings are not flattened to p)", () => {
    const out = sanitizeHtml(`<h2>Heading</h2><p>Body</p>`);
    expect(out).toContain("<h2>Heading</h2>");
    expect(out).toContain("<p>Body</p>");
  });

  it("separates consecutive paragraphs with a paragraph gap", () => {
    const runs = htmlToRuns(`<p>First paragraph.</p><p>Second paragraph.</p>`);
    const plain = runsToPlain(runs);
    expect(plain).toContain("\n"); // line break between blocks
    expect(runs.some((r) => r.paraGap)).toBe(true); // plus extra spacing
  });

  it("round-trips bold from a sanitized Word fragment", () => {
    const html = sanitizeHtml(`<span style="font-weight:700">bolded</span>`);
    const runs = htmlToRuns(html);
    const run = runs.find((r) => r.text.includes("bolded"));
    expect(run?.bold).toBe(true);
  });
});

describe("plainTextToRuns — list markers from plain text", () => {
  it("turns a flat list into runs with listIndent 1 and no marker left in the text", () => {
    const runs = plainTextToRuns("- first point\n* second point\n• third point\n– fourth");
    const items = runs.filter((r) => r.listIndent !== undefined);
    expect(items.length).toBe(4);
    for (const r of items) {
      expect(r.listIndent).toBe(1);
      expect(r.text).not.toMatch(/[-*•–]/);
    }
    expect(items.map((r) => r.text)).toEqual(["first point", "second point", "third point", "fourth"]);
  });

  it("maps two-space and tab indentation to listIndent 2 on the nested item", () => {
    const runs = plainTextToRuns("- parent\n  - child\n\t- tabbed");
    const items = runs.filter((r) => r.listIndent !== undefined);
    expect(items.map((r) => [r.text, r.listIndent])).toEqual([
      ["parent", 1],
      ["child", 2],
      ["tabbed", 2],
    ]);
  });

  it("recognizes numbered markers (1. and 2))", () => {
    const runs = plainTextToRuns("1. first\n2) second");
    const items = runs.filter((r) => r.listIndent !== undefined);
    expect(items.map((r) => [r.text, r.listIndent])).toEqual([
      ["first", 1],
      ["second", 1],
    ]);
  });

  it("keeps a plain paragraph a paragraph when mixed with a list", () => {
    const runs = plainTextToRuns("plain paragraph\n- item");
    const para = runs.find((r) => r.text.includes("plain paragraph"))!;
    expect(para.listIndent).toBeUndefined();
    const item = runs.find((r) => r.text.includes("item"))!;
    expect(item.listIndent).toBe(1);
    // the list is a separate block: paraGap lands on its first run
    expect(item.paraGap).toBe(true);
  });

  it("leaves **bold** as literal characters — no Markdown parsing", () => {
    const runs = plainTextToRuns("**bold** stays");
    expect(runs).toEqual([{ text: "**bold** stays" }]);
    expect(runs[0].listIndent).toBeUndefined();
  });

  it("does not emit an empty list item for a blank line", () => {
    const runs = plainTextToRuns("- one\n\n- two");
    expect(runs.some((r) => r.text === "")).toBe(false);
    const items = runs.filter((r) => r.listIndent !== undefined);
    expect(items.map((r) => r.text)).toEqual(["one", "two"]);
    expect(items.every((r) => r.listIndent === 1)).toBe(true);
  });
});
