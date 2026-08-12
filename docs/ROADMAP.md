# R-node — roadmap operativa

Task in ordine di esecuzione. **Fai un task alla volta, nell'ordine scritto.**
Prima di iniziare leggi [AGENT_GUIDE.md](AGENT_GUIDE.md) §1, §2, §6.

Ogni task è chiuso solo quando la sua sezione **Fatto quando** è interamente
vera. Se non ci riesci, fermati e spiega: non disattivare test, non alzare
soglie, non allargare lo scope.

Legenda: **P0** = blocca la qualità del resto · **P1** = alto valore ·
**P2** = funzionalità mancanti.

Stato dei task: **✅ FATTO** = chiuso · **⚠️ PARZIALE** = obiettivo centrato
solo in parte (la sezione dice cosa resta) · senza marcatore = aperto.

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

**Perché.** `src/core/types.ts` dichiara `callouts`, `zones`, `comments` come
`unknown[]`. `unknown[]` accetta qualunque cosa in scrittura: è un invito a
inventare schemi incoerenti. (`boundaries`, `summaries` e `labels` hanno già
tipi veri: sono stati implementati da altre feature.)

**File.** `src/core/types.ts` · eventuali punti che li inizializzano.

**Passi.**
1. Cambia a `never[]` i tre campi rimasti: `callouts`, `zones`, `comments`.
2. Aggiungi sopra un commento: sono feature di Fase 2–3, si tipizzano quando si
   progettano, e `never[]` costringe a una decisione esplicita.

**Fatto quando.** `npm run typecheck` verde (gli array vuoti `[]` restano
validi) e `npm test` verde.

**Non fare.** **Non inventare** `CalloutInfo`, `ZoneInfo` ecc. Progettare ora
schemi per feature non implementate è esattamente il debito che questo task
evita.

---

## T5 — Budget di performance assertivi · P1 · ⚠️ PARZIALE

> **Stato verificato il 2026-08-12.** Le asserzioni esistono in
> `tests/perf.test.ts` ma **non fanno il lavoro che questo task definisce**.
> Misurato a 10.000 nodi: `applyOps` 45,5 ms contro una soglia di 10.000 ms
> (**220× di margine**), `layout` 163,8 ms contro 5.000 (**30×**), `writeback`
> 157,8 ms contro 5.000 (**32×**).
>
> Il task chiede soglie che catturino una regressione algoritmica da 10×. Con
> 30× di margine `layout` può passare da 164 ms a 1,6 secondi — inaccettabile
> per l'utente — e il test resta verde. Sono controlli contro il blocco totale,
> non contro le regressioni.
>
> **E l'approccio va ripensato, non ritarato.** Quelle soglie hanno prodotto un
> fallimento intermittente pur essendo a 30× dal valore reale: misurare tempo
> di parete dentro un runner parallelo non è affidabile a *nessuna* soglia.
> Le strade sono: eseguire la suite perf in seriale, oppure asserire su
> grandezze relative (ms/op, rapporto fra taglie) invece che su millisecondi
> assoluti.

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

> **Stato: ⚠️ PARZIALE.** Sottolineato è in toolbar (pulsante U) e il barrato
> sopravvive al round-trip nel modello, ma la toolbar non ha ancora liste né
> selettore heading, e il barrato non è applicabile dall'interfaccia. Resta da
> fare la parte del task qui sotto che non è barrata.

**Obiettivo.** Rendere raggiungibili dall'interfaccia le formattazioni che il
modello già supporta.

**Perché.** `TextRun` supporta `underline`, `fontSize` (heading) e `listIndent`,
il canvas li disegna e la sanitizzazione li produce — ma la toolbar ha solo
B / I / U / colore / clear. Heading e liste si ottengono **solo incollandoli**.

**File.** `src/ui/RichEditor.tsx` · `src/styles.css`

**Passi.**
1. Aggiungi: ~~sottolineato~~ (fatto) e barrato (`FORMAT_TEXT_COMMAND` con
   `"underline"` / `"strikethrough"`), lista puntata (`INSERT_UNORDERED_LIST_COMMAND` da
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

## T10 — Paste ricco su nodo selezionato · P2 · ⚠️ PARZIALE

> **Stato verificato**: l'incolla di **immagini** su un nodo selezionato è
> chiuso (`clipboard.read()` in `store.ts`, arrivato con T13-2). Resta aperto
> l'incolla di **testo ricco**: `store.paste()` legge ancora solo `readText()`,
> quindi l'HTML di Word su un nodo selezionato perde la formattazione.

> **Stato: ✅ FATTO.** `store.paste` usa `navigator.clipboard.read()` e
> instrada `text/html` in `sanitizeHtml → htmlToRuns`, con fallback a testo
> piatto dove l'API non è disponibile (`src/editor/store.ts`).

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

## Retrospettiva — immagini e desktop (T0, T12a–T20) · ✅ FATTO

Questa voce sostituisce i task T0 e T12a–T15 della roadmap e i passi T16–T20
del piano di esecuzione: l'intero programma immagini + desktop è implementato
e spedito.

- **T0 — bring-up di Tauri.** La shell desktop compila e funziona: Rust e la
  CLI Tauri sono installati, `cargo tauri dev` avvia l'app e un documento
  sopravvive a chiusura e riapertura.
- **T12a/T12b — archivio degli asset.** Store indirizzato per contenuto
  (SHA-256) dietro l'interfaccia `AssetStore`, con le correzioni di T12b: GC
  con radici solo nei nodi, `put` atomico in una transazione, `onblocked`
  gestito. Implementazione IndexedDB per il web, SQLite su desktop.
- **T12 — immagini nel modello.** `AttachmentInfo` + `Style.imageWidth`,
  misura con `imageResolver` passato da layout, renderer e overlay,
  disegno con cache bitmap a budget di byte (`createImageBitmap` a livello
  corrispondente allo zoom, tetto 1024px, sfratto LRU con `close()`), spazio
  riservato nell'overlay, op `setNodeImage` con inverso.
- **T13 — ingestione.** Pipeline di import in **Web Worker** (originale
  intatto + livelli 1024/256 da una sola lettura), drop sul nodo e paste,
  allowlist dei formati, rifiuti tracciati.
- **T14 — ridimensionamento.** Slider nell'Inspector e maniglia sul canvas,
  proporzioni bloccate, un solo op per gesto.
- **T15 — documento portabile.** `.rnode.zip` (completo = originali, compatto
  = soli livelli display) con stima di dimensione prima della generazione e
  import senza duplicati (id = hash del contenuto).
- **T16–T20 — desktop definitivo.** Asset su filesystem via comandi Rust
  (T16); misura della memoria superata: picco **17,4 MB** di bitmap contro un
  budget di 128 MB nel caso moodboard, 306 bitmap in cache (T17); i quattro
  difetti emersi dalla revisione chiusi, incluso `originalLost` per gli
  import compact (T18); documento come cartella `document.json` + assets
  (T19); e il formato attuale — **un solo file `.rnode` (SQLite)** con
  documento e immagini in una transazione, senza file `-wal`/`-shm` (T20).

Decisioni e numeri: [ADR-001 §12](ADR-001-immagini-e-piattaforma.md).
Dettagli di esecuzione (archiviati): [archive/PIANO-IMMAGINI.md](archive/PIANO-IMMAGINI.md).

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
