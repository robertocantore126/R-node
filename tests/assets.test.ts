import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  IndexedDbAssetStore,
  collectOrphans,
  sha256Hex,
  type AssetBlob,
  type AssetLevel,
  type AssetMeta,
} from "../src/persist/assets";
import { DEFAULT_STRUCTURE, type MindNode, type Sheet } from "../src/core/types";

function blob(text: string, mime = "image/png"): Blob {
  return new Blob([text], { type: mime });
}

/** The three levels for one asset. Dimensions are arbitrary but consistent. */
function makeLevels(originalText = "ORIGINAL-IMAGE-BYTES"): Record<AssetLevel, AssetBlob> {
  return {
    original: { blob: blob(originalText), w: 1200, h: 800 },
    large: { blob: blob("LARGE-1024"), w: 1024, h: 683 },
    small: { blob: blob("SMALL-256"), w: 256, h: 171 },
  };
}

function meta(overrides: Partial<Omit<AssetMeta, "id">> = {}): Omit<AssetMeta, "id"> {
  return { mime: "image/png", w: 1200, h: 800, bytes: 21, ...overrides };
}

let dbCounter = 0;
/** Each test gets its own in-memory database: no teardown races. */
function uniqueDb(): string {
  dbCounter += 1;
  return `rnode-assets-test-${dbCounter}`;
}

function nodeWithImage(id: string, imageId: string): MindNode {
  return {
    id,
    type: "subtopic",
    parentId: "root",
    childrenIds: [],
    title: "Node",
    titleRuns: [{ text: "Node" }],
    position: { x: 0, y: 0, manual: false },
    style: { image: imageId },
    collapsed: false,
    labels: [],
    markers: [],
    notes: "",
    task: null,
    metadata: { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  };
}

function makeSheet(overrides: Partial<Sheet> = {}): Sheet {
  return {
    sheetId: "s1",
    title: "Test",
    structure: DEFAULT_STRUCTURE,
    rootNodeId: "root",
    nodes: {},
    relationships: [],
    boundaries: [],
    summaries: [],
    callouts: [],
    labels: [],
    zones: [],
    attachments: [],
    comments: [],
    presentation: {},
    ...overrides,
  };
}

describe("IndexedDbAssetStore", () => {
  it("addresses by content: the id is the SHA-256 of the original bytes", async () => {
    const store = new IndexedDbAssetStore(uniqueDb());
    const id = await store.put(makeLevels("DUPLICATE-CHECK"), meta());
    expect(id).toBe(await sha256Hex(new TextEncoder().encode("DUPLICATE-CHECK")));
  });

  it("put twice with the same content returns the same id and does not duplicate", async () => {
    const store = new IndexedDbAssetStore(uniqueDb());
    const id1 = await store.put(makeLevels(), meta({ name: "first.png" }));
    const id2 = await store.put(makeLevels(), meta({ name: "second.png" }));

    expect(id2).toBe(id1);
    // One record in the store, not two.
    expect(await store.list()).toEqual([id1]);
    // The existing data was not touched: the first write's name survives.
    expect((await store.meta(id1))?.name).toBe("first.png");
  });

  it("returns each of the three levels with their own bytes", async () => {
    const store = new IndexedDbAssetStore(uniqueDb());
    const id = await store.put(makeLevels(), meta());

    const original = await store.get(id, "original");
    const large = await store.get(id, "large");
    const small = await store.get(id, "small");

    expect(await original?.text()).toBe("ORIGINAL-IMAGE-BYTES");
    expect(await large?.text()).toBe("LARGE-1024");
    expect(await small?.text()).toBe("SMALL-256");
  });

  it("returns null (not an exception) for an unknown id", async () => {
    const store = new IndexedDbAssetStore(uniqueDb());
    await store.put(makeLevels(), meta());

    expect(await store.get("deadbeef", "original")).toBeNull();
    expect(await store.get("deadbeef", "small")).toBeNull();
    expect(await store.meta("deadbeef")).toBeNull();
  });

  it("meta exposes the original's dimensions and weight", async () => {
    const store = new IndexedDbAssetStore(uniqueDb());
    const id = await store.put(
      makeLevels(),
      meta({ mime: "image/jpeg", name: "photo.jpg" }),
    );

    expect(await store.meta(id)).toEqual({
      id,
      mime: "image/jpeg",
      w: 1200,
      h: 800,
      bytes: 21,
      name: "photo.jpg",
    });
  });

  it("delete removes the asset and list stops reporting it", async () => {
    const store = new IndexedDbAssetStore(uniqueDb());
    const keepId = await store.put(makeLevels("KEEP"), meta());
    const dropId = await store.put(makeLevels("DROP"), meta());

    await store.delete(dropId);

    expect(await store.list()).toEqual([keepId]);
    expect(await store.get(dropId, "original")).toBeNull();
    expect(await store.meta(dropId)).toBeNull();
    // The sibling asset is untouched.
    expect(await store.get(keepId, "original")).not.toBeNull();
  });
});

describe("collectOrphans", () => {
  it("finds only ids no node references any more, and deletes nothing", async () => {
    const store = new IndexedDbAssetStore(uniqueDb());
    const viaNode = await store.put(makeLevels("VIA-NODE"), meta());
    const viaList = await store.put(makeLevels("VIA-LIST"), meta());
    const orphan = await store.put(makeLevels("ORPHAN"), meta());

    const sheet = makeSheet({
      // One channel: the sheet's attachment list.
      attachments: [
        {
          id: viaList,
          mime: "image/png",
          w: 1200,
          h: 800,
          displayW: 1024,
          displayH: 683,
          bytes: 9,
          name: "via-list.png",
        },
      ],
      // The other channel: a node's Style.image.
      nodes: { n1: nodeWithImage("n1", viaNode) },
    });

    const orphans = await collectOrphans(sheet, store);

    expect(orphans).toEqual([orphan]);

    // Nothing was deleted: all three assets are still listed and readable.
    expect((await store.list()).sort()).toEqual([viaNode, viaList, orphan].sort());
    expect(await store.get(orphan, "original")).not.toBeNull();
    expect(await store.get(viaNode, "original")).not.toBeNull();
    expect(await store.get(viaList, "original")).not.toBeNull();
  });

  it("returns an empty list when every stored id is referenced", async () => {
    const store = new IndexedDbAssetStore(uniqueDb());
    const id = await store.put(makeLevels(), meta());

    const sheet = makeSheet({ nodes: { n1: nodeWithImage("n1", id) } });
    expect(await collectOrphans(sheet, store)).toEqual([]);
  });
});
