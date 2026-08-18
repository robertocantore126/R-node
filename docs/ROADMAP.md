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

## T1 — Invariant checker della topologia · P0 · ✅ FATTO

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

**Chiuso da** `de6c6a2` — *Add a runtime invariant checker for sheet topology*.
14 test in `tests/validate.test.ts`; il checker gira su ogni op dei test
esistenti senza far emergere alcuna violazione preesistente.

Due punti dove l'implementazione va **oltre la lettera** dei passi qui sopra.
Non sono sviste: chi li "semplifica" riporta indietro due bug.

- **I nodi `floating` fanno da radice per la raggiungibilità**, non solo da
  eccezione al controllo. Il passo 2 esentava i floating ma non i loro
  discendenti: camminando solo da `rootNodeId`, un figlio droppato su un topic
  floating — documento legale, vedi `dropAt(…, "child", …)` — sarebbe stato
  segnalato come orfano.
- **Il controllo sui cicli come scritto al passo 2 è irraggiungibile.** Con la
  coerenza parent/children verificata prima, un ciclo raggiungibile dalla
  radice è impossibile: richiederebbe due `parentId` diversi per lo stesso
  nodo. Un ciclo reale è quindi sempre *scollegato* dalla radice, e senza un
  controllo dedicato verrebbe riportato come "orfano". `validateSheet` risale
  la catena dei parent di ogni nodo irraggiungibile: se si chiude è un ciclo,
  se finisce a `null` è un orfano, e il messaggio dice quale.

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

## T21 — Quattro cose che il codice fa e nessuno guarda · P1 · ✅ FATTO

Emerse da una revisione del **codice** (non dei documenti) il 2026-08-12, e
verificate una per una. Sono un gruppo coerente: funzionalità che esistono ma
non vengono invocate, o che non si difendono da sole.

**File**: `src/persist/assets.ts` · `src/editor/store.ts` · `src/ui/Palette.tsx`
· `src/render/renderer.ts` · i rispettivi test.

### A — `collectOrphans` non lo chiama nessuno

Esiste, è testato, e nel codice compare **solo dentro commenti** che lo
descrivono come «the GC». Nessun comando, nessun pulsante. Quindi gli asset
orfani si accumulano per sempre: cancelli un nodo con immagine e i byte restano
nel `.rnode`, che **cresce e non torna mai indietro**. T12a lo aveva specificato
come comando esplicito; il comando non è mai stato collegato.

- [x] `AssetStore.size(id): Promise<number>` — somma dei byte di tutti i livelli
      (in SQLite è una `SUM(length(bytes))`, quindi esatta e non stimata)
- [x] comando nella palette: esegue `collectOrphans`, mostra **quante schede,
      quanti blob e quanti byte** si recuperano, e chiede conferma
- [x] le **schede** orfane si rimuovono con un op (modificano il documento,
      quindi undo-abili); i **blob** si cancellano dopo, e questo non è undo-abile

> **La conferma deve dirlo.** Dopo la cancellazione dei blob, un undo
> ripristinerebbe le schede senza i byte. La finestra deve dichiarare che
> l'operazione non è annullabile — come fa qualunque comando di purge.

### B — `saveNow` non ha una guardia

Non esiste alcun `isSaving`. Due Ctrl+S rapidi si sovrappongono: su desktop
significa due selettori di file, o una scrittura mentre un'altra sta ancora
copiando asset.

- [x] coda a **una posizione**: se arriva una richiesta mentre un salvataggio
      è in corso, segnala «in attesa» e riesegui **una** volta alla fine

> **Non basta un return anticipato.** Scartare la seconda richiesta perde le
> modifiche fatte fra l'inizio del primo salvataggio e la seconda pressione:
> l'utente vede «Saved» e ha su disco una versione vecchia.

### C — `adoptFile` salta in silenzio

`if (!meta || !original || !large || !small) continue; // referenced but absent`

Salvi con nome, un asset manca, e il file nuovo referenzia un id che non
contiene — senza dire niente. Saltare è giusto (far fallire l'intero
salvataggio per un'immagine sarebbe peggio); **il silenzio no**.

- [x] `adoptFile` restituisce quanti asset non ha potuto copiare
- [x] il chiamante lo riporta all'utente con il numero

### D — La cache del testo si sfratta per numero, non per byte

`textCache` ha un limite di **5000 voci** con rimozione FIFO. Ma le bitmap del
testo hanno dimensioni molto diverse (larghezza del nodo × altezza × risoluzione²):
5000 canvas offscreen possono valere centinaia di MB, e il limite non se ne
accorge. È la stessa critica che ha portato la cache delle immagini a un budget
in byte — la cache del testo è rimasta indietro.

- [x] budget in byte (`canvas.width * canvas.height * 4`), stessa forma di
      `IMAGE_BUDGET`
- [x] **LRU vera**: `delete` + `set` sull'hit, come già fa `imageCache`
      (oggi la FIFO può sfrattare il nodo che stai guardando)

> Tocca le stesse righe di **T6** (la chiave calcolata con `JSON.stringify` a
> ogni frame). Conviene fare T6 subito dopo, non prima: così la chiave nuova
> nasce già dentro la politica di sfratto nuova.

### Fatto quando

- Un test verifica che dopo aver cancellato un nodo con immagine,
  `collectOrphans` riporta quell'asset, e che il comando ne recupera i byte.
- Un test verifica che due `saveNow` concorrenti producono **due** scritture,
  la seconda con il contenuto più recente.
- Un test verifica che `adoptFile` riporta il numero di asset saltati.
- Un test verifica che la `textCache` sfratta al superamento del budget in byte
  e che un hit rinfresca la ricenza.
- `npm run typecheck` e `npm test` verdi.

**Chiuso da** `5361e4e` (2026-08-12) — *Wire up orphan GC, guard overlapping
saves, report skipped assets, bound the text cache by bytes*. I test richiesti
sono in `store.test.ts` («reports and recovers an asset orphaned by deleting
its node», «two concurrent saveNow run the queue ONCE more, with the most
recent content»), `tauriAdapter.test.ts` («adoptFile reports how many
referenced assets it could not copy») e `renderer.test.ts` («evicts by byte
budget and refreshes recency on hit»).

> Questa voce è rimasta con le caselle vuote per due giorni **dopo** essere
> stata implementata, ed è servita nel frattempo da base per chiedere di
> rifare il lavoro da zero. È esattamente il caso di AGENT_GUIDE §5: chiudere
> la voce fa parte del task.

---

## T22 — Code node di sola lettura · P2 · 🧪 SPIKE

**Obiettivo.** Un nodo che mostra codice con evidenziazione della sintassi, non
modificabile dall'interfaccia: si vede, si copia, si cancella. Nato da una
richiesta esplicita del proprietario, da tenere o buttare secondo i criteri in
fondo.

**Perché.** Incollare codice oggi perde gli a capo (i blocchi annidati non
producono confini) e non esiste un monospace per run. Il risultato è codice su
una riga sola nel font del nodo.

### Decisioni già prese, con la ragione

Non riaprirle senza un motivo nuovo: ognuna evita un costo misurato.

- **Sola lettura, e non è una rinuncia.** Il §3 esiste perché un nodo può
  aprire l'overlay Lexical: sono due renderer che devono concordare. Un nodo
  che non si edita non ha un secondo renderer, quindi può avere whitespace
  preservato e niente a-capo automatico **senza toccare il contratto di
  parità**. È ciò che rende la feature economica.
- **Il documento tiene sorgente + linguaggio; i colori sono dato derivato**,
  ricalcolati al disegno (stesso principio di I6 sul layout). Conservare i
  colori incollati da VS Code significa salvare la palette di un tema scuro:
  sullo stesso nodo in tema chiaro diventa illeggibile, per sempre.
- **Nessun nuovo `NodeType`.** Quell'enum guida topologia e layout
  (`validateSheet` tratta `floating` a parte, i placer dispongono per tipo). Un
  code node è una variante di **presentazione**: sta in `Style`, senza
  migrazione dello schema e senza toccare il validatore.
- **Tokenizzatore minimo interno per lo spike**, nessuna dipendenza. Rimanda la
  scelta fra Shiki (fedele a VS Code, centinaia di KB con WASM) e Prism
  (~2KB + grammatiche) a dopo aver visto se la feature vale. Se resta, va
  caricato con `import()` dinamico: chi non usa code node non scarica nulla.

### Il costo da misurare, non da assumere

Il budget della cache testo **non** è un tetto al numero di nodi: solo i nodi
visibili vengono rasterizzati (`renderer.ts:337`) e la risoluzione segue lo zoom
(`renderer.ts:844`), quindi il totale vivo è legato all'area dello schermo
(~7,75 MB per schermata a 1920×1009) e i 64 MB valgono ~8 schermate. Un code
node occupa area come qualunque altra cosa: **non è quello il problema.**

Il costo reale è **T6**: `textCacheKey` serializza `n.titleRuns` con
`JSON.stringify` a ogni frame per ogni nodo visibile. Un topic ha 1–3 run, un
code node evidenziato ne ha uno per token — centinaia — e quel costo **non si
riduce con lo zoom**, perché dipende dai run e non dai pixel. Lo spike deve
misurarlo: se è il collo di bottiglia, T6 diventa un prerequisito.

**File.** `src/core/types.ts` · `src/core/codeHighlight.ts` (nuovo) ·
`src/render/theme.ts` · `src/layout/measure.ts` · `src/render/renderer.ts` ·
`src/editor/store.ts` · `src/ui/CanvasView.tsx` · `src/ui/Palette.tsx` ·
i rispettivi test.

Brief operativo per la sessione di implementazione: [T22-HANDOFF.md](../T22-HANDOFF.md)
(usa e getta — va cancellato nel commit che chiude il task).

**Passi.**
1. `Style.code?: { lang: string }` — il sorgente vive in `node.title` (I5 resta
   vera: `title === runsToPlain(titleRuns)`, con `titleRuns` in testo piatto).
2. `codeHighlight.ts`: funzione pura `tokenize(source, lang): TextRun[]`, con
   cache per `(source, lang)`. I colori vengono dal tema, non dalla sorgente.
3. Misura: percorso senza wrap, spezzato su `\n`, whitespace iniziale
   preservato. **Come modalità separata**, mai cambiando il default di
   `wrapRunLines`: i 20 casi dell'harness ci vivono sopra.
4. Renderer: cornice a finestra (fondo, barra del titolo, tre glifi) e testo per
   token. Il colore per run il canvas lo disegna già (`renderer.ts:1082`).
5. Sola lettura: `startEdit`, `typeToEdit` e il doppio click rifiutano un code
   node **e lo dicono** (§4bis). Delete, copia e drag restano normali.
6. Creazione: comando in palette che costruisce il nodo dal contenuto della
   clipboard.

**Fatto quando.**
- Un code node incollato mostra righe separate, indentazione preservata e
  colori per token; il doppio click non apre nessun overlay e traccia il motivo.
- Un test misura il costo per frame con N code node visibili e lo confronta con
  N topic normali: il numero decide se T6 è un prerequisito.
- `npm test` e `npm run typecheck` verdi; harness a 0 divergenze (si tocca
  `measure.ts`).

**Si tiene se.** Il codice incollato è leggibile senza ritocchi manuali e il
costo per frame con 10 code node visibili resta sotto quello di 100 topic
normali. Altrimenti si rimuove il branch: è uno spike, non un impegno.

**Non fare.** Non cambiare `wrapRunLines` per tutti. Non salvare i colori nel
documento. Non aggiungere una dipendenza di evidenziazione in questo spike.

---

## T23 — Libreria di forme componibili · P2

**Obiettivo.** Un pannello nella metà bassa della colonna destra, sotto
l'Inspector: un bottone apre una scheda dove si incolla un sottografo, gli si dà
un nome e resta salvato. Le forme salvate si trascinano sulla mappa e, **solo se
il rilascio cade su un topic**, vengono inserite come suo figlio.

**Perché.** Strutture prefabbricate (un ciclo a 3, un anello a 5, l'Albero della
Vita) oggi si costruiscono a mano ogni volta. E il formato per descriverle
esiste già.

### La decisione che rende la feature piccola

Una forma **non** è un nodo speciale: sono N topic nativi più le loro
`Relationship`. Un "super-nodo" opaco sarebbe invisibile a ricerca, outliner,
export, `validateSheet` e undo — cioè per costruzione la stessa classe di
difetto di BUG-002, moltiplicata per ogni consumatore. Come N nodi, invece,
tutto funziona già e la forma resta modificabile dopo l'inserimento.

Di conseguenza **non serve nessuna DSL nuova**: il formato è quello che
`copySelection` già scrive (`{ app: "r-node", payload: { rootId, nodes,
relationships } }`) e che `paste` già istanzia rimappando gli id. L'utente può
disegnare una forma a mano, copiarla e incollarla nella libreria; un LLM a cui
si chiede una forma emette lo stesso identico oggetto.

### Cosa può contenere una forma (deciso)

`saveShape` normalizza il payload prima di salvarlo. Quattro regole, ognuna con
la ragione che l'ha prodotta:

| Regola | Perché |
|---|---|
| **Via i colori, resta la forma.** Si tengono `shape`, bordo, dimensioni, font; si cancellano `fill`, `stroke`, `textColor` e il `color` di **ogni run** di `titleRuns` e di ogni relazione | Un colore salvato prima o poi atterra su un tema dove non si legge, e resta lì per sempre. Stessa conclusione di T22 sui code topic. La forma eredita la palette di ramo della mappa che la ospita |
| **Geometria rigida.** `position.manual = true` su tutti i nodi | Un triangolo resta un triangolo: `mindmap.ts` tratta i nodi manuali come ancore e sposta gli *altri* rami attorno |
| **Immagini rifiutate** al salvataggio, con il topic nominato | I byte vivono in un `AssetStore` per documento con chiave SHA-256: il template porterebbe il riferimento senza i byte, e nella mappa di destinazione sarebbe un buco. Meglio rifiutare subito che al drop |
| **Testi conservati** (`title` + `titleRuns`) | Un Albero della Vita arriva con i nomi scritti: è il motivo per cui lo salvi. Togliere i colori dai run non tocca il testo, quindi I5 regge |

Conseguenze derivate, non decisioni separate: si scartano `task`, `labels` e
`markers` (appartengono a una mappa, non a una forma), `collapsed` va a false,
`notes` resta perché è contenuto.

**File.** `src/editor/shapeLibrary.ts` (nuovo) · `src/ui/ShapeLibrary.tsx`
(nuovo) · `src/App.tsx` · `src/styles.css` · `src/ui/CanvasView.tsx` ·
`src/editor/store.ts` · i rispettivi test.

**Fatto quando.**
- Una forma incollata, nominata e salvata sopravvive al reload.
- Trascinata su un topic diventa suo figlio con la geometria intatta; rilasciata
  sul vuoto viene rifiutata **con il motivo tracciato**.
- Un solo Ctrl+Z rimuove l'intera forma.
- Un template malformato viene rifiutato da `saveShape`, non al momento del drop.
- L'altezza di `.canvas-area` **non cambia** quando il pannello si riempie e
  scorre — misurata, non guardata: è la colonna che ha già avuto quel baco
  (`cb5b5df`).

**Non fare.** Nessun secondo formato, nessun secondo rimappatore di id, nessun
super-nodo, template fuori dal documento (è una libreria dell'utente, come i
colori recenti).

### Il pannello ospita due tipi, non uno

Le forme salvate si dividono in **structure node** (questo task: N topic nativi
con shape di base, che si adattano al testo) e **shape node** (T24: un topic
solo, silhouette custom, dimensione fissa). Nel pannello sono due sezioni con
icone distinte, e accanto al nome di ciascun tipo c'è un'icona **copia** che
mette negli appunti il prompt per generarne uno con un LLM.

I prompt vivono in `src/editor/shapePrompts.ts` (`STRUCTURE_NODE_PROMPT`,
`SHAPE_NODE_PROMPT`), non in un documento: il bottone e la documentazione così
non possono divergere.

Vincolo aggiuntivo su questo tipo: le relazioni di uno structure node sono
**segmenti dritti**. `saveShape` impone `connector: "straight"` su ognuna — il
campo e il disegno arrivano da T24, che è quindi un prerequisito per il rendering
corretto (la libreria funziona anche prima, con gli archi curvi di oggi).



---

## T24 — Special shape node · P2

**Obiettivo.** Un topic disegnato come **artwork multicolore**: una lista di path
(`Style.shapeParts`), dipinti in ordine, ciascuno col proprio colore — mezzaluna,
scudo bicolore, ingranaggio — invece di una delle nove `TopicShape` predefinite.
**Dimensione fissa**, etichetta **modificabile** come qualunque altro topic.

**Perché qui i colori si salvano, quando in tutto il resto del progetto no.**
T22 e T23 li scartano entrambi, e la ragione era sempre la stessa: quel colore
doveva contrastare con **qualcosa che possiede il tema** — il testo sul fill del
nodo — quindi salvarlo fissava metà di un accoppiamento e prima o poi produceva
qualcosa di illeggibile. I colori di una forma contrastano **fra loro, dentro la
forma**: una luna gialla è gialla su mappa chiara e su mappa scura. Qui il colore
è contenuto, non presentazione. Una parte può comunque scegliere di seguire il
tema nominando un token (`accent`, `surface`, `text`, `muted`) invece di un hex.

**Perché la dimensione è fissa.** È la decisione che rende il problema
trattabile: un nodo che non cresce non deve mai negoziare il proprio contorno
con un'etichetta che si allunga. E non serve costruirla — `measure.ts:708`
salta già l'intera misurazione quando `width` e `height` sono entrambe presenti.

**Perché il testo esce oggi** (vedi la mezzaluna di prova): `measure.ts:745`
manda a capo sulla **bounding box**, non sull'area interna. Il canvas vede un
rettangolo, non una falce. Il rimedio è un `shapeTextBox`, e va espresso come
**inset** attraverso `textInsets` — l'helper che già mettono d'accordo misura,
renderer, overlay e harness (`4244928`). Una seconda strada riprodurrebbe il
baco che quell'helper esiste per impedire.

**Il costo da accettare.** L'etichetta resta editabile, quindi l'overlay Lexical
è un secondo renderer sullo stesso testo: **il §3 si applica in pieno** e serve
un caso nuovo nell'harness, come i quattro aggiunti per le immagini.

**In regalo.** L'export SVG diventa più semplice (il path è già SVG) e l'hit-test
può diventare esatto con `isPointInPath`: un click nell'incavo della mezzaluna
correttamente non la seleziona.

**Include anche** le relazioni a segmento dritto che T23 richiede:
`Relationship.connector?: ConnectorStyle`, riusando l'union già dichiarata per
`StructureConfig`. Il troncamento al bordo del nodo va accanto a
`bezierEnterRect`/`bezierExitRect` in `measure.ts` — sono elencati in §2/I9 come
condivisi fra renderer ed export SVG, e due copie divergono sulle punte delle
frecce.

**Fatto quando.** Harness a 0 divergenze con un caso per gli inset di uno shape
node; un `textBox` che esce dal path viene rifiutato (verificato con
`isPointInPath`, non creduto); un nodo shape mantiene la sua dimensione
qualunque sia il titolo.



---

## T25 — Gallery node (tier list) · P2 · ✅ FATTO

**Obiettivo.** Un topic il cui corpo è una **griglia ordinata di immagini con
didascalia**: una riga di tier list, un mood board, un cast. Il titolo resta
sopra la griglia ed è un titolo normale.

**Perché è `Style.gallery` e non un `NodeType`.** Stessa regola già scritta in
`types.ts` per T22: quell'enum governa la topologia e il layout dell'albero, e
una griglia di immagini dentro una scatola non cambia né l'una né l'altro. È
una **variante di presentazione**, come `code` e `shapeParts`.

**Perché non è "più slot immagine".** `ImageSlot` nomina un **bordo** della
scatola e i bordi sono quattro per costruzione: il numero è il punto, e ogni
consumatore — hit-test, drag & drop, maniglia di resize, inset dell'overlay —
è scritto su quei quattro nomi. Una gallery non ha bordo e non ha numero
fisso. Le due cose convivono: un topic gallery può avere anche immagini laterali.

**Le celle hanno tutte la stessa forma.** `cellW` + `aspect` (default quadrato);
ogni immagine è ritagliata al centro per riempire la cella (`coverCrop`), mai
letterboxata. È l'unica proprietà che rende leggibile una griglia: ritratti,
screenshot e banner alle loro proporzioni native sono una pila irregolare.

**Le didascalie sono stringhe piatte, non `TextRun[]`, e si scrivono
nell'Inspector.** Una didascalia ricca vorrebbe l'overlay Lexical sopra di sé,
cioè un **secondo renderer sullo stesso testo**, cioè il contratto di parità
del §3 per intero — per un'etichetta di una riga a corpo fisso. Tenuta fuori
dal canvas-editing, la parità non la tocca mai. La didascalia sta sulla
**cella**, non su `AttachmentInfo`: quella scheda è per-ASSET ed è
content-addressed, quindi la stessa figura in due tier la rinominerebbe in
entrambi.

**La trappola pagata.** `nodeImageIds` è la radice del **GC degli asset**
(`referencedAssetIds`): un id che non compare lì è un id che nessun nodo
reclama, e il collector cancella i byte. È anche ciò che decide quali bitmap
restano in cache nel renderer. Entrambi i guasti sono silenziosi e arrivano
molto dopo la modifica che li causa.

**Gesti.** Trascinare una cella la sposta **tra tier** e **dentro il tier**
(stesso gesto, stesso metodo: per il documento il bersaglio è solo un nodo che
può coincidere con la sorgente). Un file rilasciato su un topic-gallery entra
nella griglia al varco sotto il cursore; su un topic senza griglia vale il
comportamento a slot di prima. Le mosse cross-nodo emettono **due `setStyle` in
UN batch**, o un Ctrl+Z lascerebbe la figura in nessuno dei due tier.

**Fatto quando.** Le celle sono identiche qualunque siano le sorgenti; il GC
vede le immagini della griglia; un undo riporta una mossa cross-tier in un solo
passo; canvas, SVG e PDF leggono `positionedImageSlots` e `insets` (nessuno dei
tre ricalcola i blocchi dagli slot). Verificato in `tests/gallery.test.ts` e
nell'app reale.

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
