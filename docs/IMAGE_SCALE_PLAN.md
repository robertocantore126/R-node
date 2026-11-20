# Image scale plan — thousands of images per map (browser first)

Goal: a map with **thousands of images** stays smooth to pan, zoom and edit in
the **web build**, and a picture can be viewed far larger than 1024 px.

**Invariant for every step: what the user sees does not change.** Same picture
at every zoom, same layout, same exports. Only the work behind the pixels
changes. A step that would change the look is out of scope or marked as such.

No benchmark step: each change below removes a cost that the code shows exists.
Steps are ordered by value / effort; each one stands alone and can be merged on
its own.

**Status (branch `feat/image-scale`, 2026-11-20):** steps 1–7 and 11 are in.
Step 8 (WebP display levels) is in for new imports. Step 9 is in only as
"derive nearby buckets from a cached larger bitmap"; the device-local 4096 px
WebP cache was dropped (it showed a re-encoded copy instead of the original
and was never cleaned). Step 10 (OPFS `.rnode`) was dropped: it could write a
`.rnode` without its images and leaked OPFS files. In its place the web build
now keeps **one document open at a time** (`src/persist/library.ts`): the other
maps are IndexedDB library entries, loaded only when opened.

---

## Where we are (2026-11-20)

| Stage | Today | Where |
|---|---|---|
| Import | one **new Worker per file**, files imported **one after another**; the worker decodes the **full original** (`createImageBitmap(blob)`), then draws 1024/256 px levels; levels are PNG for alpha sources, JPEG q0.85 otherwise | `src/editor/imageImport.ts` `importImageFile`, `imageImport.worker.ts`, `store.ts` `importToCard` |
| Storage (web) | IndexedDB, one record per asset with all three levels; **one transaction per `get`** | `src/persist/assets.ts` |
| Decode | `paintSlot` asks for a bucket; `startDecode` reads the blob and `createImageBitmap(blob, {resizeWidth})`; **max 5 in flight**, first come first served | `src/render/renderer.ts` `imageDecodeSize`, `paintSlot`, `startDecode` |
| Cache | decoded bitmaps, **pure LRU, 128 MB fixed**; smallest bucket **128 px** even for a 20 px thumbnail | `renderer.ts` `IMAGE_BUDGET`, `IMAGE_BUCKET_MIN`, `evictToBudget` |
| Paint | per visible image per frame: `positionedImageSlots` + `drawImage`; nothing drawn until the exact bucket is decoded | `renderer.ts` `drawNode` → `drawImage` → `paintSlot` |
| Save/open (web `.rnode`) | sql.js: the **whole file in WASM memory**; save copies every level of every asset into it, then `db.export()` copies it again; open copies every asset into IndexedDB | `src/persist/rnodeFile.ts` |

What breaks first with thousands of images:

1. **Zoomed out** — 2,000 visible thumbnails × 128 px buckets ≈ 2,000 × 49 KB =
   98 MB, plus anything bigger: the cache is at its 128 MB limit, pure LRU
   evicts bitmaps that are **still on screen**, they decode again next frame,
   evict others → decode churn (livelock), images blinking in and out.
2. **Zooming / panning** — every new bucket means an empty slot until decoded,
   5 decodes at a time, each with its own IndexedDB transaction; decodes for
   images that already left the screen still run (closed on arrival).
3. **Importing many** — N workers spawned in sequence, each decoding a full
   12–50 MP original (50–200 MB) just to make 1024 px.
4. **Saving / opening** — peak memory ≈ 2× the file size in the tab; a file of
   a few GB cannot be saved or opened at all on the web.

---

## Step 1 — Small buckets for small images  *(renderer, tiny)*

- `IMAGE_BUCKET_MIN` 128 → **32**. A picture 20 px on screen decodes at 32 px
  instead of 128: **16× less memory** per zoomed-out thumbnail. The bucket is
  still ≥ the device pixels needed, so the picture looks the same.
- Keep powers of two below 1024 (cache keys stay few).

Done when: zoomed-out maps hold all visible thumbnails in a fraction of the
budget; no visual difference at any zoom.

## Step 2 — Never evict what is on screen  *(renderer, small)*

- Track the cache keys **drawn this frame** (`frameKeys: Set<string>`, filled in
  `paintSlot` on hit, cleared at frame start).
- `evictToBudget` evicts **off-screen keys first** (LRU among them), and never a
  key in `frameKeys`. If on-screen bitmaps alone exceed the budget, allow a
  temporary overshoot up to a hard ceiling (2× budget) instead of churning.
- Budget from the machine: `navigator.deviceMemory` (Chrome/Edge; GB, capped at
  8) → `clamp(deviceMemory × 48 MB, 128 MB, 512 MB)`; 128 MB when unknown.
- When an image node leaves the screen, its larger buckets become the first to
  go (they are the expensive ones).

Done when: panning back and forth over a dense area never re-decodes what
stayed visible; no blinking at the budget edge.

## Step 3 — Draw the nearest cached size while the exact one decodes  *(renderer, small)*

- On a cache miss in `paintSlot`, before returning empty: look up another
  bucket of the **same image** already in the cache (the next larger, else the
  next smaller) and draw it scaled into the same rect; then request the exact
  bucket as today.
- Index buckets per image (`imageBuckets: Map<imageId, Set<number>>`) so the
  lookup is O(buckets), not a cache scan.

The final pixels are the same as today; the difference is that a zoom never
shows empty slots, only a short soft-to-sharp step (as Photoshop / maps do).

Done when: zooming in or out over many images shows no empty frames.

## Step 4 — A decode queue with priorities, not first-come  *(renderer, medium)*

- `paintSlot` no longer starts decodes; it **enqueues** `{key, imageId, level,
  bucket, priority}` (deduplicated). Priority = on-screen area, boosted near the
  view centre; a missing bucket with **no fallback** (step 3) beats a sharpening
  one.
- After the frame: start the top N. N by bucket: up to **8** small (≤ 256 px)
  decodes, **2** large/original ones — big decodes no longer block the
  thumbnails.
- **Check visibility before reading the blob**, not after decoding: drop queue
  entries whose node left the screen. Keep the after-decode check too.
- Bucket changes mid-zoom: entries for a bucket the image no longer needs are
  dropped before they start.

Done when: after a zoom-out the centre fills first, and no decode runs for an
image that is off screen when its turn comes.

## Step 5 — Batched asset reads  *(persist, small)*

- `AssetStore.getMany(ids: string[], level): Promise<Map<string, Blob>>` — one
  IndexedDB transaction for a batch (web backend); the desktop backend loops
  `get` (or one Rust command later).
- The decode queue (step 4) pulls its next batch of blobs with one `getMany`
  per level, then decodes them.
- `meta()` lookups used per image (`pdfImageSource`, size) get the same batch
  form.

Done when: a zoom-out that needs 500 thumbnails opens a handful of
transactions, not 500.

## Step 6 — Per-frame CPU around images  *(renderer, medium)*

- `visibleImageNodes` is rebuilt every frame by filtering **all** placed nodes:
  build it inside the placement cache (`computePlacement`), where visibility is
  already computed, and reuse it until placement changes.
- `positionedImageSlots` runs per image per frame (and inside hit tests):
  memoise it on the `Placed` object (key: node style identity + box size).
- `hitTestImageSlot` scans **every placed node** in z-order on pointerdown:
  restrict it to `p.visible` nodes whose box contains the point (cheap box test
  first, slots only for the hit), the same for `hitTestGalleryCell`.
- Draw images with `imageSmoothingQuality = "low"` when the bitmap is at most
  1.25× the drawn size (no visible change: the bitmap is already the right
  size; "high" only matters when the canvas scales a lot).

Done when: frame cost of a pan no longer grows with the number of images
outside the view.

## Step 7 — Import that scales  *(import, medium)*

- **Worker pool** (2 workers, 4 if `hardwareConcurrency ≥ 8`) created once and
  reused, instead of `new Worker` per file.
- Multi-file drop / paste imports **in parallel** through the pool, then
  creates all items in **one undoable batch**; a progress toast ("Importing 37
  of 200…") with cancel.
- In the worker, make each level **straight from the blob**:
  `createImageBitmap(blob, {resizeWidth: 1024})` and `{resizeWidth: 256}`
  (aspect kept by the browser). The full-size original is no longer decoded,
  only hashed — a 50 MP photo stops costing 200 MB per import. Width/height of
  the original come from a header probe (`ImageDecoder` where available, else
  one full decode as today).
- The content hash stays SHA-256 of the original bytes (dedupe unchanged).

Done when: dropping 200 photos keeps the UI responsive and finishes in
parallel; memory stays flat during the import.

## Step 8 — Smaller, faster display levels  *(import, small — new files only)*

- Encode the 1024 / 256 px levels as **WebP** (quality 0.9, keeps alpha)
  instead of PNG for alpha sources: typically 3–10× smaller than PNG, faster to
  read from IndexedDB and to decode. JPEG sources: WebP 0.9 as well.
- Old assets keep their PNG/JPEG levels; nothing is re-encoded. The `.rnode`
  schema stores bytes per level, so desktop and web both read either.
- Not for the original: it stays the user's bytes, untouched.

*Look:* the display levels change encoder; at q0.9 the difference is not
visible at the sizes they are drawn, and every view larger than 1024 px
already decodes from the original. Mark as optional if strict byte-identity of
levels matters.

## Step 9 — Deep zoom without decoding huge originals each time  *(renderer, medium)*

Today (since 2026-11-20) a picture drawn wider than 1024 px decodes from the
original, up to 8 MP. For a 50 MP original every such decode reads and decodes
the whole file.

- Keep the decoded original-derived bitmap for an image **as long as any of its
  buckets ≥ 1448 is on screen** (step 2 already protects it), and **derive
  nearby buckets by downscaling that bitmap** (`createImageBitmap(bitmap,
  {resizeWidth})`) instead of decoding the file again.
- Optional later: a lazily built 4096 px level per image, stored in IndexedDB
  only on this device (not in the file), made the first time a picture is shown
  above 2048 px.

Done when: zooming in and out on one big picture decodes its file once.

## Step 10 — Save and open heavy files without holding them in memory  *(persist, large)*

The web `.rnode` path is whole-file: peak ≈ 2× file size in the tab, and wasm32
cannot hold a multi-GB SQLite database.

- Move the web `.rnode` engine from sql.js (in-memory) to the official
  **SQLite WASM build with the OPFS VFS** (`opfs-sahpool`): the database lives
  in the Origin Private File System, pages go to disk, memory stays flat.
- **Save**: keep one OPFS database per open document; a save updates only the
  rows that changed (document JSON + new assets; deleted assets dropped), then
  **streams** the OPFS file to the user's file (`createWritable()` +
  `pipeTo`). No whole-file buffer.
- **Open**: stream the picked file into OPFS, open it there, and read assets
  **on demand** from it (an `AssetStore` backend over the OPFS DB) instead of
  copying every asset into IndexedDB at open.
- Same schema byte-for-byte with `src-tauri` (unchanged), so files still move
  between web and desktop.
- Fallback: browsers without OPFS keep today's sql.js path.

Done when: a multi-GB map opens and saves in the browser with memory well
under the file size, and Ctrl+S after one edit writes in time proportional to
the change plus one streamed copy.

## Step 11 — Keep the browser from dropping the images  *(persist, tiny)*

- Call `navigator.storage.persist()` the first time a document gets images
  (the browser may evict non-persistent IndexedDB/OPFS under pressure).
- Show used / available (`navigator.storage.estimate()`) in the document
  settings, and warn before an import that would not fit.

---

## Order and dependencies

```
1 ─┐
2 ─┼─ 3 ── 4 ── 5        (render path; 1–3 are the quick wins)
6 ─┘
7 ── 8                   (import)
9                        (after 2: needs the protected cache)
10 ── 11                 (persist; independent, largest)
```

Suggested sequence: **1, 2, 3** (one short PR, biggest effect on zoom-out),
then **4 + 5**, **6**, **7**, **9**, **10 + 11**; **8** whenever the format
change is agreed.

## Out of scope here

- Tiling (only the visible part of a giant image at full detail): needed only
  for very large single images (100+ MP) viewed at 1:1; revisit after step 9.
- A GPU (WebGL/WebGPU) image layer: the right move if per-frame `drawImage`
  over thousands of visible images becomes the limit after steps 1–6.
- Changing what is drawn when zoomed out (e.g. replacing tiny thumbnails with
  placeholders): excluded by the invariant.
