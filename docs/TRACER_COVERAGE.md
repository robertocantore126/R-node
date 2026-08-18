# Tracer 2.0 — the TRACE COVERAGE CONTRACT

The tracer (`src/dev/trace.ts`) records what the app **does**, at every
subsystem boundary. Tracer 1.0 recorded decisions ("this input was dropped,
and here is why"); tracer 2.0 also records the **crossings** — every time an
event moves from one subsystem to the next, a capture can show the chain:

```
UI (click) → Command (op) → State (mutated) → Persistence → Rust → Filesystem
```

and, crucially, where the chain **stops**. That is the point of the contract
below: if a capture is missing events for an area, that area either was never
exercised in the session, or (worse) a boundary that should fire never fires —
the "Persistence: NO EVENT" shape.

## Reading a capture

`trace.capture()` (written to `.trace/latest.json` by the dev server, or
downloaded with Ctrl+Shift+D / the ⏺ button) now carries three extra sections
besides `events` and `counts`:

### `coverage` — the contract, live

Every `area:item` pair of the contract below with `observed: true` when at
least one event matched it during the session, plus the event that last
observed it. `covered`/`total` is the scoreboard.

### `transitions` — the boundary matrix

Counts of every `subsystem→subsystem` crossing, e.g. `"ui->cmd": 12`,
`"cmd->state": 9`. A chain that should continue but does not shows up as a
**missing transition**. The DELETE_NODE example:

```json
"transitions": {
  "ui->cmd": 1,
  "cmd->state": 1
}
```

There is no `state->persist` row: the mutation never reached storage.

### `gaps.stateToPersist` — the "Persistence: NO EVENT" detector

Derived from the event stream at capture time: how many commands/state
mutations happened **since the last persist event**, plus what the last
mutation and the last persist were. A value of `0` means every change reached
storage; `> 0` means some did not — exactly the

```
UI says:      DELETE_NODE
Command:      DELETE_NODE
State:        node removed
Persistence:  NO EVENT
```

shape, with the count telling you how many changes went unpersisted.

## The contract

Every item lists the `what`-prefixes that count as observing it. Matches are
prefix-based: `what === prefix` or `what.startsWith(prefix + ":")`.

### UI (`ui`)

| Item | Observed by |
|---|---|
| click | `ui:click` (auto listener on DOM controls; canvas clicks are skipped — the pointer path traces them precisely) |
| keyboard shortcut | `ui:shortcut` — one mark per dispatched action in `shortcuts.ts` |
| pointer interaction | `pointerdown:*`, `pointermove`, `pointerup`, `dblclick`, `wheel` (the existing `trace.applied/ignored` gestures) |
| drag/drop | `ui:drag-drop` (auto) + the drop/image handlers |
| selection | `ui:selection` (store `select`/`selectMany`/`clearSelection`/`selectImage`) |
| focus/blur | `ui:focus-blur` (auto listener) |
| modal open/close | `ui:modal` (palette toggle) |
| context menu | `ui:context-menu` (auto listener) |
| input/change | `edit:commit` (rich-text commits) + `ui:input-change` |
| undo/redo | `ui:undo-redo` (store `undo`/`redo`) |

### STATE (`state`)

| Item | Observed by |
|---|---|
| state creation | `state:created` — derived from `create*` op types in `execOps` |
| state mutation | `state:mutated` — any other op batch |
| state deletion | `state:deleted` — derived from `delete*` op types |
| derived state | `state:derived` / `layout:*` — the layout is derived data |
| state synchronization | `state:sync` — `dirty` on every `touch()`, `saved` after a save |
| transaction start/end | `state:transaction` — the heavy-operation lifecycle (`beginLongOp`/`endLongOp`) |

### DATA (`data`)

| Item | Observed by |
|---|---|
| IndexedDB read | `data:idb-read` — **automatic**: `IDBObjectStore.prototype.get/getAll/getAllKeys` are patched in dev |
| IndexedDB write | `data:idb-write` — automatic: `put`/`add` |
| IndexedDB delete | `data:idb-delete` — automatic: `delete` |
| serialization | `data:serialize` — doc saves, JSON/zip exports |
| deserialization | `data:deserialize` — doc loads, imports |
| migration | `data:migrate` — the legacy `r-mind` key migration |
| import | `data:import` — `importDocumentFromJson` |
| export | `data:export` — JSON/zip exports |

### FILES (`files`)

| Item | Observed by |
|---|---|
| open | `files:open` — desktop picker + web file input |
| read | `files:read` (reserved; desktop reads arrive as `rust:filesystem`) |
| write | `files:write` — portable saves via handle, picker, or download fallback |
| rename | `files:rename` — rename-on-save |
| delete | `files:delete` (reserved; deletions go through Rust) |
| failure | `files:failure` — e.g. a rename that collided |

### RENDERING (`render`)

| Item | Observed by |
|---|---|
| render start/end | `render:frame` — the aggregated per-frame counters |
| image decode | `render:image-decode` — every decode start/success/failure with level, bucket, bytes, ms |
| texture creation | `render:text-cache` — text bitmap insertion |
| texture destruction | `render:cache-evict` — evicted bitmaps |
| cache insertion | `render:text-cache` / `render:image-cache` |
| cache eviction | `render:cache-evict` — both caches, with freed bytes |
| GPU resource allocation | `render:gpu-alloc` — canvas backing-store (re)allocation on resize |
| GPU resource free | `render:gpu-free` — closed `ImageBitmap`s |

### LAYOUT (`layout`)

| Item | Observed by |
|---|---|
| start | `layout:run` / `layout:start` |
| end | `layout:run` / `layout:end` |
| invalidation | `layout:invalidate` — every `scheduleLayout` |
| node calculation | `layout:node-calc` — nodes measured per run |
| constraint resolution | `layout:constraint` — force/manual-position handling |
| failure | `layout:failure` — a thrown layout is traced and rethrown |

### ASYNC (`async`)

| Item | Observed by |
|---|---|
| promise start/end | `async:promise` — saves (start + done) |
| worker start/end | `async:worker` — **never observed: the app has no workers.** An honest gap |
| cancellation | `async:cancel` — long-op cancel, AbortError paths |
| timeout | `async:timeout` — the layout debounce |
| race-sensitive operation | `async:race` — currently unobserved |

### ERRORS (`err`)

| Item | Observed by |
|---|---|
| exception | `error` — the window error listener |
| rejected promise | `err:rejection` / `error` — the unhandled-rejection listener |
| failed operation | `error` — every `trace.error` call site |
| recovery | `err:recovery` — init falling back to the sample map |
| fallback | `err:fallback` — portable save falling back to a download |

### RUST/TAURI (`rust`)

| Item | Observed by |
|---|---|
| command invocation | `rust:invoke` — **automatic**: `window.__TAURI__.core.invoke` is wrapped in dev |
| command result | `rust:result` |
| command error | `rust:error` |
| filesystem operation | `rust:filesystem` — fs commands (`read/write/rename/remove_document`, asset commands) tagged separately |
| IPC | any `rust:*` event |

IPC argument payloads are summarized: byte buffers become `[N bytes]`, long
strings are truncated — a 1 MB image is never dumped into the trace.

## The three layers

1. **Explicit** — `trace.mark(sub, what, detail)` / `trace.span(sub, what)`
   called at the boundaries (store, renderer, layout, persistence adapters,
   shortcuts).
2. **Automatic** — the Tauri invoke wrapper, the IndexedDB prototype patch and
   the DOM listeners installed by `installTrace()` in dev. They see every IPC
   call, every object-store op and every focus/context/drag/click without the
   call sites knowing.
3. **Derived** — the `transitions` matrix and `gaps.stateToPersist`, computed
   from the event stream at capture time.

`trace.coverage()` and the `coverage` capture section are the same data;
`window.__rnodeTrace.coverage()` in the console.

## Cost

Everything is guarded by one boolean: production builds never reach the
instrumentation (`enabled` is false), the automatic patches are installed only
by `installTrace()` in dev, and they uninstall cleanly on teardown.
