# LANE F — Persistence, assets, images, platform bridge (`src/persist/*`, `src/editor/imageImport*`, `src/editor/externalImage.ts`, `src-tauri/src/lib.rs`)

Audit scope: `src/persist/assets.ts`, `src/persist/storage.ts`,
`src/editor/imageImport.ts`, `src/editor/imageImport.worker.ts`,
`src/editor/externalImage.ts`, `src-tauri/src/lib.rs`. `exportBridge.ts`
(Lane E), `core/types.ts` (Lane A1), `store.ts` (Lane A2), `ui/imageDrop.ts`
(Lane C) are outside the boundary — findings landing there are marked
CROSS-BOUNDARY.

**I11 is load-bearing and untouched by everything below:** `putUnderId`
breaking `id === sha256(original)` is reachable only through the compact
`.rnode.zip` importer, and those assets carry `AttachmentInfo.originalLost`.
None of the proposed changes derive, default, or collapse `originalLost`, and
the two `put` implementations in this lane still compute the id from the
original bytes. No autosave is proposed (its absence is a product decision).

---

## 1. THE finding for this lane: the worker reply is a loose `{ ok: boolean; result?; error? }` — a union the handler guards by hand (imageImport.ts:64-67)

The main-thread side of the import pipeline types the worker reply as three
independent optional fields:

```ts
// imageImport.ts:65
const data = e.data as { ok: boolean; result?: ImportedImage; error?: string };
worker.terminate();
if (data.ok && data.result) resolve(data.result);          // line 67
else reject(new Error(data.error ?? "image import failed"));
```The worker only ever posts two of the four shapes this type permits:
`{ ok: true, result }` (worker:85) and `{ ok: false, error }` (worker:110). The type therefore permits the two **contradictory** shapes `{ ok: true,
error: "..." }` and `{ ok: false, result: {...} }` — and the handler's
`data.ok && data.result` + `data.error ?? "fallback"` is precisely the
runtime guard that exists only because the type is too loose.

**Honest reachability note (the brief's second question):** the
request/response *pairing* is safe by construction — the worker is created
per import and terminated after its first reply, so an unmatched or
duplicated reply is structurally impossible. The weakness is the *shape*, not
the protocol. The fix is one typed union at both ends (both files are mine):

```ts
// shared by worker and main thread
type ImportReply = { ok: true; result: ImportedImage } | { ok: false; error: string };
// worker: scope.postMessage(reply); main: const data = e.data as ImportReply;
// handler: if (data.ok) resolve(data.result); else reject(new Error(data.error));
```

The `&& data.result` / `?? "image import failed"` guards disappear; a
contradictory message stops compiling instead of being tolerated.

**The broader Q1 answer, stated honestly:** the image journey in *my* files is
**not** a boolean/nullable status matrix. Every stage is a return type:
`validateImageSource` → `{ ok: true } | { ok: false; reason }`;
`importImageFile` → resolves `ImportedImage` (complete data, `AssetBlob.blob`
mandatory) or rejects; `AssetStore.get` → `Blob | null` (null = absent, and
`AssetBlob` cannot be "loaded with no bytes"); fetch → `File | null`; the
missing-original state is the single I11 flag on the card. No contradictory
state is representable in this lane's files. The renderer (Lane C,
`src/render/renderer.ts`) does carry `imageCache`/`inflight`/`imageFailed`
maps — that is where an image-status union would bite, and it is outside my
boundary (see CROSS-BOUNDARY).

## 2. Backend errors are undiscriminable `String`s; the frontend regex-guesses a kind the backend never sends (storage.ts:63-72, lib.rs read_document)

Every Rust command returns `Result<T, String>` — a *shared* shape, but a
string is not a discriminable error type. The frontend reacts by parsing the
message:

```ts
// storage.ts:67-69 — classifyTauriReadError
if (/not a database|malformed|file is encrypted/i.test(lower)) kind = "corrupt";
else if (/permission|denied|access/i.test(lower)) kind = "permission";
else if (/no such file|unable to open database file/i.test(lower)) kind = "not-found";
else kind = "sqlite";
```

Two concrete problems, both verifiable in code:

- **The `corrupt` branch is effectively dead, and the "corrupt" kind is
  unreachable from the app.** `read_document` (lib.rs:261-286) maps
  `ErrorCode::NotADatabase` to `Ok(None)` itself — a garbage `.rnode` file
  surfaces as the *benign* None, and the Rust test
  `read_of_a_non_database_file_is_none` pins exactly that. So a corrupt file
  reaches the store as "Not a valid R-node document in that file", never as
  `DocumentLoadErrorKind.corrupt` — the kind exists, is labeled
  ("the file is corrupt…"), and the backend never produces it.
- The backend *already distinguishes* these cases (it matches `NotADatabase`
  in two places, and `open_readable` fails differently for permission vs.
  missing file) but throws the distinction away into a `String` for the
  frontend to re-derive by regex.

**Fix (both sides mine):** return a structured error — e.g. serialize
`{ kind: "not-found" | "permission" | "corrupt" | "sqlite", message: String }`
from the Rust commands (Tauri v2 passes a `String` err as the rejection
message, so the frontend `JSON.parse`s it with a fallback for older builds),
and populate `DocumentLoadErrorKind` from the backend's own judgment. Keep the
deliberate `None`-for-garbage **open** flow (treating an arbitrary picked file
as "not a document" is a defensible UX) — but the classification that exists
today should come from the side that has the facts, not from regex over a
message.

## 3. The StorageAdapter abstraction leaks: ~14 platform branches in the consumer (storage.ts:11-17, main.tsx:14, store.ts)

The interface is `{ label; load(): Promise<RnodeDocument[]>; save(docs):
Promise<RnodeDocument[]> }` — web-shaped. The desktop adapter's real contract
(`hasRoot`, `currentPath`, `setRoot`, `readDocumentAt`, file picker, rename,
exists) is class-specific, so consumers branch on the concrete class and on
`window.__TAURI__` instead of the interface. Counted sites in store.ts:
`instanceof TauriStorageAdapter` at 414, 427, 443, 572, 648, 728, 759, 1020
plus direct `window.__TAURI__`/`invoke` at 731, 736, 794, 799 — ~14 places,
including two whole save flows (`performSave` branches into a desktop-only
`saveAsDesktop`/`syncFileNameToTitle` path at 572). `main.tsx:14` picks the
adapter once by platform, which is the right pattern — but every consumer
after that re-discovers the platform.

The same leak has a **data-model** face (Q5): the interface pretends the
document is an array everywhere, but the two backends differ. Web persists a
multi-doc array in localStorage; desktop persists exactly one document per
`.rnode` file — `load()` returns `[doc]` or `[]`, and `save()` writes only
`docs[0]` (storage.ts:244-246). The store's `state.docs` multi-doc sidebar is
a web-ism the desktop never exercises; callers must know the difference
(branching again) rather than the interface expressing it.

**What is NOT a leak — stated as a SKIP per the brief:** the *asset* side is
genuinely one model with two backends. `AssetStore` (put/get/meta/size/
delete/list) is backend-agnostic, `getAssetStore()` (assets.ts:412-418)
selects once, and the renderer/store/RichEditor consume it without branching.
The web (IndexedDB) vs. desktop (SQLite rows inside the `.rnode` file)
difference for **images** is fully contained. The document side is the leak,
not the asset side.

**Fix:** grow the interface with the file operations the desktop actually
performs (`pickFile`, `renameFile`, `fileExists`, `readDocumentAt`, `root`),
with the web adapter either not implementing them or the interface split into
a base + a desktop capability the store narrows to in one place — so the 14
consumer branches collapse to one platform check. CROSS-BOUNDARY: the 14
sites and the two desktop save flows live in store.ts (Lane A2); my part is
the interface shape and the adapter implementations.

## 4. Memoized rejected promises are permanent failures (assets.ts:133, 255)

Two `??=`-memoized promises in the asset stores:

```ts
// assets.ts:133 (IndexedDbAssetStore)
private db(): Promise<IDBDatabase> { this.dbPromise ??= openDb(this.dbName); return this.dbPromise; }
// assets.ts:255 (TauriAssetStore)
this.defaultPath ??= this.invoke()("default_document_path") as Promise<string>;
```

`openDb` explicitly rejects on a blocked upgrade (assets.ts:123-126 — the
deliberate "never hang" choice), and `currentPath()` rejects on an IPC
failure. With `??=`, **the first rejection is the last**: every subsequent
call awaits the same rejected promise, so a single transient failure (a
momentarily blocked IndexedDB upgrade; one failed IPC round-trip before the
first save) disables the store for the whole session. The IndexedDB case has
no reset path at all — `dbPromise` is only ever cleared by a reload. The
Tauri case self-heals only because `setRoot()` happens to clear
`defaultPath`.

**Fix (one line each):** clear the memo on rejection so the next call retries —
`.catch((e) => { this.dbPromise = null; throw e; })` around `openDb`, and the
same for `defaultPath`.

## 5. Minor: two inconsistent failure channels, and a twin-metadata card (same lane)

- **`fetchImageAsFile` collapses five failure modes into `null`**
  (externalImage.ts:52-75: network/CORS, `!res.ok`, oversize-announced,
  blob read, non-image, oversize-actual) while its sibling
  `validateImageSource` returns `{ ok: true } | { ok: false; reason }`
  (imageImport.ts:35-37). Two failure channels in the same lane with
  different shapes; the caller (CanvasView:1293) can't tell "unreachable"
  from "not an image". Align on the reason-bearing union — the pattern
  already exists in this lane.
- **Desktop `putUnderId` is four autocommitted statements vs. the web's one
  IndexedDB transaction** (assets.ts:299-311). A crash between level writes
  leaves a partial asset (meta without levels, or levels without meta) that
  the web backend cannot produce. It is tolerated today — `adoptFile`
  skips-and-counts partial assets, `get()` per-level returns null — but the
  two backends genuinely differ in write atomicity. Wrapping the four
  `put_asset` calls in one SQLite transaction (the `write_document` pattern
  already in lib.rs) removes the difference.
- **`AssetMeta` and `AttachmentInfo` are twin cards** (assets.ts:34-42 vs.
  core/types.ts `AttachmentInfo`) — same id/mime/w/h/bytes/name, one in the
  store, one in the document, synced by convention (`attachImage` pushes the
  card from the same `ImportedImage.meta` that `put` stored). A divergence is
  representable and unvalidated. Not a headline — both are written together
  today — but the `alt`/`originalLost` fields exist on only one of the two,
  which is exactly how the twin shape will drift next. If they must stay two,
  a dev-only equality check (the `validateSheet` pattern) would pin them.

---

## Invariants and SKIPs

- **I11 respected:** the two `put` implementations still derive
  `id = sha256(original)`; `putUnderId` remains the documented exception used
  by the importer; `originalLost` is untouched by every finding here.
- **SKIP — asset model:** one model (three levels + meta, content-addressed)
  with two clean backends; `getAssetStore()` picks once; no consumer branches
  on the asset backend. This is the genuinely contained half.
- **SKIP — worker pairing:** one worker per import, terminated after one
  reply; no unmatched/duplicated reply possible. Only the reply *type* is
  loose (finding 1).
- **SKIP — Rust correctness:** commands share `Result<T, String>`, `put_asset`
  is `INSERT OR IGNORE` matching the first-write-wins contract, `write_document`
  is a single transaction, no WAL is documented and tested (single-file-at-rest
  test), and the Rust test suite covers round trips, first-write-wins,
  missing-file-none, and non-database-none.

## Findings summary (ranked)

1. Worker reply is `{ ok: boolean; result?; error? }` — contradictory shapes
   are representable and guarded by hand; a discriminated union removes the
   guards (both ends in my files).
2. Backend errors are strings; the frontend regex-guesses a `kind` the
   backend never sends (`corrupt` is unreachable, pinned by a Rust test) —
   return a structured `{ kind, message }` from Rust.
3. StorageAdapter is web-shaped; the desktop contract leaks through ~14
   `instanceof`/`__TAURI__` branches in the store, and the multi-doc array
   contract hides a real single-doc-per-file difference on desktop.
   (Asset side: clean — SKIP.)
4. Memoized rejected promises (`dbPromise`, `defaultPath`) make a single
   transient failure permanent; clear-on-reject.
5. Minor: `fetchImageAsFile`'s null failure channel vs. the lane's own
   reason-bearing union; desktop `putUnderId` write atomicity; the
   AssetMeta/AttachmentInfo twin cards.

## CROSS-BOUNDARY

- The ~14 platform branches and the two desktop save flows live in store.ts
  (Lane A2) — finding 3's fix needs that file even though the interface is
  mine.
- The image-status union the brief anticipated (referenced / fetching /
  decoded / stored / failed) would land in `src/render/renderer.ts`
  (`imageCache` / `inflight` / `imageFailed` maps — Lane C), not in this
  lane; my files deliberately have no such state.
- The `AttachmentInfo` half of the twin card is core/types.ts (Lane A1);
  only the `AssetMeta` half and the sync points are mine.
