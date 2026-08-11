# R-node — roadmap operativa

Task in ordine di esecuzione. **Fai un task alla volta, nell'ordine scritto.**
Prima di iniziare leggi [AGENT_GUIDE.md](AGENT_GUIDE.md) §1, §2, §6.

Ogni task è chiuso solo quando la sua sezione **Fatto quando** è interamente
vera. Se non ci riesci, fermati e spiega: non disattivare test, non alzare
soglie, non allargare lo scope.

Legenda: **P0** = blocca la qualità del resto · **P1** = alto valore ·
**P2** = funzionalità mancanti.

---

## T1 — Invariant checker della topologia · P0

**Obiettivo.** Una funzione pura che verifica che l'albero dei nodi sia
coerente, invocata dopo ogni batch di operazioni in dev/test.

**Perché.** `execOps` (`src/editor/store.ts`) applica gli op mutando l'albero
in place, senza alcuna validazione. Un `parentId` sbagliato non dà errore:
resta in memoria, viene salvato su disco, e riemerge molto dopo come crash
inspiegabile lontano dalla causa. Questo task trasforma una corruzione
silenziosa in un errore immediato e con un nome.

**File.** `src/core/validate.ts` (nuovo) · `src/editor/store.ts` ·
`tests/validate.test.ts` (nuovo)

**Passi.**
1. Crea `src/core/validate.ts` con:
   ```ts
   export class InvariantViolation extends Error {}
   export function validateSheet(sheet: Sheet): void
   ```
2. `validateSheet` deve lanciare `InvariantViolation` se **una** di queste è
   falsa:
   - **Coerenza parent/children**: se `B` compare in `A.childrenIds`, allora
     `sheet.nodes[B].parentId === A.id`. E viceversa: se `B.parentId === A.id`,
     allora `B.id` compare in `A.childrenIds` esattamente una volta.
   - **Riferimenti risolvibili**: ogni id in `childrenIds`, ogni `parentId` non
     nullo, e ogni `fromId`/`toId` in `relationships` esistono in `sheet.nodes`.
   - **Nessun ciclo**: partendo da `rootNodeId` e scendendo per `childrenIds`,
     nessun nodo viene visitato due volte.
   - **Root**: `sheet.nodes[sheet.rootNodeId]` esiste e ha `parentId === null`.
   - **Nessun orfano**: ogni nodo è raggiungibile da `rootNodeId`, tranne quelli
     con `type === "floating"`.
3. Il messaggio deve nominare gli id coinvolti, es.
   `InvariantViolation: node 'n_123' has parentId 'n_456' but appears in childrenIds of 'n_789'`.
4. In `store.ts`, alla fine di `execOps`, `undo` e `redo`, invoca
   `validateSheet(this.sheet)` **solo fuori produzione**:
   ```ts
   if (import.meta.env?.DEV ?? true) validateSheet(this.sheet);
   ```
   In produzione deve costare zero.

**Fatto quando.**
- `tests/validate.test.ts` copre i 5 casi sopra: uno sheet valido passa, e
  cinque sheet corrotti a mano lanciano ciascuno il proprio errore.
- Almeno un test verifica che dopo una sequenza reale di op via `EditorStore`
  (crea → sposta → cancella → undo → redo) lo sheet resti valido.
- `npm test` e `npm run typecheck` verdi.

**Non fare.** Non "riparare" automaticamente lo sheet quando trovi
un'incoerenza: deve fallire, non correggere. Non invocarlo in produzione.

---

## T2 — Harness di parità nella suite di test · P0

**Obiettivo.** I casi di `dev/parity.ts` diventano un test automatico che
fallisce da solo, invece di un URL da aprire a mano.

**Perché.** Oggi la fedeltà visiva del testo sul canvas è protetta solo se
qualcuno si ricorda di aprire `/dev/parity.html`. Chiunque può rompere
`measure.ts` senza che nessuno se ne accorga.

> **Prima di iniziare questo task, fermati e chiedi conferma.** Aggiunge una
> dipendenza di sviluppo (browser di test) e un browser da installare in CI:
> è una decisione del proprietario del progetto, non tua.

**File.** `package.json` · `vite.config.ts` · `tests/parity.browser.test.ts`
(nuovo) · `dev/parity.ts` (solo estrazione, vedi sotto)

**Passi.**
1. **jsdom non serve a niente qui**: non implementa il layout,
   `getBoundingClientRect()` restituisce zeri. Serve un browser vero —
   `@vitest/browser` con provider Playwright, oppure Playwright diretto.
2. Estrai da `dev/parity.ts` in un modulo condiviso (es.
   `dev/parityCore.ts`) tutto tranne il rendering del report HTML: il corpus
   `CASES`, `runsToDom`, `browserLines`, `canvasLines`, `runCase`. La pagina
   `dev/parity.html` continua a usarlo per l'ispezione manuale.
3. Il test importa `CASES` e `runCase` e asserisce, **per ogni caso**:
   - `linesCanvas === linesBrowser`
   - `firstBreakMismatch === null`
   - `maxDTop`, `maxDAdv`, `maxDLeft`, `|dTotalH|` tutti `<= 0.5`
4. Il messaggio di fallimento deve nominare il caso e il delta, es.
   `parity[bullets-nested]: maxDTop 10.5 > 0.5`.

**Fatto quando.**
- Il nuovo test gira con `npm test` (o uno script dedicato documentato nel
  README) e passa su tutti i 16 casi.
- Rompendo di proposito una costante (es. `BLOCK_GAP_FACTOR` da 0.6 a 0.5) il
  test **fallisce**. Verificalo davvero, poi ripristina.

**Non fare.** Non abbassare `EPS` sopra 0.5 per far passare il test. Non
riscrivere `wrapRunLines` in questo task.

---

## T3 — Property-based testing su apply/inverse · P1 · dipende da T1

**Obiettivo.** Verificare matematicamente che applicare op e poi i loro inversi
riporti allo stato di partenza, su sequenze generate a caso.

**Perché.** `tests/ops.test.ts` copre scenari scritti a mano. L'undo/redo è un
sistema algebrico: gli edge case veri stanno nelle combinazioni che nessuno
pensa di scrivere.

**File.** `package.json` (dev dep `fast-check`) · `tests/ops.property.test.ts`
(nuovo)

**Passi.**
1. Arbitrary per uno `Sheet` valido piccolo (3–10 nodi): genera un albero, poi
   fallo passare da `validateSheet` (T1) — se non è valido, l'arbitrary è
   sbagliato.
2. Arbitrary per una sequenza di 1–10 `Op` **strutturalmente applicabili** a
   quello sheet (`createNode`, `moveNode`, `setTitle`, `setStyle`,
   `deleteNode`). Gli id devono riferirsi a nodi esistenti.
3. Proprietà da verificare:
   - **Round-trip**: applica gli op raccogliendo gli inversi con
     `applyWithInverse`, poi applica gli inversi in ordine inverso → lo sheet
     è deep-equal a quello iniziale.
   - **Validità continua**: dopo ogni singolo op, `validateSheet` non lancia.
4. Almeno 200 run per proprietà.

**Fatto quando.** Entrambe le proprietà passano. Se `fast-check` trova un
controesempio reale, **è un bug del codice**: correggilo e aggiungi quel caso
come test deterministico in `tests/ops.test.ts`.

---

## T4 — Tipizzare i campi non implementati di `Sheet` · P1

**Obiettivo.** Impedire che vengano scritti dati arbitrari nei campi ancora
non progettati.

**Perché.** `src/core/types.ts:248-254` dichiara `boundaries`, `summaries`,
`callouts`, `zones`, `attachments`, `comments` come `unknown[]`. `unknown[]`
accetta qualunque cosa in scrittura: è un invito a inventare schemi incoerenti.

**File.** `src/core/types.ts` · eventuali punti che li inizializzano.

**Passi.**
1. Cambia a `never[]` **cinque** campi: `boundaries`, `summaries`, `callouts`,
   `zones`, `comments`. **Lascia stare `attachments`**: è l'unico che sta per
   avere un consumatore vero, e lo tipizza T12.
2. Aggiungi sopra un commento: sono feature di Fase 2–3, si tipizzano quando si
   progettano, e `never[]` costringe a una decisione esplicita.

**Fatto quando.** `npm run typecheck` verde (gli array vuoti `[]` restano
validi) e `npm test` verde.

**Non fare.** **Non inventare** `CalloutInfo`, `ZoneInfo` ecc. Progettare ora
schemi per feature non implementate è esattamente il debito che questo task
evita.

---

## T5 — Budget di performance assertivi · P1

**Obiettivo.** Far **fallire** i test se una modifica degrada le performance,
invece di stamparlo in console.

**Perché.** `tests/perf.test.ts` già misura `applyOps`, `layout`, `writeback`,
`walks` e li stampa. Nessuno legge la console: una regressione passa
inosservata.

**File.** `tests/perf.test.ts`

**Passi.**
1. Esegui `npm test` e annota i tempi attuali a 1.000, 5.000 e 10.000 nodi.
2. Aggiungi asserzioni con soglia **generosa (3× la misura attuale)**: servono
   a catturare regressioni algoritmiche (10×), non il rumore della macchina.
3. Commenta ogni soglia con il valore misurato e la data.

**Fatto quando.** I test passano; alzando artificialmente il costo di
`layoutSheet` (es. un ciclo inutile) falliscono. Verificalo, poi ripristina.

**Non fare.** Soglie strette: un test perf che fallisce a caso viene disattivato
entro una settimana e non protegge più nulla.

---

## T6 — Chiave della cache testo fuori dall'hot path · P1

**Obiettivo.** Smettere di serializzare i runs di ogni nodo visibile a ogni
frame.

**Perché.** `Renderer.textCacheKey` (`src/render/renderer.ts`) costruisce la
chiave con `JSON.stringify(n.titleRuns ?? n.title)`, e `drawText` la chiama per
**ogni nodo visibile a ogni frame**. La cache evita di ri-disegnare, non di
costruire la chiave: con titoli lunghi è il costo dominante del pan.

**File.** `src/render/renderer.ts` · eventualmente `src/core/types.ts`

**Passi.** Scegli **una** delle due strade:
- **A (consigliata)**: `WeakMap<MindNode, entry>` come primo livello di lookup.
  Funziona solo se gli op sostituiscono l'oggetto nodo invece di mutarlo:
  **verificalo prima** in `src/core/ops.ts`. Se i nodi sono mutati in place,
  scarta A.
- **B**: un contatore `titleVersion` sul nodo, incrementato dagli op che
  cambiano titolo/stile, usato nella chiave al posto del `JSON.stringify`.

**Fatto quando.** Nessun `JSON.stringify` nel percorso di disegno per frame; il
rendering resta visivamente identico (harness a 0 divergenze) e i test passano.

---

## T7 — Il colore del testo non deve cancellare il font-size · P1

**Obiettivo.** Applicare il colore alla selezione senza distruggere gli altri
stili inline e senza colorare testo non selezionato.

**Perché.** `applyColor` in `src/ui/RichEditor.tsx` fa
`node.setStyle("color: …")`: `setStyle` **sostituisce** l'intera stringa, quindi
colorare un heading gli toglie il `font-size`. E itera su `selection.getNodes()`
colorando **interi** `TextNode` anche quando la selezione ne copre solo una
parte: selezionare mezza parola colora tutta la parola.

**File.** `src/ui/RichEditor.tsx` · `tests/lexicalRuns.test.ts`

**Passi.** Sostituisci `applyColor` e `clearColor` con `$patchStyleText` da
`@lexical/selection`: fa lo split dei nodi ai bordi della selezione e fonde le
proprietà invece di sostituirle. `clearColor` passa `{ color: null }`.

**Fatto quando.** Un test verifica che colorare un run con `fontSize: 26`
mantiene il `fontSize` nei runs risultanti, e che colorare una sotto-parte
produce runs distinti.

---

## T8 — Toolbar: liste, heading, sottolineato, barrato · P2

**Obiettivo.** Rendere raggiungibili dall'interfaccia le formattazioni che il
modello già supporta.

**Perché.** `TextRun` supporta `underline`, `fontSize` (heading) e `listIndent`,
il canvas li disegna e la sanitizzazione li produce — ma la toolbar ha solo
B / I / colore / clear. Heading e liste si ottengono **solo incollandoli**.

**File.** `src/ui/RichEditor.tsx` · `src/styles.css`

**Passi.**
1. Aggiungi: sottolineato e barrato (`FORMAT_TEXT_COMMAND` con `"underline"` /
   `"strikethrough"`), lista puntata (`INSERT_UNORDERED_LIST_COMMAND` da
   `@lexical/list`), e un selettore heading H1–H3 che imposta `font-size`
   inline sui `TextNode` selezionati via `$patchStyleText`.
2. Usa le taglie già definite in `HEADING_SIZES`.

**Fatto quando.** Ogni comando produce i runs attesi (`editorStateToRuns`), il
round-trip resta idempotente (I8), e l'harness resta a 0 divergenze.

**Attenzione.** Gli heading devono restare `font-size` inline su `<span>`, non
`HeadingNode`: il canvas e il calcolo del gap dipendono da questo (§3.3 della
guida).

---

## T9 — `PastePolicy`: preservare la struttura, imporre l'estetica R-node · P2

**Obiettivo.** Una politica di incollamento esplicita e in un solo posto.

**Perché.** Oggi la politica è implicita e in parte contraddittoria:
- `HEADING_SIZES` è **duplicata** in `src/ui/lexicalRuns.ts` e
  `src/ui/pasteSanitizer.ts`, ed è in px **assoluti**: su un nodo con
  `fontSize: 20`, un `<h6>` incollato risulta **più piccolo** del corpo;
- i colori del documento sorgente passano intatti, quindi l'estetica del brand
  non è imposta;
- `applyInline` non legge mai `style.fontSize` delle `<span>`: Word esprime i
  suoi stili "Titolo" così, quindi la gerarchia visiva di un documento Word si
  appiattisce senza che nessuno lo dica;
- non c'è alcun limite di volume: incollare 40 pagine in un titolo produce un
  nodo alto qualche migliaio di px.

**File.** `src/ui/pastePolicy.ts` (nuovo) · `src/ui/pasteSanitizer.ts` ·
`src/ui/lexicalRuns.ts` · `tests/pasteSanitizer.test.ts`

**Passi.**
1. Un solo modulo con la mappa heading come **scale relative**
   (`h1: 1.8 … h6: 1.0`), risolte al paste contro il `fontSize` del nodo e
   clampate a `[base, base × 2]`.
2. `font-size` delle span sorgente: leggilo e mappalo allo step di brand più
   vicino, invece di scartarlo in silenzio.
3. Colori: snap alla palette entro una soglia; scarta quelli troppo vicini al
   colore di testo di default. Prevedi un modificatore per il paste fedele.
4. Cap su blocchi e caratteri, con troncamento **annunciato** all'utente.
5. Elimina la costante duplicata.

**Fatto quando.** I test coprono: heading relativi al font del nodo, colore
snappato, font-size Word bucketizzato, cap rispettato. Nessuna regressione in
`tests/pasteSanitizer.test.ts`.

---

## T10 — Paste ricco su nodo selezionato · P2

**Obiettivo.** Incollare da Word con un nodo selezionato (senza aprire
l'editor) deve conservare la formattazione.

**Perché.** `EditorStore.paste` usa `navigator.clipboard.readText()`, quindi il
percorso `typeToEdit → plainToRuns` **perde tutta la formattazione**. Il paste
ricco funziona solo dentro l'editor già aperto.

**File.** `src/editor/store.ts` · `src/ui/RichEditor.tsx`

**Passi.** Usa `navigator.clipboard.read()` per ottenere `text/html`, instradalo
in `sanitizeHtml → htmlToRuns` (con la policy di T9) e introduci un
`pendingInsertRuns` accanto a `pendingInsert`, consumato al mount dell'overlay.
Mantieni il fallback a testo piatto dove l'API non è disponibile.

**Fatto quando.** Un test dello store verifica che con HTML negli appunti il
nodo riceve runs formattati, e che senza HTML il comportamento attuale non
cambia.

---

## T11 — Guardia sulla composizione IME · P2

**Obiettivo.** Non convertire lo stato dell'editor in runs mentre l'utente sta
componendo (cinese, giapponese, coreano, accenti con dead key).

**Perché.** `DraftSyncPlugin` chiama `editorStateToRuns` a **ogni** update,
composizione inclusa: layout thrash e composizione potenzialmente rotta.

**File.** `src/ui/RichEditor.tsx`

**Passi.** Nel listener, salta l'aggiornamento del draft se
`editor.isComposing()`, e forza una sincronizzazione al termine della
composizione.

**Fatto quando.** Il draft non viene aggiornato durante la composizione e
contiene il testo finale corretto alla fine.

---

> **I task T12a–T15 assumono le scelte A1+B1 di
> [ADR-001](ADR-001-immagini-e-piattaforma.md)** — archivio asset separato,
> due varianti per immagine, decodifica governata nel renderer. Quella
> decisione è ancora **aperta**: se cambia (per esempio verso un renderer
> WebGPU), questi quattro task vanno rivisti prima di eseguirli.

## T12a — Archivio degli asset (fuori dal documento) · P2

**Obiettivo.** Un archivio di blob separato dal documento, indirizzato per
contenuto, dietro un'interfaccia con due implementazioni possibili.

**Perché prima di tutto il resto.** Le immagini **non possono stare dentro il
documento**. Oggi si salva con `JSON.stringify(docs)` in localStorage: quota
reale ~5MB, e una mappa da 10k nodi ne occupa già ~3.6. Il base64 gonfia i
byte del 33%. L'obiettivo dichiarato sono **centinaia di immagini**: non ci
sta di un ordine di grandezza, e un documento da decine di MB blocca il thread
principale a ogni `JSON.parse`. Se questo task non viene per primo, ogni
immagine già allegata va poi migrata.

**File.** `src/persist/assets.ts` (nuovo) · `src/core/types.ts` ·
`tests/assets.test.ts` (nuovo)

**Passi.**

1. **Interfaccia**, sullo stesso modello di `StorageAdapter` che esiste già:
   ```ts
   export interface AssetVariant { blob: Blob; w: number; h: number; bytes: number }
   export interface AssetStore {
     put(original: Blob, display: Blob, meta: {...}): Promise<string>; // → id
     get(id: string, variant: "display" | "original"): Promise<Blob | null>;
     delete(id: string): Promise<void>;
     list(): Promise<string[]>;
   }
   ```
2. **`IndexedDbAssetStore`** come default: unica implementazione richiesta da
   questo task. IndexedDB immagazzina `Blob` **nativi** — niente base64, niente
   inflazione — e la quota è di centinaia di MB fino a GB. Un object store
   `assets` con chiave l'id, valore `{ original, display, meta }`.
3. **Indirizzamento per contenuto**: l'id è lo SHA-256 del file originale
   (`crypto.subtle.digest`). La stessa immagine allegata a 50 nodi occupa
   spazio **una volta sola**, e non esistono collisioni di nomi.
4. **Due varianti per asset**, ed è il punto che concilia i due requisiti:
   - `original` — il file come importato, mai ricompresso. È la sorgente di
     verità: lo slider di T14 e l'export ad alta qualità partono da qui.
   - `display` — derivata all'import, **1024px sul lato lungo**, JPEG q0.85
     (PNG se ha canale alpha). È l'unica che il canvas decodifica mai.

   Un nodo mostra al massimo poche centinaia di unità world: decodificare
   l'originale da 4000px per disegnarlo a 240 significa tenere in RAM decine di
   volte i pixel che finiscono a schermo. Con centinaia di immagini è la
   differenza fra una mappa fluida e una che fa scattare lo scorrimento.
5. **Conteggio dei riferimenti e GC.** `sheet.attachments` elenca gli id usati;
   una funzione `collectOrphans(sheet)` restituisce gli id nell'archivio che
   nessun nodo referenzia più. Va invocata **esplicitamente** (comando, non
   automatismo): cancellare byte come effetto collaterale di un undo è il tipo
   di comportamento che distrugge dati.

**Fatto quando.** Test su `AssetStore` con un `fake-indexeddb`: `put` due volte
lo stesso contenuto restituisce lo stesso id e non duplica; `get` restituisce
le due varianti; `delete` rimuove; `collectOrphans` trova solo gli id non
referenziati. `npm test` e `npm run typecheck` verdi.

**Non fare.** Niente data URL da nessuna parte. Nessun byte in `MindNode`, in
un `Op` o nella history.

---

## T12 — Immagini nei nodi: modello, misura, disegno · P2 · dipende da T12a

**Obiettivo.** Un nodo può portare un'immagine, mostrata **sopra** il testo,
dentro la stessa box.

**Perché prima di T13/T14.** Ingestione (drop/paste) e resize sono inutili
finché il modello non esiste e la box non si misura giusta. Questo task non
aggiunge **nessuna** interazione: si verifica impostando `style.image` a mano.

> **Conflitto con T4.** T4 dice di portare i campi non implementati di `Sheet` a
> `never[]`. `attachments` è il primo ad avere un consumatore reale: **escludilo
> da T4** e tipizzalo qui.

**File.** `src/core/types.ts` · `src/core/ops.ts` · `src/layout/measure.ts` ·
`src/render/renderer.ts` · `src/ui/RichEditor.tsx` · `src/editor/store.ts` ·
`tests/measure.test.ts`

**Passi.**

1. **Modello.** In `types.ts`:
   ```ts
   export interface AttachmentInfo {
     id: string;        // SHA-256 del contenuto: la chiave nell'AssetStore
     mime: string;      // image/png | image/jpeg | image/gif | image/webp
     w: number;         // pixel intrinseci dell'ORIGINALE
     h: number;
     displayW: number;  // pixel della variante che il canvas decodifica
     displayH: number;
     bytes: number;     // originale, per mostrare il peso all'utente
     name?: string;
     alt?: string;
   }
   ```
   **Nessun byte qui dentro**: i blob vivono nell'AssetStore di T12a e questa è
   solo la scheda anagrafica, che sta nel documento. `Style.image` esiste già ed
   è l'id: **non aggiungere un secondo campo**. Aggiungi
   `Style.imageWidth?: number` (larghezza di visualizzazione in unità world;
   l'altezza segue le proporzioni dell'originale).

   **`w`/`h` sono obbligatori nel modello.** Senza le dimensioni intrinseche il
   layout non può misurare il nodo finché l'immagine non è decodificata, e ogni
   ricaricamento del documento farebbe saltare tutte le posizioni.

2. **Misura** (`measureTopic`). Se il nodo ha un'immagine risolvibile:
   - `imgW = style.imageWidth ?? min(att.w, MAX_IMAGE_W)` con `MAX_IMAGE_W = 240`;
   - `imgH = imgW * att.h / att.w`;
   - la larghezza della box è `max(larghezza del testo, imgW + pad*2)`;
   - l'altezza è `imgH + IMAGE_GAP + altezza del testo + pad*2 + 4`, con
     `IMAGE_GAP = 6` esportata come costante condivisa;
   - se il testo è vuoto, niente `IMAGE_GAP` e niente riga vuota.

   `measureTopic` è puro e non può leggere `sheet.attachments`: passa la
   risoluzione come parametro opzionale, es.
   `measureTopic(n, measurer, resolveImage?: (id) => {w,h} | null)`. Chi chiama
   (layout, renderer, overlay) fornisce la stessa funzione — **se i tre non la
   passano tutti, le misure divergono** e l'invariante I9 salta.

3. **Disegno** (`renderer.drawNode`). L'immagine va **fra la forma e il testo**.
   Il renderer è sincrono, le immagini no: serve una cache con stato.
   ```ts
   private bitmaps = new Map<string, ImageBitmap>();   // LRU, max ~100
   ```
   - decodifica **solo la variante `display`** e **solo per i nodi visibili**:
     il renderer culla già i nodi, quindi aprire una mappa con 500 immagini
     deve costare quanto aprirne una senza;
   - usa `createImageBitmap(blob)` — decodifica fuori dal thread principale e
     restituisce un oggetto che `drawImage` accetta direttamente, senza data
     URL né `<img>` intermedi;
   - miss → avvia la decodifica, e al termine **richiama un repaint** (callback
     passata al Renderer dal CanvasView). Finché non è pronta non disegnare
     nulla: lo spazio è già riservato dalla misura, quindi non c'è salto;
   - sfratto **LRU con `bitmap.close()`**: libera la memoria in modo
     deterministico, cosa che con `new Image()` non puoi fare. Con centinaia di
     immagini è ciò che tiene la RAM sotto controllo.

   **Non** decodificare a ogni frame, **non** usare `await` dentro il disegno,
   **non** toccare mai la variante `original`: il renderer resta sincrono e non
   deve mai vedere i pixel a piena risoluzione.

4. **Parità con l'overlay** (`RichEditor`). Mentre editi, la box deve avere la
   stessa geometria: aggiungi sopra l'editable un `<div>` non editabile,
   `contentEditable={false}`, alto esattamente `imgH` e largo `imgW`, con lo
   stesso `IMAGE_GAP` sotto. Senza questo la box salta al doppio click — è
   esattamente la classe di bug di §3 della guida.

5. **Op.** `setNodeImage { nodeId, imageId: string | null, prevImageId }`, con
   inverso. **L'op porta solo l'id**, mai i byte: la history tiene 400 voci e
   duplicare data URL da megabyte la farebbe esplodere. Le `AttachmentInfo`
   vivono in `sheet.attachments`, indirizzate per contenuto (hash) così due
   nodi con la stessa immagine la condividono.

6. **Export.** `exportPng` è sincrono: prima di esportare attendi che tutte le
   immagini referenziate siano `ready`, altrimenti l'esportazione esce senza.
   Markdown export: `![alt](src)`.

**Fatto quando.**
- Test in `tests/measure.test.ts`: un nodo con immagine 200×100 e testo su una
  riga misura `imgH + IMAGE_GAP + lineH + pad*2 + 4`; senza testo non ha gap;
  `imageWidth` esplicita cambia altezza e larghezza in modo proporzionale.
- Impostando `style.image` a mano da console l'immagine appare, la box cresce,
  e il doppio click **non** cambia la geometria.
- L'harness di parità resta a 0 divergenze.
- `npm test` e `npm run typecheck` verdi.

**Non fare.** Niente drop, niente paste, niente resize: sono T13 e T14. Non
mettere i byte dell'immagine dentro gli op né dentro `MindNode`.

---

## T13 — Ingestione: drop e paste di immagini · P2 · dipende da T12

**Obiettivo.** Trascinare un file immagine su un nodo, o incollarlo con un nodo
selezionato, lo allega.

**File.** `src/ui/CanvasView.tsx` · `src/editor/store.ts` ·
`src/editor/imageImport.ts` (nuovo) · `tests/imageImport.test.ts` (nuovo)

**Passi.**

1. **Pipeline di import** (`imageImport.ts`), pura e testabile a parte:
   - allowlist: `image/png`, `image/jpeg`, `image/gif`, `image/webp`.
     **SVG escluso**: è un documento eseguibile, e la guida (§9 di
     ARCHITECTURE) mette l'hardening XSS fra le cose differite — non è il
     momento di aprire quella porta;
   - rifiuta oltre `MAX_SOURCE_BYTES = 25 MB` con un messaggio;
   - **conserva l'originale così com'è**, senza ricomprimerlo: è la sorgente di
     verità per lo slider di T14 e per l'export ad alta qualità;
   - **deriva la variante `display`** a `1024px` sul lato lungo (JPEG q0.85,
     PNG se ha canale alpha), via `<canvas>` o `createImageBitmap` con
     `resizeWidth`;
   - passa entrambe a `AssetStore.put` e restituisce l'`AttachmentInfo`.

   Le due varianti servono a cose diverse e non sono negoziabili: l'originale
   perché l'hai chiesto tu, la `display` perché è l'unica che il canvas
   decodifica. Decodificare un originale da 4000px per disegnarlo a 240 unità
   world tiene in RAM decine di volte i pixel che finiscono a schermo, e con
   centinaia di immagini è esattamente lì che l'app inizia a scattare.

2. **Drop.** Handler `dragover` (con `preventDefault`, altrimenti il browser
   apre il file) e `drop` su `.canvas-wrap` — **lo stesso elemento del wheel**,
   e per lo stesso motivo: durante l'editing il puntatore è sopra l'overlay.
   Hit-test del nodo sotto il cursore con `renderer.hitTest`. Nessun nodo sotto
   → rifiuta con motivo.

3. **Paste.** Con un nodo selezionato, `navigator.clipboard.read()` → se c'è un
   `image/*` fra i tipi, allega invece di incollare testo. Va coordinato con
   T10 se quello è già stato fatto.

4. **Trace.** Ogni rifiuto deve dire perché — è la regola §4bis della guida:
   ```ts
   trace.ignored("drop", "no node under cursor");
   trace.ignored("drop", "unsupported mime", { mime });
   trace.ignored("drop", "too large", { bytes });
   ```
   e `trace.applied("drop:image", { bytes, w, h })` quando va a buon fine.

5. **Quota.** Se `adapter.save` fallisce per quota, il toast deve dire che è
   colpa delle immagini e quale documento, non un errore generico.

**Fatto quando.** Test su `imageImport`: mime rifiutati, file troppo grande
rifiutato, immagine grande ridimensionata sotto `MAX_STORED_PX` mantenendo le
proporzioni. Drop su un nodo lo allega ed è undo-abile in **un** Ctrl+Z; drop
sul vuoto non fa nulla e lascia una riga nel trace.

**Non fare.** Non accettare SVG. Non salvare l'originale non ridimensionato.

---

## T14 — Ridimensionare l'immagine (slider + maniglia) · P2 · dipende da T12

**Obiettivo.** Cambiare la dimensione con cui l'immagine è mostrata nel nodo,
senza toccare i byte immagazzinati.

**File.** `src/ui/Inspector.tsx` · `src/render/renderer.ts` ·
`src/ui/CanvasView.tsx` · `src/editor/store.ts`

**Passi.**
1. **Slider nell'Inspector** (il pannello esiste già), visibile solo quando il
   nodo selezionato ha un'immagine. Va da `48` alla larghezza massima del nodo
   e scrive `style.imageWidth`; accanto, la dimensione in px e un pulsante
   «dimensione naturale».
2. **Maniglia sul canvas**, angolo in basso a destra dell'immagine, con
   `hitTestImageResize(state, x, y)` sul modello di `hitTestResize`. Stesso
   stile delle maniglie del nodo (bordo + alone bianco).
3. Proporzioni **sempre bloccate**: `imageWidth` è l'unico valore memorizzato,
   l'altezza si ricava da `att.h / att.w`.
4. **Un solo op alla fine del gesto** — al rilascio dello slider o del drag,
   non a ogni frame: altrimenti un trascinamento riempie la history di 400
   voci e l'undo diventa inutilizzabile.
5. Ingrandendo oltre la risoluzione della variante `display`, l'immagine
   sgrana. Se dà fastidio, genera una seconda variante più grande su richiesta
   dall'originale — **ma non decodificare l'originale per disegnare**.

**Fatto quando.** Slider e maniglia producono lo stesso risultato, le
proporzioni restano costanti, il layout segue, un Ctrl+Z annulla l'intero
gesto, e l'overlay in editing mostra la stessa dimensione.

---

## T15 — Documento portabile con immagini (`.rnode.zip`) · P2 · dipende da T12a

**Obiettivo.** Un singolo file da mandare via mail o chat, che contiene la
mappa e le sue immagini.

**Perché.** Con le immagini fuori dal documento, un `.rnode.json` inviato a
qualcun altro arriva **senza immagini**: i nodi ci sono, i riquadri sono
vuoti. È la conseguenza diretta e inevitabile di T12a, e va chiusa prima che
qualcuno ci sbatta.

**File.** `src/editor/exportBridge.ts` · `src/editor/store.ts` ·
`package.json` (una libreria zip, es. `fflate`)

**Passi.**
1. Formato container, lo stesso schema di `.xmind` e `.docx`:
   ```
   document.json          il documento, identico a oggi
   assets/<id>.<ext>      un file per asset referenziato
   ```
2. **Due modalità di export**, perché il peso cambia di un ordine di grandezza:
   - **completo** — include gli originali: fedele, ma con centinaia di immagini
     può fare centinaia di MB;
   - **compatto** — include solo le varianti `display`: qualche decina di MB,
     visivamente identico a schermo.

   Mostra la dimensione stimata **prima** di generare, non dopo.
3. In import, estrai gli asset dentro l'`AssetStore` e apri il documento. Gli
   id sono hash del contenuto, quindi reimportare due volte lo stesso file
   **non duplica** nulla.
4. `.rnode.json` continua a funzionare per i documenti senza immagini.

**Fatto quando.** Export → import in un profilo browser pulito restituisce la
mappa con tutte le immagini. Un documento senza immagini esporta ancora come
`.rnode.json`. La stima di dimensione è entro il 10% del file prodotto.

**Non fare.** Non riscrivere lo zip a ogni salvataggio: è un formato di
scambio, non il formato di lavoro.

---

## Fuori roadmap (decisione del proprietario)

Non iniziare senza richiesta esplicita:

- **Misura testuale via DOM** (`LineLayout` iniettabile con implementazione
  che misura nel DOM e batcha i reflow). È la soluzione strutturale definitiva
  alla parità, ma oggi l'harness è a 0 divergenze: costo alto, guadagno
  attualmente nullo.
- **Link nei `TextRun`**, liste numerate, allineamento per singolo blocco,
  note dei nodi in rich text, tabelle, RTL. Vedi §12 di
  [RICH_TEXT_EDITOR.md](RICH_TEXT_EDITOR.md).
- Qualunque voce elencata in [AGENT_GUIDE.md](AGENT_GUIDE.md) §5.
