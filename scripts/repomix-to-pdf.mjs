/**
 * Convert repomix-output.xml into a printable HTML document.
 *
 * Usage: node scripts/repomix-to-pdf.mjs [input.xml] [output.html]
 * Then print the HTML to PDF with a headless browser, e.g.:
 *   chrome --headless=new --disable-gpu --no-pdf-header-footer \
 *     --print-to-pdf=repomix-output.pdf repomix-output.html
 */
import { readFileSync, writeFileSync } from "node:fs";

const input = process.argv[2] ?? "repomix-output.xml";
const output = process.argv[3] ?? "repomix-output.html";

const src = readFileSync(input, "utf8");
const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Summary: everything before the first <file path="..."> entry.
const firstFile = src.indexOf('<file path="');
const summary = firstFile > 0 ? src.slice(0, firstFile) : "";

// File entries: <file path="..."> ... </file> (content is raw text).
const files = [];
const re = /<file path="([^"]+)">([\s\S]*?)<\/file>/g;
let m;
while ((m = re.exec(src))) files.push({ path: m[1], content: m[2] });

const toc = files.map((f, i) => `<li><a href="#f${i}">${esc(f.path)}</a></li>`).join("\n");
const body = files
  .map(
    (f, i) =>
      `<h2 id="f${i}">${i + 1}. ${esc(f.path)}</h2>\n<pre>${esc(f.content)}</pre>`
  )
  .join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>R-node — Repomix</title>
<style>
  body { font-family: "Segoe UI", Arial, sans-serif; margin: 24px; font-size: 10px; color: #1a1a1a; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .meta { color: #666; margin-bottom: 16px; }
  .summary { white-space: pre-wrap; background: #f5f5f5; border: 1px solid #ddd; padding: 12px; font-family: Consolas, monospace; font-size: 9px; }
  h2 { font-size: 12px; margin: 24px 0 6px; border-bottom: 1px solid #ccc; padding-bottom: 3px; page-break-after: avoid; }
  pre { white-space: pre-wrap; word-break: break-word; background: #fafafa; border: 1px solid #eee; padding: 10px; font-family: Consolas, "Courier New", monospace; font-size: 8px; line-height: 1.4; }
  ul.toc { columns: 2; font-size: 9px; }
  a { color: #0645ad; text-decoration: none; }
</style>
</head>
<body>
<h1>R-node — Repository dump (Repomix)</h1>
<div class="meta">${files.length} file(s) — generated ${new Date().toISOString()}</div>
${summary ? `<h2>Summary</h2>\n<pre class="summary">${esc(summary)}</pre>` : ""}
<h2>Index</h2>
<ul class="toc">${toc}</ul>
${body}
</body>
</html>
`;

writeFileSync(output, html, "utf8");
console.log(`Wrote ${output}: ${files.length} files, ${(html.length / 1024 / 1024).toFixed(1)} MB`);
