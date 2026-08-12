import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { IndexedDbAssetStore, sha256Hex, type AssetMeta } from "../src/persist/assets";
import { buildRnodeZip, estimateRnodeZip, importRnodeZip, type LevelGenerator } from "../src/editor/exportBridge";
import type { MindNode, RnodeDocument, Sheet } from "../src/core/types";

let dbCounter = 0;
function uniqueDb(): string {
  return `assets-test-${++dbCounter}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Incompressible payload (true random, not a periodic pattern): deflate must
 * not shrink it, or the size estimate would overstate the produced file.
 */
function pngishBytes(_seed: number, size: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  crypto.getRandomValues(out);
  return out;
}

/** Node test seam: node has no canvas, so levels are the source as-is. */
const fakeGenerate: LevelGenerator = async (blob: Blob, _mime: string) => ({
  original: { blob, w: 64, h: 48 },
  large: { blob, w: 64, h: 48 },
  small: { blob, w: 64, h: 48 },
});

function makeDoc(imageId?: string): RnodeDocument {
  const nodes: Record<string, MindNode> = {
    root: {
      id: "root",
      type: "main",
      parentId: null,
      childrenIds: imageId ? ["child"] : [],
      title: "Root",
      titleRuns: [{ text: "Root" }],
      position: { x: 0, y: 0, manual: false },
      style: {},
      collapsed: false,
      labels: [],
      markers: [],
      notes: "",
      task: null,
      metadata: { createdAt: "t", updatedAt: "t" },
    },
  };
  const sheet: Sheet = {
    sheetId: "s1",
    title: "Map 1",
    structure: {
      structureType: "mindmap",
      orientation: "horizontal",
      spacing: 180,
      branchSpacing: 14,
      padding: 18,
      compactMode: false,
      autoBalance: true,
      freePositioningBranches: false,
      allowManualPositioning: true,
      connectorStyle: "curved",
    },
    rootNodeId: "root",
    nodes,
    relationships: [],
    boundaries: [],
    summaries: [],
    callouts: [],
    labels: [],
    zones: [],
    attachments: imageId
      ? [{ id: imageId, mime: "image/png", w: 64, h: 48, bytes: 4096, name: "img.png" }]
      : [],
    comments: [],
    presentation: {},
  };
  return {
    schemaVersion: "1",
    documentId: "doc-1",
    title: "Test map",
    createdAt: "t",
    updatedAt: "t",
    archived: false,
    pinned: false,
    settings: { theme: "light", showOutliner: false, showInspector: true },
    themeId: "r-node-light",
    sheets: [sheet],
  };
}

/** A doc whose root node references `imageId` (with the card). */
function makeDocWithImage(imageId: string): RnodeDocument {
  const doc = makeDoc(imageId);
  const root = doc.sheets[0].nodes.root;
  root.childrenIds = ["child"];
  root.style.image = imageId;
  doc.sheets[0].nodes.child = {
    id: "child",
    type: "subtopic",
    parentId: "root",
    childrenIds: [],
    title: "Child",
    titleRuns: [{ text: "Child" }],
    position: { x: 0, y: 0, manual: false },
    style: {},
    collapsed: false,
    labels: [],
    markers: [],
    notes: "",
    task: null,
    metadata: { createdAt: "t", updatedAt: "t" },
  };
  return doc;
}

async function putTestAsset(store: IndexedDbAssetStore): Promise<string> {
  // Distinct sizes per level: complete export carries the 8KB original,
  // compact the 4KB display level — the ratio is what the mode tests assert.
  const original = pngishBytes(42, 8192);
  const large = pngishBytes(43, 4096);
  const small = pngishBytes(44, 1024);
  const meta: Omit<AssetMeta, "id"> = { mime: "image/png", w: 64, h: 48, bytes: original.length, name: "img.png" };
  return store.put(
    {
      original: { blob: new Blob([original], { type: "image/png" }), w: 64, h: 48 },
      large: { blob: new Blob([large], { type: "image/png" }), w: 32, h: 24 },
      small: { blob: new Blob([small], { type: "image/png" }), w: 16, h: 12 },
    },
    meta
  );
}

describe(".rnode.zip export", () => {
  it("contains document.json, manifest.json and one entry per referenced asset", async () => {
    const store = new IndexedDbAssetStore(uniqueDb());
    const id = await putTestAsset(store);
    const doc = makeDocWithImage(id);

    const bytes = await buildRnodeZip(doc, doc.sheets[0], store, "complete");
    const files = unzipSync(bytes);

    expect(Object.keys(files)).toContain("document.json");
    expect(Object.keys(files)).toContain("manifest.json");
    const assetNames = Object.keys(files).filter((n) => n.startsWith("assets/"));
    expect(assetNames).toEqual([`assets/${id}.png`]);

    // The document inside is byte-identical to today's .rnode.json.
    expect(JSON.parse(strFromU8(files["document.json"]))).toEqual(doc);
    expect(JSON.parse(strFromU8(files["manifest.json"]))).toEqual({ mode: "complete" });
  });

  it("skips assets the nodes do not reference", async () => {
    const store = new IndexedDbAssetStore(uniqueDb());
    await putTestAsset(store); // stored, but no node references it
    const doc = makeDoc(); // no image at all

    const files = unzipSync(await buildRnodeZip(doc, doc.sheets[0], store, "complete"));
    expect(Object.keys(files).filter((n) => n.startsWith("assets/"))).toEqual([]);
  });

  it("estimates the size within 10% of the produced file", async () => {
    const store = new IndexedDbAssetStore(uniqueDb());
    const id = await putTestAsset(store);
    const doc = makeDocWithImage(id);

    const estimate = await estimateRnodeZip(doc, doc.sheets[0], store, "complete");
    const produced = (await buildRnodeZip(doc, doc.sheets[0], store, "complete")).length;

    expect(Math.abs(estimate - produced) / produced).toBeLessThan(0.1);
  });

  it("compact mode stores only the display level, not the original", async () => {
    const store = new IndexedDbAssetStore(uniqueDb());
    const id = await putTestAsset(store);
    const doc = makeDocWithImage(id);
    const sheet = doc.sheets[0];

    const originalBlob = await store.get(id, "original");
    const completeBytes = await buildRnodeZip(doc, sheet, store, "complete");
    const compactBytes = await buildRnodeZip(doc, sheet, store, "compact");

    // Same entries in both, but compact carries the 4KB display level, not
    // the 8KB original.
    const cFiles = unzipSync(completeBytes);
    const pFiles = unzipSync(compactBytes);
    expect(Object.keys(cFiles)).toEqual(Object.keys(pFiles));
    expect(pFiles[`assets/${id}.png`].length).toBeLessThan(cFiles[`assets/${id}.png`].length);
    expect(JSON.parse(strFromU8(pFiles["manifest.json"]))).toEqual({ mode: "compact" });
    expect(originalBlob).not.toBeNull();
  });
});

describe(".rnode.zip import", () => {
  it("round-trips into a fresh store: export, wipe, import restores the asset under the same id", async () => {
    const source = new IndexedDbAssetStore(uniqueDb());
    const id = await putTestAsset(source);
    const doc = makeDocWithImage(id);
    const zip = await buildRnodeZip(doc, doc.sheets[0], source, "complete");

    // A clean profile: a brand-new store with nothing in it.
    const fresh = new IndexedDbAssetStore(uniqueDb());
    expect(await fresh.list()).toEqual([]);

    const imported = await importRnodeZip(zip, fresh, fakeGenerate);
    expect(imported).toEqual(doc);
    expect(await fresh.list()).toEqual([id]);
    expect(await fresh.get(id, "large")).not.toBeNull();
    expect(await fresh.get(id, "small")).not.toBeNull();
    const meta = await fresh.meta(id);
    expect(meta?.mime).toBe("image/png");
  });

  it("reimporting the same file does not duplicate anything", async () => {
    const source = new IndexedDbAssetStore(uniqueDb());
    const id = await putTestAsset(source);
    const doc = makeDocWithImage(id);
    const zip = await buildRnodeZip(doc, doc.sheets[0], source, "complete");

    const fresh = new IndexedDbAssetStore(uniqueDb());
    await importRnodeZip(zip, fresh, fakeGenerate);
    await importRnodeZip(zip, fresh, fakeGenerate);

    expect(await fresh.list()).toEqual([id]);
  });

  it("compact import regenerates the display levels under the document id", async () => {
    const source = new IndexedDbAssetStore(uniqueDb());
    const id = await putTestAsset(source);
    const doc = makeDocWithImage(id);
    const zip = await buildRnodeZip(doc, doc.sheets[0], source, "compact");

    const fresh = new IndexedDbAssetStore(uniqueDb());
    const imported = await importRnodeZip(zip, fresh, fakeGenerate);

    // The document keeps its original id (content address of the original,
    // which compact did not carry) — and the store serves it under that id.
    expect(imported).not.toBeNull();
    expect(await fresh.list()).toEqual([id]);
    expect(await fresh.get(id, "large")).not.toBeNull();
    expect(await fresh.get(id, "small")).not.toBeNull();
  });

  it("compact import marks the asset cards as originalLost", async () => {
    const source = new IndexedDbAssetStore(uniqueDb());
    const id = await putTestAsset(source);
    const doc = makeDocWithImage(id);
    const zip = await buildRnodeZip(doc, doc.sheets[0], source, "compact");

    const fresh = new IndexedDbAssetStore(uniqueDb());
    const imported = (await importRnodeZip(zip, fresh, fakeGenerate))!;
    expect(imported.sheets[0].attachments.find((a) => a.id === id)?.originalLost).toBe(true);
  });

  it("complete import leaves the cards unmarked", async () => {
    const source = new IndexedDbAssetStore(uniqueDb());
    const id = await putTestAsset(source);
    const doc = makeDocWithImage(id);
    const zip = await buildRnodeZip(doc, doc.sheets[0], source, "complete");

    const fresh = new IndexedDbAssetStore(uniqueDb());
    const imported = (await importRnodeZip(zip, fresh, fakeGenerate))!;
    expect(imported.sheets[0].attachments.find((a) => a.id === id)?.originalLost).toBeUndefined();
  });

  it("a complete export of a compact-imported doc flags degraded in the manifest", async () => {
    const source = new IndexedDbAssetStore(uniqueDb());
    const id = await putTestAsset(source);
    const doc = makeDocWithImage(id);
    const compactZip = await buildRnodeZip(doc, doc.sheets[0], source, "compact");

    const fresh = new IndexedDbAssetStore(uniqueDb());
    const imported = (await importRnodeZip(compactZip, fresh, fakeGenerate))!;

    // Store serves the display level under the same id, and the complete
    // export of the degraded document says so in its manifest.
    const completeZip = await buildRnodeZip(imported, imported.sheets[0], fresh, "complete");
    const manifest = JSON.parse(strFromU8(unzipSync(completeZip)["manifest.json"]));
    expect(manifest).toEqual({ mode: "complete", degraded: true });

    // A fresh complete export of the same doc (no degradation) stays clean.
    const cleanZip = await buildRnodeZip(doc, doc.sheets[0], source, "complete");
    expect(JSON.parse(strFromU8(unzipSync(cleanZip)["manifest.json"]))).toEqual({ mode: "complete" });
  });

  it("returns null for a corrupt container", async () => {
    const store = new IndexedDbAssetStore(uniqueDb());
    expect(await importRnodeZip(new Uint8Array([1, 2, 3]), store, fakeGenerate)).toBeNull();
    expect(await importRnodeZip(new Uint8Array(), store, fakeGenerate)).toBeNull();
  });

  it("stores the payload under the SHA-256 of the original bytes", async () => {
    // The document's references survive the round-trip by construction: the
    // id inside the zip equals the hash of the bytes that get stored.
    const bytes = pngishBytes(7, 2048);
    const id = await sha256Hex(bytes);
    expect(id).toMatch(/^[0-9a-f]{64}$/);

    const blob = new Blob([bytes], { type: "image/png" });
    const store = new IndexedDbAssetStore(uniqueDb());
    await store.putUnderId(
      id,
      { original: { blob, w: 64, h: 48 }, large: { blob, w: 64, h: 48 }, small: { blob, w: 64, h: 48 } },
      { id, mime: "image/png", w: 64, h: 48, bytes: bytes.length }
    );
    expect(await store.get(id, "original")).not.toBeNull();
  });
});
