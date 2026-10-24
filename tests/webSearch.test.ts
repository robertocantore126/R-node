/**
 * Web search: each source's answer turned into WebItems (canned responses,
 * no network), and a result dropped into a chart box or onto empty canvas.
 */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { clipDetails, resolveWebItem, searchWeb, type WebItem } from "../src/editor/webSearch";
import { EditorStore } from "../src/editor/store";
import { chartSlotNote } from "../src/core/chartNotes";
import type { AttachmentInfo } from "../src/core/types";
import type { StorageAdapter } from "../src/persist/storage";

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const image = (): Response => new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), { status: 200 });

/** A fetcher answering by URL substring; records what was asked. */
function fake(routes: Record<string, () => Response>): { fetch: (url: string) => Promise<Response>; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetch: async (url: string) => {
      asked.push(url);
      const hit = Object.keys(routes).find((k) => url.includes(k));
      if (!hit) throw new Error(`unexpected fetch ${url}`);
      return routes[hit]();
    },
  };
}

describe("searchWeb", () => {
  it("reads iTunes albums with a large cover and the facts", async () => {
    const f = fake({
      "itunes.apple.com/search": () => json({ results: [{ collectionName: "OK Computer", artistName: "Radiohead", artworkUrl100: "https://is1.mzstatic.com/a/100x100bb.jpg", releaseDate: "1997-05-21T07:00:00Z", primaryGenreName: "Alternative", trackCount: 12 }] }),
    });
    const [r] = await searchWeb("albums", "ok computer", "it", f.fetch, "");
    expect(f.asked[0]).toContain("entity=album");
    expect(f.asked[0]).toContain("country=IT");
    expect(r.title).toBe("OK Computer");
    expect(r.caption).toBe("Radiohead - OK Computer");
    expect(r.subtitle).toBe("Radiohead");
    expect(r.imageUrl).toBe("https://is1.mzstatic.com/a/600x600bb.jpg");
    expect(r.details).toBe("Radiohead\n1997 · Alternative · 12 tracks");
  });

  it("searches Last.fm with the user's key, and fetches tags and tracks on drop", async () => {
    const f = fake({
      "method=album.search": () => json({ results: { albummatches: { album: [
        { name: "OK Computer", artist: "Radiohead", url: "https://www.last.fm/music/Radiohead/OK+Computer", image: [{ "#text": "https://lastfm.freetls.fastly.net/i/u/34s/abc.png", size: "small" }, { "#text": "https://lastfm.freetls.fastly.net/i/u/300x300/abc.png", size: "extralarge" }] },
        { name: "Bootleg", artist: "Nobody", image: [{ "#text": "https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png" }] },
      ] } } }),
      "method=album.getinfo": () => json({ album: { tags: { tag: [{ name: "alternative" }, { name: "rock" }] }, tracks: { track: [{}, {}, {}] }, wiki: { summary: 'A classic. <a href="https://www.last.fm/x">Read more on Last.fm</a>' } } }),
    });
    const [a, b] = await searchWeb("albums", "ok computer", "en", f.fetch, "KEY");
    expect(f.asked[0]).toContain("ws.audioscrobbler.com");
    expect(f.asked[0]).toContain("api_key=KEY");
    expect(a.caption).toBe("Radiohead - OK Computer");
    expect(a.imageUrl).toBe("https://lastfm.freetls.fastly.net/i/u/600x600/abc.png");
    // Last.fm's grey star is "no cover", not a picture.
    expect(b.imageUrl).toBeUndefined();
    const full = await resolveWebItem(a, f.fetch, "KEY");
    expect(full.details).toBe("Radiohead\nalternative, rock · 3 tracks\nA classic.");
  });

  it("says when Last.fm refuses the key", async () => {
    const f = fake({ "audioscrobbler": () => new Response(JSON.stringify({ error: 10, message: "Invalid API key" }), { status: 403 }) });
    await expect(searchWeb("albums", "x", "en", f.fetch, "BAD")).rejects.toThrow(/refused the API key/);
  });

  it("reads Open Library books, with no picture when there is no cover", async () => {
    const f = fake({ "openlibrary.org/search.json": () => json({ docs: [{ title: "Dune", author_name: ["Frank Herbert"], first_publish_year: 1965, cover_i: 42 }, { title: "No cover" }] }) });
    const [a, b] = await searchWeb("books", "dune", "en", f.fetch);
    expect(a.imageUrl).toBe("https://covers.openlibrary.org/b/id/42-L.jpg");
    expect(a.subtitle).toBe("Frank Herbert · 1965");
    expect(b.imageUrl).toBeUndefined();
  });

  it("searches the chosen Wikipedia and fetches the summary on drop", async () => {
    const f = fake({
      "it.wikipedia.org/w/rest.php": () => json({ pages: [{ key: "Colosseo", title: "Colosseo", description: "anfiteatro", thumbnail: { url: "//upload.wikimedia.org/x/60px-C.jpg" } }] }),
      "page/summary/Colosseo": () => json({ extract: "Il Colosseo è un anfiteatro.", originalimage: { source: "https://upload.wikimedia.org/big.jpg", width: 4000 }, thumbnail: { source: "https://upload.wikimedia.org/x/320px-C.jpg" } }),
    });
    const [r] = await searchWeb("wikipedia", "colosseo", "it", f.fetch);
    expect(r.thumbUrl).toBe("https://upload.wikimedia.org/x/60px-C.jpg");
    const full = await resolveWebItem(r, f.fetch);
    expect(full.details).toBe("Il Colosseo è un anfiteatro.");
    // The 4000px original is too big; a 1280px rendition (a standard width).
    expect(full.imageUrl).toBe("https://upload.wikimedia.org/x/1280px-C.jpg");
  });

  it("finds films as Wikipedia pages carrying the film infobox", async () => {
    const f = fake({ "wikipedia.org/w/rest.php": () => json({ pages: [{ key: "Inception", title: "Inception", description: "film del 2010" }] }) });
    const [r] = await searchWeb("films", "inception", "it", f.fetch);
    expect(decodeURIComponent(f.asked[0])).toContain('inception hastemplate:"Film"');
    expect(r.source).toBe("films");
    expect(r.wiki).toEqual({ lang: "it", key: "Inception" });
    await searchWeb("films", "inception", "en", f.fetch);
    expect(decodeURIComponent(f.asked[1])).toContain('hastemplate:"Infobox film"');
  });

  it("does not call anything for an empty query", async () => {
    const f = fake({});
    expect(await searchWeb("films", "   ", "it", f.fetch)).toEqual([]);
    expect(f.asked).toEqual([]);
  });

  it("clips long text at a sentence end", () => {
    const text = `${"a".repeat(400)}. ${"b".repeat(400)}.`;
    expect(clipDetails(text, 600)).toBe(`${"a".repeat(400)}.`);
    expect(clipDetails("short")).toBe("short");
  });
});

const memoryAdapter: StorageAdapter = { label: "test", async load() { return []; }, async save() { /* no-op */ } };

function storeWithChart(): { store: EditorStore; chart: string } {
  const store = new EditorStore(memoryAdapter);
  store.createChartTopic(store.sheet.rootNodeId);
  const chart = store.getSnapshot().selection[0];
  (store as unknown as { importToCard: (f: File) => Promise<{ ok: true; card: AttachmentInfo }> }).importToCard = async (f) => ({
    ok: true,
    card: { id: `id:${f.name}`, mime: "image/jpeg", w: 600, h: 600, bytes: 3, name: f.name },
  });
  store.webFetch = fake({ "cover.jpg": image }).fetch;
  return { store, chart };
}

const album: WebItem = { source: "albums", title: "OK Computer", caption: "Radiohead - OK Computer", imageUrl: "https://x/cover.jpg", details: "Radiohead\n1997" };

describe("placeWebItem", () => {
  it("fills a chart box with picture, caption and a note, undone in one step", async () => {
    const { store, chart } = storeWithChart();
    expect((await store.placeWebItem(album, { kind: "chart", nodeId: chart, index: 2 })).ok).toBe(true);
    const item = store.doc.node(chart)!.style.gallery!.items[2];
    expect(item.id).toBe("id:Radiohead - OK Computer");
    expect(item.caption).toBe("Radiohead - OK Computer");
    expect(chartSlotNote(store.sheet, chart, 2)?.title).toBe("Radiohead\n1997");
    store.undo();
    expect(store.doc.node(chart)!.style.gallery!.items[2]).toEqual({ id: "" });
    expect(Object.values(store.sheet.nodes).some((n) => n.style.chartNote)).toBe(false);
  });

  it("keeps a note the box already has", async () => {
    const { store, chart } = storeWithChart();
    const noteId = store.addChartNote(chart, 0)!;
    store.setEditingDraft("Mine");
    store.commitEdit();
    await store.placeWebItem(album, { kind: "chart", nodeId: chart, index: 0 });
    expect(chartSlotNote(store.sheet, chart, 0)?.id).toBe(noteId);
    expect(store.doc.node(noteId)!.title).toBe("Mine");
  });

  it("makes a topic with picture and notes on empty canvas", async () => {
    const { store } = storeWithChart();
    const before = Object.keys(store.sheet.nodes).length;
    await store.placeWebItem({ ...album, url: "https://x/page" }, { kind: "canvas", x: 500, y: 300 });
    const id = store.getSnapshot().selection[0];
    const n = store.doc.node(id)!;
    expect(n.type).toBe("floating");
    expect(n.title).toBe("Radiohead - OK Computer");
    expect(n.style.image).toBe("id:Radiohead - OK Computer");
    expect(n.notes).toBe("Radiohead\n1997\n\nhttps://x/page");
    store.undo();
    expect(Object.keys(store.sheet.nodes).length).toBe(before);
  });

  it("refuses a box drop for a result with no picture", async () => {
    const { store, chart } = storeWithChart();
    const res = await store.placeWebItem({ source: "books", title: "No cover" }, { kind: "chart", nodeId: chart, index: 0 });
    expect(res.ok).toBe(false);
    expect(store.doc.node(chart)!.style.gallery!.items[0].id).toBe("");
  });
});
