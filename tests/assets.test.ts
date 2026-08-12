import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IndexedDbAssetStore,
  collectOrphans,
  getAssetStore,
  referencedAssetIds,
  sha256Hex,
  type AssetBlob,
  type AssetLevel,
  type AssetMeta,
} from "../src/persist/assets";
import { DEFAULT_STRUCTURE, type MindNode, type Sheet } from "../src/core/types";

afterEach(() => {
  vi.restoreAllMocks();
});

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

function attachmentCard(id: string, name: string): Sheet["attachments"][number] {
  return { id, mime: "image/png", w: 1200, h: 800, bytes: 9, name };
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

  it("size is the exact sum of every stored level (levels + meta row)", async () => {
    const store = new IndexedDbAssetStore(uniqueDb());
    const id = await store.put(makeLevels(), meta());
    const fullMeta = (await store.meta(id))!;
    const expected =
      new TextEncoder().encode("ORIGINAL-IMAGE-BYTES").length +
      new TextEncoder().encode("LARGE-1024").length +
      new TextEncoder().encode("SMALL-256").length +
      new TextEncoder().encode(JSON.stringify(fullMeta)).length;
    expect(await store.size(id)).toBe(expected);
    // An unknown id weighs zero, not an error.
    expect(await store.size("deadbeef")).toBe(0);
  });

  it("putUnderId stores levels under a caller-supplied id and is idempotent", async () => {
    const store = new IndexedDbAssetStore(uniqueDb());
    // The .rnode.zip importer case: no original to re-derive the address from.
    const foreignId = "a".repeat(64);
    const full: AssetMeta = { id: foreignId, mime: "image/png", w: 1200, h: 800, bytes: 21, name: "first.png" };
    await store.putUnderId(foreignId, makeLevels(), full);
    expect(await store.get(foreignId, "large")).not.toBeNull();
    expect((await store.meta(foreignId))?.id).toBe(foreignId);

    // First write wins: re-importing the same zip must not overwrite.
    await store.putUnderId(foreignId, makeLevels("OTHER"), { ...full, name: "second.png" });
    expect(await store.get(foreignId, "original")).not.toBeNull();
    expect((await store.meta(foreignId))?.name).toBe("first.png");
    expect((await store.list()).length).toBe(1);
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

  it("F3 — concurrent puts of the same content are atomic: one record, first wins", async () => {
    const store = new IndexedDbAssetStore(uniqueDb());

    // Release both digest calls at the same instant so the two puts race
    // through their existence checks instead of serializing. Without the
    // single-transaction put, both checks pass and the second write wins.
    let release: () => void = () => {};
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    let pending = 0;
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(
      async (...args: Parameters<SubtleCrypto["digest"]>) => {
        const out = await realDigest(...args);
        pending += 1;
        if (pending === 2) release();
        await barrier;
        return out;
      },
    );

    const [id1, id2] = await Promise.all([
      store.put(makeLevels(), meta({ name: "first.png" })),
      store.put(makeLevels(), meta({ name: "second.png" })),
    ]);

    expect(id2).toBe(id1);
    // One record, not two; the first writer's metadata survives.
    expect(await store.list()).toEqual([id1]);
    expect((await store.meta(id1))?.name).toBe("first.png");
  });
});

describe("referencedAssetIds", () => {
  it("roots are the nodes only: an unattached attachment card is not a root", () => {
    const sheet = makeSheet({
      attachments: [attachmentCard("card-only", "card.png")],
      nodes: { n1: nodeWithImage("n1", "via-node") },
    });

    expect(referencedAssetIds(sheet)).toEqual(new Set(["via-node"]));
  });
});

describe("collectOrphans", () => {
  it("F1 — reports orphan cards and orphan blobs, and deletes nothing", async () => {
    const store = new IndexedDbAssetStore(uniqueDb());
    const viaNode = await store.put(makeLevels("VIA-NODE"), meta());
    const cardOnly = await store.put(makeLevels("CARD-ONLY"), meta());
    const blobOnly = await store.put(makeLevels("BLOB-ONLY"), meta());

    const sheet = makeSheet({
      // A card for B with no node behind it: garbage itself, not a root.
      attachments: [attachmentCard(cardOnly, "card.png")],
      // A node that references A.
      nodes: { n1: nodeWithImage("n1", viaNode) },
    });

    const report = await collectOrphans(sheet, store);

    // The orphaned card is reported as a card and as a blob (nothing in the
    // store references it either); C is a blob-only orphan.
    expect(report.cards).toEqual([cardOnly]);
    expect(report.blobs).toContain(cardOnly);
    expect(report.blobs).toContain(blobOnly);
    expect(report.blobs).not.toContain(viaNode);

    // Nothing was deleted: all three assets are still listed and readable.
    expect((await store.list()).sort()).toEqual([viaNode, cardOnly, blobOnly].sort());
    expect(await store.get(viaNode, "original")).not.toBeNull();
    expect(await store.get(cardOnly, "original")).not.toBeNull();
    expect(await store.get(blobOnly, "original")).not.toBeNull();
  });

  it("returns empty cards and blobs when every stored id is referenced", async () => {
    const store = new IndexedDbAssetStore(uniqueDb());
    const id = await store.put(makeLevels(), meta());

    const sheet = makeSheet({ nodes: { n1: nodeWithImage("n1", id) } });
    expect(await collectOrphans(sheet, store)).toEqual({ cards: [], blobs: [] });
  });
});

describe("getAssetStore", () => {
  it("returns the same singleton instance every call", () => {
    const a = getAssetStore();
    const b = getAssetStore();
    expect(a).toBe(b);
  });

  it("picks IndexedDB when no Tauri global is present (the node test env)", () => {
    expect(getAssetStore()).toBeInstanceOf(IndexedDbAssetStore);
  });
});
