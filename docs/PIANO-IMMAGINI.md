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
| 4b | **T12-2b** — decodificare alla dimensione resa | 4 | agente | G-tsc, G-test, **G-par** |
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

### Passo 4b — T12-2b: decodificare alla dimensione resa

Correzione al passo 4. Lì `createImageBitmap(blob)` viene chiamato **senza**
`resizeWidth`, quindi la bitmap si materializza alla dimensione di
archiviazione invece che a quella che serve.

Il tetto a 1024px regge lo stesso — lo impone il livello memorizzato — quindi
non c'è rischio di esaurire la memoria. Ma il costo sì: su schermo retina
(`dpr = 2`) la soglia `res <= 1` manda su `large` già sopra zoom 0.5, cioè
bitmap da 1024×768 → **3MB l'una**. A zoom 0.8 con 50 nodi con immagine
visibili sono 150MB: sopra il budget, quindi sfratto e ri-decodifica continui.

**Va chiuso prima del passo 11**, altrimenti quella misura registra numeri
gonfiati da una riga mancante e sembrerebbe che a non reggere sia la decisione
di ADR-001 §12.

**Il cambiamento**, in `renderer.ts`:

```ts
// pixel fisici realmente occupati DA QUESTA immagine, non lo zoom globale
const neededPx = imgW * this.curScale * this.dpr;
// quantizza a potenze di due: senza, ogni micro-variazione di zoom
// produrrebbe una chiave nuova e la cache non colpirebbe mai
const bucket = clamp(pow2ceil(neededPx), 128, 1024);
const level: AssetLevel = bucket <= 256 ? "small" : "large";
const key = `${imageId}@${bucket}`;
...
const bitmap = await createImageBitmap(blob, { resizeWidth: bucket, resizeQuality: "high" });
```

Quattro punti da non sbagliare:

1. **La chiave deve contenere il bucket**, non il livello. Con dimensioni di
   decodifica variabili e chiave per livello, una bitmap decodificata a 384px
   verrebbe riusata quando ne servono 900 e l'immagine resterebbe sfocata per
   sempre.
2. **Mai ingrandire**: `bucket` non supera 1024, che è la larghezza del livello
   `large` memorizzato. Decodificare più grande della sorgente spreca memoria
   senza aggiungere qualità.
3. **Passa solo `resizeWidth`**: l'altezza viene calcolata mantenendo le
   proporzioni. Passarle entrambe rischia di deformare.
4. Il conteggio dei byte (`bitmap.width * bitmap.height * 4`) e lo sfratto
   restano com'erano: si adeguano da soli.

**Effetto atteso**: a zoom 0.8 su retina, `neededPx = 240 × 0.8 × 2 = 384` →
bucket 512 → ~786KB invece di 3MB. **Circa quattro volte meno**, e le cifre
tornano a coincidere con la tabella di ADR-001 §12.

**Mentre ci sei**, `imageResolver(store.sheet)` viene ricostruito a ogni render
in `CanvasView.tsx` (riga ~634): memoizzalo su `store.sheet`.

**File**: `src/render/renderer.ts`, `src/ui/CanvasView.tsx`.

**Cancelli**: G-tsc, G-test, **G-par**.

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
