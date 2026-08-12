# Piano di esecuzione — immagini nei nodi

Sequenza completa, dall'archivio degli asset fino al desktop e alla
condivisione. Pensata per essere consegnata **una volta** a un esecutore che
la percorre da solo.

Le specifiche di dettaglio stanno in [ROADMAP.md](ROADMAP.md); qui c'è
**l'ordine, i cancelli e le condizioni di arresto**. Le decisioni che stanno
sotto tutto sono in [ADR-001](ADR-001-immagini-e-piattaforma.md) §12.

---

## 1. Protocollo di esecuzione — leggere prima di iniziare

Questa è la parte che rende sicura una sequenza lunga. Senza, un errore al
passo 2 arriva mascherato al passo 6.

### Regole

1. **Un passo alla volta, nell'ordine della tabella.** Non anticipare, non
   accorpare, non "già che ci sono".
2. **Un commit per passo.** Messaggio in inglese all'imperativo che spiega il
   *perché*. Serve a poter isolare un guasto con `git bisect`.
3. **Dopo ogni passo, esegui il suo cancello.** Se non passa: **fermati**,
   non passare al successivo, e scrivi cosa non torna.
4. **Non disattivare test, non aggiungere `skip`, non alzare soglie** per far
   passare un cancello. Un cancello che fallisce è informazione, non un
   ostacolo da aggirare.
5. **Non modificare file fuori dalla lista del passo.** Se credi che serva,
   fermati e spiega perché.

### I cancelli

| Sigla | Cosa eseguire | Passa se |
|---|---|---|
| **G-tsc** | `npm run typecheck` | 0 errori |
| **G-test** | `npm test` | tutti verdi, nessuno saltato |
| **G-par** | `npm run dev`, poi `http://localhost:5173/dev/parity.html` | riporta **0 diverging / 16** |
| **G-mem** | vedi passo 11 | budget rispettato |

**G-par è obbligatorio** per ogni passo che tocca uno di questi file:
`src/layout/measure.ts`, la parte testo di `src/render/renderer.ts`,
`src/ui/lexicalRuns.ts`, le regole CSS `.topic-rich-*`,
`src/ui/RichEditor.tsx`.

`npm test` **non** copre la parità: l'harness gira in un browser vero perché
jsdom non implementa il layout. Vedi `AGENT_GUIDE.md` §3.

### Fermati e chiedi se

- un cancello fallisce e non capisci perché entro un tentativo ragionevole;
- serve una dipendenza non elencata nel passo;
- serve cambiare una costante condivisa (`LINE_HEIGHT_FACTOR`,
  `BLOCK_GAP_FACTOR`, `BULLET_WIDTH_EM`, `FONT_STACK`, `TEXT_INSET`);
- serve toccare `wrapRunLines`;
- la parità non torna a 0 dopo un tuo cambiamento;
- un passo marcato **UMANO** nella tabella.

---

## 2. La sequenza

| # | Passo | Dipende | Chi | Cancelli |
|---|---|---|---|---|
| 0 | **T0** — bring-up di Tauri | — | **UMANO** | app si apre, documento sopravvive a riapertura |
| 1 | **T12a** — archivio asset (IndexedDB) | — | ✅ **fatto** (`01f29bd`) | G-tsc, G-test |
| 2 | **T12b** — correzioni a T12a | 1 | agente | G-tsc, G-test |
| 3 | **T12-1** — modello e misura | 2 | agente | G-tsc, G-test, **G-par** |
| 4 | **T12-2** — disegno sul canvas | 3 | agente | G-tsc, G-test, **G-par** |
| 5 | **T12-3** — spazio riservato nell'overlay | 4 | agente | G-tsc, G-test, **G-par** |
| 6 | **T12-4** — op `setNodeImage` e undo | 5 | agente | G-tsc, G-test |
| 7 | **T13-1** — pipeline di import in un Worker | 6 | agente | G-tsc, G-test |
| 8 | **T13-2** — drop sul nodo e paste | 7 | agente | G-tsc, G-test |
| 9 | **T14** — slider e maniglia di ridimensionamento | 8 | agente | G-tsc, G-test, **G-par** |
| 10 | **T16** — `TauriAssetStore` e comandi Rust | 0, 8 | agente | G-tsc, G-test, app desktop funzionante |
| 11 | **T17** — misura della memoria e confronto | 10 | agente | G-mem |
| 12 | **T15** — `.rnode.zip` | 10 | agente | G-tsc, G-test |

I passi 3–6 sono la scomposizione di **T12**, che in ROADMAP.md è scritto come
un task unico: tocca sei aree e tre file governati dalla parità, quindi va
eseguito a pezzi con un cancello ciascuno.

---

## 3. I passi non ancora specificati altrove

Per 2, 7 (parziale), 8, 9, 12 vale quanto scritto in ROADMAP.md. Qui i pezzi
che lì non ci sono.

### Passo 3 — T12-1: modello e misura

**Fa**: `Style.imageWidth?: number`; costanti `MAX_IMAGE_W = 240` e
`IMAGE_GAP = 6`; `measureTopic` accetta
`resolveImage?: (id) => { w: number; h: number } | null`; helper
`imageResolver(sheet)`; geometria come in ROADMAP T12 passo 2.

**Non fa**: nessun disegno, nessuna cache, nessuna modifica all'overlay.

**Il punto su cui si rompe**: `measureTopic` è puro e non può leggere
`sheet.attachments`. Il resolver va passato in **tutti e tre** i punti che
misurano — `layoutSheet`/`applyLayout`, il renderer, `overlayMeasurer` in
CanvasView. Se anche uno solo non lo passa, quel chiamante misura i nodi senza
immagine, il layout li piazza a una dimensione e il renderer ne disegna
un'altra. È l'invariante I9. `imageResolver(sheet)` esiste perché sia
costruito in un punto solo.

**File**: `src/core/types.ts`, `src/layout/measure.ts`, `src/layout/mindmap.ts`,
`src/render/renderer.ts`, `src/ui/CanvasView.tsx`, `tests/measure.test.ts`.

### Passo 4 — T12-2: disegno sul canvas

**Fa**: l'immagine disegnata **fra la forma e il testo**, orizzontalmente
centrata, nel rettangolo calcolato al passo 3.

Cache delle bitmap secondo ADR-001 §12:

- chiave `${assetId}@${livello}`, dove il livello segue lo zoom corrente con lo
  **stesso schema a bucket già usato per le bitmap del testo** in
  `renderer.ts` (`Math.ceil(curScale * dpr)`, limitato);
- decodifica con `createImageBitmap(blob, { resizeWidth })` — fuori dal thread
  principale e senza materializzare la piena risoluzione;
- **solo per i nodi visibili** (il renderer culla già);
- **budget in byte, non in numero**: `w * h * 4` per bitmap, tetto 128MB,
  sfratto LRU finché si rientra;
- allo sfratto **`bitmap.close()`**: la memoria di un `ImageBitmap` non sta
  nello heap JS e il GC non la libera in modo prevedibile;
- **tetto duro: mai decodificare sopra 1024px.** È la pixelatura accettata in
  ADR-001 §12, resa regola;
- decodifiche in volo limitate (4–6), e se una finisce per un nodo non più
  visibile va chiusa subito invece di entrare in cache;
- al termine di una decodifica **richiama un repaint** (callback passata al
  Renderer da CanvasView).

**Trappole**: niente `await` dentro il disegno, il renderer resta sincrono.
Non sfrattare *durante* il disegno di un frame — una bitmap chiusa lancia:
sfratta a fine frame. Non toccare mai il livello `original`.

**Aggiungi al tracer** (`src/dev/trace.ts`) i contatori per frame:
immagini visibili, bitmap in cache, byte occupati, decodifiche in volo. Servono
al passo 11 e alla regola §4bis di AGENT_GUIDE.

**File**: `src/render/renderer.ts`, `src/ui/CanvasView.tsx`,
`src/dev/trace.ts`.

### Passo 5 — T12-3: spazio riservato nell'overlay

**Fa**: mentre si edita, `RichEditor` mostra sopra l'editable un blocco non
editabile (`contentEditable={false}`) alto `imgH` e largo `imgW`, con lo stesso
`IMAGE_GAP` sotto.

**Perché**: senza, la box salta al doppio click. È la classe di bug che la
sessione di parità ha chiuso, e G-par la intercetta.

**File**: `src/ui/RichEditor.tsx`, eventualmente `src/styles.css`.

### Passo 6 — T12-4: l'operazione

**Fa**: op `setNodeImage { nodeId, imageId: string | null, prevImageId }` con
inverso, più la scheda `AttachmentInfo` aggiunta a `sheet.attachments`.

**Regola**: l'op porta **solo l'id**, mai i byte. La history tiene 400 voci.

**File**: `src/core/ops.ts`, `src/editor/store.ts`, `tests/ops.test.ts`.

### Passo 7 — T13-1: pipeline di import in un Worker

Come ROADMAP T13 passo 1, **ma dentro un Web Worker**: lettura del file,
SHA-256 e generazione dei tre livelli (originale intatto, 1024px, 256px).

`AssetStore.put` legge l'originale intero in un `ArrayBuffer` per l'hash: con
originali ad alta risoluzione sono decine di MB copiati sul thread principale
a ogni import, e l'interfaccia si blocca. Venti immagini in un colpo passano
da fastidiose a inaccettabili.

Nel worker si usa `OffscreenCanvas` per il ridimensionamento.

**File**: `src/editor/imageImport.ts`, `src/editor/imageImport.worker.ts`,
`tests/imageImport.test.ts`.

### Passo 10 — T16: `TauriAssetStore` e comandi Rust

**Perché**: ADR-001 §12 sceglie B1. Centinaia di originali insostituibili non
possono vivere in IndexedDB, che Safari cancella dopo ~7 giorni di inattività
e Chrome può sfrattare. Su desktop diventano file veri.

**Rust** (`src-tauri/src/lib.rs`), accanto ai quattro comandi documenti già
presenti:

```rust
put_asset(id: String, level: String, bytes: Vec<u8>) -> Result<(), String>
get_asset(id: String, level: String) -> Result<Vec<u8>, String>
delete_asset(id: String) -> Result<(), String>
list_assets() -> Result<Vec<String>, String>
```

I file vanno nella cartella dati dell'app, come `assets/<id>/<level>`. I
metadati possono stare in SQLite accanto ai documenti.

**TypeScript**: `TauriAssetStore implements AssetStore` in
`src/persist/assets.ts` (o un file accanto), selezionato a runtime quando
l'ambiente Tauri è presente, con `IndexedDbAssetStore` come ripiego per il web.

**Non fare**: non rimuovere `IndexedDbAssetStore`. Serve al target web e ai
test.

**File**: `src-tauri/src/lib.rs`, `src/persist/assets.ts`,
`src/persist/storage.ts`.

### Passo 11 — T17: misura, invece di fidarsi

**Fa**: verifica sul campo i numeri su cui poggia ADR-001 §12.

1. Genera una mappa con **300 immagini** attaccate ai nodi.
2. Con il tracer (bottone ⏺ o `Ctrl+Shift+D`), cattura in quattro regimi:
   vista d'insieme, zoom medio, zoom ravvicinato, zoom massimo.
3. Per ciascuno annota: immagini visibili, bitmap in cache, **byte occupati**,
   ms per frame.

**G-mem passa se**: in ogni regime i byte delle bitmap restano **sotto
128MB**, e il frame time resta comparabile a quello senza immagini.

**Se non passa**: fermati e riporta i numeri. ADR-001 §12 contiene la
condizione che riaprirebbe la decisione (il caso "moodboard"), e questi sono i
dati che servono per valutarla.

---

## 4. Al termine

Alla fine dei dodici passi, la sequenza va rivista da capo: un commit per
passo rende possibile leggerla come storia. I punti da guardare per primi sono
i cancelli **G-par** dei passi 3, 4, 5 e 9 — se la parità è tornata a 0 senza
che nessuno abbia toccato `wrapRunLines`, il grosso è andato bene.
