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

---

## 5. Risultati del passo 11 (T17) — misurato il 2026-08-12

Mappa reale: **344 nodi, 300 immagini** da 1600×1200 attaccate, viewport
1280×720, **`devicePixelRatio = 1`**.

### Caso mappa normale (fit)

| Regime | Immagini visibili | Bitmap in cache | RAM bitmap | ms/frame |
|---|---|---|---|---|
| fit (zoom 0.4) | 22 | 54 | **5,6 MB** | 2,5 |

### Caso moodboard — 300 immagini impacchettate in griglia

È la **condizione di riapertura** dichiarata in ADR-001 §12: molte immagini
grandi tutte visibili insieme. Forzata spostando i 300 nodi con immagine in una
griglia fitta.

| Zoom | Immagini visibili | Bitmap in cache | RAM bitmap | ms/frame |
|---|---|---|---|---|
| 0,25 | **300** | 66 | 6,2 MB | 37,2 (burst iniziale di decodifica) |
| 0,5 | 90 | 306 | **17,4 MB** | 1,9 |
| 1,0 | 30 | 306 | 17,4 MB | 1,6 |

### Verdetto: **G-mem passa**

- Picco misurato **17,4 MB** contro un budget di 128 MB: **7 volte di margine**,
  e nel caso peggiore previsto dall'ADR, non in quello favorevole.
- Media **~57 KB per bitmap**. Senza la correzione del passo 4b sarebbero stati
  ~3 MB l'una: le stesse 306 bitmap avrebbero fatto **~900 MB**, cioè sfratto
  continuo. La correzione vale un fattore ~50 su questo carico.
- Il frame time resta **1,6–1,9 ms** a regime. Il picco di 37 ms si presenta una
  volta sola, quando 300 immagini entrano insieme nel viewport e la coda di
  decodifica è satura; si riassorbe da solo.
- **La condizione di riapertura di ADR-001 §12 non scatta.** Il caso moodboard
  è stato provato e regge.

### Avvertenza sulla misura

`devicePixelRatio` era **1**. Su schermo retina i bucket salgono di un passo e i
byte crescono di circa 4×: il picco stimato diventa **~70 MB**, ancora sotto il
budget ma con margine 1,8× invece di 7×. **Da rimisurare su un monitor a dpr 2**
prima di considerare chiusa la questione.

---

## 6. Passo 13 — T18: chiudere i difetti emersi dalla revisione

Tre punti trovati rivedendo i passi 10 e 12. **A va chiuso prima che qualcuno
salvi lavoro vero.**

**File**: `src/editor/store.ts` · `src/editor/exportBridge.ts` ·
`src/core/types.ts` · `src/persist/assets.ts` · `src/render/renderer.ts` ·
`src/ui/RichEditor.tsx` · i rispettivi test.

### A — il salvataggio può scrivere uno zip dentro un `.rnode.json`

`writePortableBytes` riusa la maniglia di file memorizzata e la chiave è **solo
il `docId`**. Quindi: salvi come `mappa.rnode.json`, alleghi un'immagine, premi
Ctrl+S, e `hasImages` fa scrivere **byte di zip dentro il file `.json`**, in
silenzio, sulla stessa maniglia. Vale anche al contrario.

R-node lo riapre lo stesso (sniffa i magic bytes `PK\x03\x04` — quella parte è
giusta e va tenuta), ma il file mente al sistema operativo, alle cartelle
sincronizzate e a chiunque lo riceva.

- [ ] la chiave della maniglia diventa `${docId}:${format}` con
      `format = "json" | "zip"`, **sia** nella mappa in memoria **sia** in
      IndexedDB;
- [ ] estrai la derivazione della chiave in una funzione pura e testala;
- [ ] quando per il formato richiesto non c'è maniglia, si apre il selettore
      (comportamento già esistente) **con un toast che spiega perché**, es.
      «Il documento ora contiene immagini: scegli dove salvare il .rnode.zip»;
- [ ] non cancellare la vecchia maniglia dell'altro formato: se le immagini
      vengono rimosse, il salvataggio torna al file originale.

### B — dopo un round-trip compact l'originale è perso e nulla lo dice

Un export `compact` non porta gli originali: all'import il livello 1024px
diventa anche `original`. È corretto e voluto. Il problema è che **niente lo
segna**, quindi un successivo export `complete` produce un file che dichiara di
contenere gli originali e contiene ridimensionamenti.

- [ ] `AttachmentInfo.originalLost?: boolean`, impostato all'import di un
      container `compact`;
- [ ] `buildRnodeZip(..., "complete")` rileva gli asset con quel flag: lo
      registra nel `manifest.json` (es. `degraded: true`) **e** avvisa
      l'utente prima di generare;
- [ ] l'avviso deve dire quanti asset sono coinvolti, non solo che ce ne sono.

### C — l'invariante dell'indirizzamento per contenuto ora ha un'eccezione

`putUnderId` è necessario (un container compact non porta l'originale, quindi
l'id non può essere ri-derivato) ma rompe `id === sha256(original)`.

- [ ] scrivilo accanto a `putUnderId` in `assets.ts`;
- [ ] aggiungilo agli invarianti in `AGENT_GUIDE.md` §2: l'id è lo SHA-256
      dell'originale **tranne** per gli asset ripristinati da un container
      compact, che portano `originalLost`.

### D — la factory si fissa troppo presto

`getAssetStore()` è chiamato **a livello di modulo** in `renderer.ts:48` e
`RichEditor.tsx:166`. Il singleton si fissa alla prima chiamata: se
l'inizializzazione dei moduli girasse prima che Tauri inietti
`window.__TAURI__`, resterebbe su IndexedDB per sempre. Empiricamente funziona,
ma dipende da un ordine che non controlliamo.

- [ ] chiama `getAssetStore()` **al momento dell'uso**, non allo scope di
      modulo (nel `Renderer` basta spostarlo nel costruttore).

### Fatto quando

- Un test sulla derivazione della chiave: stesso `docId` e formati diversi →
  chiavi diverse.
- Un test: importare un container compact marca gli asset con `originalLost`;
  costruirne uno `complete` da un documento che li contiene lo registra nel
  manifest.
- Nessuna chiamata a `getAssetStore()` allo scope di modulo.
- G-tsc, G-test verdi.

---

## 7. Passo 14 — T19: il documento è una cartella (solo desktop)

**Obiettivo.** Su desktop un documento diventa una cartella che contiene tutto:

```
MiaMappa.rnode/
├── document.json
└── assets/<id>/{original,large,small,meta}
```

**Perché.** Oggi il desktop è a metà: le immagini stanno su file veri (passo
10) ma il **documento resta nel localStorage della webview** —
`TauriStorageAdapter` è uno stub e nessuno lo istanzia. Conseguenze: il cap da
~5MB di localStorage vale ancora su desktop, e se quello storage viene
ripulito restano file immagine orfani sul disco senza il documento che li
referenziava.

**Perché una cartella e non uno zip.** Uno zip va riscritto per intero a ogni
salvataggio: con centinaia di originali sono GB ricompressi a ogni Ctrl+S. È la
struttura di `.xmind` senza il suo costo di salvataggio — qui `document.json`
si riscrive da solo, poche centinaia di KB, e le immagini si scrivono una volta
all'import e non si toccano più.

`.rnode.zip` **resta** il formato di scambio (passo 12). Cartella mentre
lavori, file singolo quando mandi.

**File**: `src-tauri/src/lib.rs` · `src/persist/assets.ts` ·
`src/persist/storage.ts` · `src/editor/store.ts` · `src/main.tsx`

### Passi

1. **Rust**: i comandi asset prendono una **radice esplicita** invece di usare
   la cartella dati dell'app: `put_asset(root, id, level, bytes)` e simili.
   Senza stato nascosto: una radice sbagliata è un bug visibile nella chiamata,
   non uno stato desincronizzato. Mantieni la guardia anti path-traversal.
2. **Rust**: `pick_document_folder() -> Option<String>` con un dialogo nativo
   (es. crate `rfd`), così non serve una dipendenza npm — coerente con come è
   stato fatto il passo 10.
3. **`TauriAssetStore`**: tiene la radice corrente come **stato mutabile
   interno**, non catturata alla costruzione.

   > **Trappola.** Il `Renderer` cattura il suo `assetStore` nel costruttore.
   > Se aprire un altro documento creasse un'istanza nuova, il renderer
   > continuerebbe a leggere dalla vecchia e mostrerebbe le immagini del
   > documento precedente. L'istanza deve restare la stessa e cambiare radice.

4. **`TauriStorageAdapter`**: legge e scrive `document.json` sotto la radice
   corrente. Niente più localStorage sul desktop.
5. **`main.tsx`**: costruisce `EditorStore` con `TauriStorageAdapter` quando
   `window.__TAURI__` è presente, `LocalStorageAdapter` altrimenti — stesso
   schema della factory degli asset.
6. **Apri / Salva con nome**: selettore cartella → imposta la radice → scrive
   `document.json` **e garantisce che ogni asset referenziato esista sotto
   `<root>/assets`**, copiandolo dallo store corrente se manca.

   > Senza il passo 6b il documento salvato referenzia id che nella sua
   > cartella non ci sono, e riaprendolo le immagini mancano. È la stessa
   > logica di `buildRnodeZip`, che scrive in una cartella invece che in un
   > archivio: riusala, non riscriverla.

7. **`saveNow`** su desktop scrive **solo** `document.json`.

### Fuori scope, di proposito

- **Non toccare la sidebar / la lista documenti.** Con il documento-cartella la
  "libreria" diventa un elenco di cartelle recenti: è un cambiamento di
  prodotto e va progettato a parte. Questo task apre e salva **un** documento.
- **Non migrare** gli asset già in `<app-data>/assets` dai test del passo 10.
- **Non toccare il percorso web**: IndexedDB resta com'è.

### Fatto quando

- G-tsc, G-test verdi.
- Sul desktop: crei una mappa, alleghi un'immagine, salvi in una cartella
  scelta tu, **chiudi l'app**, la riapri da quella cartella → l'immagine c'è.
- La cartella si ispeziona da Esplora risorse: `document.json` leggibile e
  `assets/<id>/` con i quattro file.
- Salvando un documento con immagini in una cartella **nuova**, le immagini
  vengono copiate: riaprendolo da lì non manca niente.

---

## 8. Passo 15 — T20: `.rnode` è un file SQLite

**Sostituisce il backend di T19.** Il documento passa da cartella a **un solo
file** con estensione propria: `MiaMappa.rnode`, che dentro è un database
SQLite contenente il documento **e** le immagini.

**Perché.** Il proprietario vuole una cosa singola, e uno zip non può esserlo:
non si aggiorna in posto, quindi ogni salvataggio ricomprimerebbe centinaia di
originali. SQLite dà file singolo **e** scrittura incrementale **e** transazioni
atomiche, e `rusqlite` è già fra le dipendenze.

**Perché adesso.** Il formato è la cosa più costosa da cambiare dopo: il codice
si riscrive, i file degli utenti no. Oggi gli unici file esistenti sono quelli
di test — è l'ultimo momento in cui la decisione è gratis.

**Le interfacce non cambiano.** `AssetStore` e `StorageAdapter` restano
identiche: cambia il **corpo** dei comandi Rust, da filesystem a SQL. È il
motivo per cui i seam esistono.

**File**: `src-tauri/src/lib.rs` · `src/persist/assets.ts` ·
`src/persist/storage.ts` · `src/editor/store.ts` · `tests/tauriAdapter.test.ts`

### Schema

Un file = un documento.

```sql
CREATE TABLE meta      (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE document  (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
CREATE TABLE assets    (id TEXT NOT NULL,      -- SHA-256
                        level TEXT NOT NULL,   -- original | large | small | meta
                        bytes BLOB NOT NULL,
                        PRIMARY KEY (id, level));
```

`meta` porta almeno `schemaVersion` e `app`: serve a riconoscere il file e a
poter migrare in futuro senza indovinare.

### Il dettaglio che quasi tutti sbagliano

**NON usare `journal_mode=WAL`.** È il default a cui si arriva per abitudine, ed
è giusto per un server con lettori concorrenti. Qui è sbagliato: WAL crea
`MiaMappa.rnode-wal` e `MiaMappa.rnode-shm` **accanto** al file, e "una cosa
singola" era il requisito.

Usa il journal di rollback predefinito (`DELETE`): crea un `-journal` solo
**durante** una transazione di scrittura e lo rimuove alla fine. A riposo sul
disco c'è esattamente un file.

### Passi

1. **Rust**: sostituisci i comandi asset basati su file con l'equivalente SQL.
   La firma resta la stessa a meno di `root` → `path` del file `.rnode`.
   Il salvataggio del documento è **una transazione**.
2. **Rust**: `pick_document_file(mode: "open" | "save")` con `rfd`, filtro
   sull'estensione `.rnode`. Sostituisce `pick_document_folder`.
3. **Prima del primo salvataggio** serve comunque un posto dove mettere le
   immagini: mantieni il comportamento di `default_asset_root` come
   `<app-data>/scratch.rnode`. Allegare un'immagine a una mappa mai salvata
   deve continuare a funzionare, e al primo salvataggio il contenuto viene
   adottato nel file scelto.
4. **`adoptRoot` → `adoptFile`**: copia gli asset referenziati nel nuovo file
   **leggendo ancora dal vecchio**, e solo dopo commuta. Stesso ordine di T19,
   stessa ragione.
5. **TypeScript**: `TauriAssetStore` e `TauriStorageAdapter` cambiano il nome
   dei comandi invocati e poco altro. La radice mutabile resta mutabile — la
   trappola del `Renderer` che cattura lo store vale identica.
6. **Byte grezzi sull'IPC**: oggi `get_asset` restituisce `Vec<u8>`, che Tauri
   serializza come **array JSON di numeri**. Per i livelli di visualizzazione
   (~100KB) va bene; per un originale da 50MB sono cinquanta milioni di numeri
   da serializzare e riparsare. Tauri v2 permette di restituire byte grezzi
   (`tauri::ipc::Response` o equivalente — **verifica l'API esatta della
   versione in uso**). Se si rivela più complicato del previsto, **fermati e
   segnalalo**: è un'ottimizzazione, non un requisito di questo passo.
7. **Rimuovi** il backend a file di T19 (`assets/<id>/<level>`,
   `read_document` / `write_document` su `document.json`). Niente migrazione:
   gli unici file esistenti sono di test.

### Fatto quando

- G-tsc, G-test verdi; `cargo check` compila.
- **Il giro desktop, finalmente su formato definitivo**: crei una mappa,
  alleghi un'immagine, salvi come `MiaMappa.rnode`, **chiudi l'app**, riapri
  quel file → l'immagine c'è.
- **A riposo sul disco c'è un file solo**: nessun `-wal`, nessun `-shm`,
  nessun `-journal` dopo un salvataggio concluso.
- Salvando "con nome" su un file nuovo, le immagini vengono copiate: riaprendo
  quello non manca niente.
- Export `.rnode.zip` continua a funzionare (legge attraverso `AssetStore`,
  quindi non dovrebbe accorgersi del cambiamento — verificalo).
