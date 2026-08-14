/**
 * Gate for the "Concept Map" section of CLAUDE.md.
 *
 * The map is a claim about where things live. A rename or a moved file turns it
 * into a confident lie that an agent will trust over the filesystem, so every
 * path it mentions is verified here instead of by hand.
 *
 * Usage: npm run check:map
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = resolve(ROOT, "CLAUDE.md");
const SECTION = "## Concept Map";

/** A backticked token counts as a path only if it has a directory separator. */
const PATH_LIKE = /^[\w.@-]+(?:\/[\w.@-]+)+\/?$/;

const source = await readFile(DOC, "utf8");
const start = source.indexOf(SECTION);
if (start === -1) {
  console.error(`FAIL: no "${SECTION}" section in CLAUDE.md`);
  process.exit(1);
}
const rest = source.slice(start + SECTION.length);
const end = rest.indexOf("\n## ");
const section = end === -1 ? rest : rest.slice(0, end);

const paths = [...new Set([...section.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((t) => PATH_LIKE.test(t)))];

if (paths.length === 0) {
  console.error("FAIL: the Concept Map section mentions no paths — did the format change?");
  process.exit(1);
}

const stale = paths.filter((p) => !existsSync(resolve(ROOT, p)));

for (const p of stale) console.error(`STALE: ${p}`);

if (stale.length > 0) {
  console.error(`\n${stale.length}/${paths.length} paths in the Concept Map no longer exist.`);
  console.error("Update the section in CLAUDE.md — an agent trusts it over the filesystem.");
  process.exit(1);
}

console.log(`Concept Map OK — ${paths.length} paths verified.`);
