# R-node — guida per chi modifica il codice (umano o AI)

Questo file è il contratto. Se una modifica lo viola, è sbagliata anche se
compila, anche se i test passano, anche se "sembra più pulita".

**Leggi §1, §2 e §6 prima di toccare qualunque file.** Se il task riguarda
testo, layout o editor, leggi anche §3 e §4 — quelle sezioni contengono
errori già commessi e già pagati: ripeterli è puro spreco.

---

## 1. Come si lavora qui

1. **Un task alla volta**, preso da [ROADMAP.md](ROADMAP.md) nell'ordine in cui
   è scritto. Non anticipare task successivi, non accorpare.
2. **Non riprogettare.** Se il task dice "aggiungi una funzione pura X", non
   trasformarlo in un refactoring dell'architettura. Le scelte architetturali
   di §2 non sono in discussione.
3. **Non toccare file fuori dalla lista `File` del task.** Se credi che serva,
   fermati e scrivilo nel messaggio finale invece di farlo.
4. **Definizione di "finito"** (§6): tutti e tre i comandi verdi. Se uno
   fallisce, il task NON è finito — non commentare il test, non alzare la
   soglia, non aggiungere `skip`.
5. **Se non riesci, dillo.** Un task lasciato a metà con una spiegazione onesta
   vale più di un task "chiuso" disattivando un controllo. Non inventare
   risultati di test che non hai eseguito.

### Comandi

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run dev
```

Il dev server serve l'app su `http://localhost:5173/` e l'harness di parità su
`http://localhost:5173/dev/parity.html`.

---

## 2. Invarianti non negoziabili

Ognuna ha una ragione. La ragione serve a impedire che qualcuno la "ottimizzi"
via senza capirla.

| # | Invariante | Perché |
|---|---|---|
| I1 | Un solo `<canvas>`. Mai un nodo DOM o SVG per topic. | Obiettivo dichiarato: 1000+ nodi fluidi. Un div per nodo lo rende impossibile. |
| I2 | Al massimo **un** overlay di editing montato, con `key={editingId}`. | Due overlay = due sorgenti di verità sul testo. |
| I3 | Il nodo in editing **non** viene disegnato dal canvas. | Altrimenti si vede il testo doppio (ghosting). |
| I4 | Lexical **non** ha `HistoryPlugin`. L'undo/redo vive solo nella history dello store. | Due stack di undo si desincronizzano e l'utente perde lavoro. |
| I5 | `node.title === runsToPlain(node.titleRuns)` sempre. | Search, outliner, export e i test leggono la stringa piatta. |
| I6 | Il layout è **dato derivato**: mai nella history, mai in un op. | Un undo deve ripristinare il contenuto, non le coordinate. |
| I7 | Ogni `Op` porta i dati per invertirsi. Nessun op legge lo stato globale per calcolare il proprio inverso. | Serve per l'undo e servirà per la sync (gli op sono già `actorId`/`ts`). |
| I8 | Il round-trip `runs → editor → runs` è **idempotente**. | Non lo era: un titolo derivava a ogni modifica. Test a 3 cicli in `tests/lexicalRuns.test.ts`. |
| I9 | Le costanti condivise hanno **una** definizione, in `src/layout/measure.ts`. | Vedi §3. Duplicarle è il modo classico in cui i due renderer divergono. |
| I10 | La parità editor↔canvas è **misurata**, non dichiarata. | Vedi §3 e §4. |
| I11 | L'id di un asset è lo **SHA-256 dell'originale**, tranne per gli asset ripristinati da un container `.rnode.zip` compact (`putUnderId`): quelli portano `AttachmentInfo.originalLost` e un export `complete` deve dichiararlo. | Il compact non porta gli originali: l'id non può essere ri-derivato. Se nulla lo segna, un export `complete` dichiara originali che non ha. |

### Costanti condivise (I9)

Vivono in `src/layout/measure.ts` e **devono** essere consumate da entrambi i
lati, mai riscritte a mano:

| Costante | Consumata da |
|---|---|
| `LINE_HEIGHT_FACTOR` (1.25) | misura + `line-height` dell'overlay |
| `BLOCK_GAP_FACTOR` (0.6) | misura + CSS var `--rnode-block-gap` |
| `BULLET_WIDTH_EM` (1.2) | misura + CSS var `--rnode-bullet-w` |
| `FONT_STACK` | misura, renderer, `RichEditor` — e deve restare **uguale a `--font`** in `styles.css` |
| `TEXT_INSET` (6) | misura + padding calcolato dell'editable |

Se cambi una di queste, entrambi i lati devono cambiare insieme e l'harness
deve restare a 0 divergenze.

---

## 3. Il contratto di parità (la parte più facile da rompere)

Il canvas **imita** il layout testuale del browser. Ogni imitazione deriva.
Queste sono le regole esatte che i due lati implementano; sono state ricavate
misurando, non leggendo le specifiche CSS.

1. **Altezza di riga** = line box CSS: `max(above) + max(below)` su ogni inline
   box della riga, **strut del blocco incluso**, dove ciascun box contribuisce
   `ascent + half-leading` e `descent + half-leading`, con
   `half-leading = (fontSize × 1.25 − (ascent + descent)) / 2`.
   *Non* è «font-size più grande × 1.25».
2. **Baseline**: calcolata in `wrapRunLines` e messa in `line.baseline`. Il
   renderer la usa e basta — non ricalcolarla lì.
3. **Gap di blocco** = `BLOCK_GAP_FACTOR × LINE_HEIGHT_FACTOR × fontSize del
   nodo`. Viene dallo **strut**, non dall'altezza della riga: in CSS
   `margin-top: calc(.6 * 1.25em)` si risolve sull'`em` del blocco, e la
   dimensione di un heading vive su una `<span>` interna.
4. **Confine di blocco**: un run con `paraGap` apre un blocco **anche senza
   `\n`**. `editorStateToRuns` segna il confine fra root children solo così.
5. **Liste**: il pallino sta in una colonna larga `BULLET_WIDTH_EM em`; il testo
   parte a `depth × bulletW` su **tutte** le righe dell'item. Gli item di lista
   sono **sempre** allineati a sinistra su entrambi i lati.
6. **Spazi finali**: non contano nella larghezza della riga (il CSS li fa
   sporgere fuori dal box).
7. **Token più largo della colonna**: va a capo a metà parola, come
   `overflow-wrap: break-word`.
8. **Riga vuota** fra due blocchi = riga vera. Le righe vuote **in coda** no: un
   `\n` finale chiude un blocco, non è una riga.

### Regola operativa

Se tocchi **uno qualsiasi** di questi file:

```
src/layout/measure.ts
src/render/renderer.ts        (parte testo)
src/ui/lexicalRuns.ts
src/styles.css                (regole .topic-rich-*)
src/ui/RichEditor.tsx
```

devi aprire `http://localhost:5173/dev/parity.html` e verificare
**0 divergenze**. Il risultato è anche su `window.__parity`.

---

## 4. Trappole già pagate

Non re-derivarle. Costano ore ciascuna.

**Misura e DOM**
- **jsdom non fa layout.** `getBoundingClientRect()` restituisce zeri. Qualunque
  test di parità deve girare in un browser vero.
- Il rect di un carattere è l'**inline box** (~19px a 14px), più alto della line
  box (17.5px). Quindi: la sovrapposizione verticale **non** separa le righe
  (usa il ritorno a sinistra) e la sua altezza **non** è l'altezza di riga (usa
  l'avanzamento fra righe).
- Il *top* del glifo sta a distanza diversa dalla line box per ogni corpo:
  confronta le **baseline**, non i top.

**Lexical**
- Un `<p>` dentro un `<li>` con `list-style-position: inside` manda il marker su
  una riga sua: un item da 17.5px ne misura 35. Gli item devono avere **figli
  inline**.
- Il marker nativo del browser (`list-style`) ha larghezza decisa dallo UA:
  nessuna lunghezza CSS la eguaglia, quindi un item andato a capo non può
  allinearsi. Si disegna con `li::before` a larghezza nota.
- `$insertNodes` converte un `HeadingNode` in paragraph a selezione collassata:
  **il paste passa sempre dal percorso runs**, mai dall'import DOM di Lexical.
- `TextNode.setStyle()` **sostituisce** l'intera stringa di stile: usarlo per il
  colore cancella il `font-size`. Usa `$patchStyleText` da `@lexical/selection`.
- Nidificazione strutturale (`ul > li > ul`) e `ListItemNode.getIndent()` sono
  **la stessa** informazione, non due livelli da sommare.
- Il `\n` che chiude una lista non va riemesso: si accumula a ogni round-trip.

**React**
- StrictMode fa mount → cleanup → mount. Il seeding dell'editor e la
  registrazione del listener stanno in **due effetti separati**: un solo effetto
  con guard `seeded` perde il listener.

**Store**
- Il draft di editing è effimero: nessun op, nessuna history, fino al commit.
- Guidare lo store da console mentre un overlay è montato **non** funziona come
  test: il listener dell'overlay riscrive il draft con il proprio contenuto.

---

## 4bis. Segnalare un bug: il tracer

Non descrivere i sintomi a parole. In dev l'app registra le proprie
**decisioni** in un ring buffer (`src/dev/trace.ts`): premi il bottone **⏺**
nella toolbar (o **Ctrl+Shift+D**) nell'istante in cui vedi il problema e
scarichi un JSON con gli ultimi ~500 eventi. Quello si allega, non la
descrizione. Entrambi catturano **e poi** azzerano — mai prima: quando ci
arrivi il baco è già successo.

Cosa contiene, e perché conta:

| Evento | A cosa risponde |
|---|---|
| `input … outcome: "ignored", reason` | «perché non è successo niente?» — distingue un baco da una guardia deliberata |
| `render … visible/nodes, relsDrawn/rels, linksDrawn/links` | «l'ho disegnato ma non si vede» **oppure** «non l'ho proprio disegnato»: sono due bug diversi |
| `render … textHits/textMisses` | regressioni della cache del testo |
| `op`, `layout` con durata | quale sottosistema è rallentato |
| `invariant`, `error` | arrivano con i venti eventi che li hanno preceduti |

### Leggere una cattura

Il JSON ha un campo `README` che si spiega da solo, poi `counts` e `events` in
ordine cronologico. `t` sono i millisecondi dal caricamento della pagina, `n` è
quanti eventi identici consecutivi sono stati fusi in quella voce.

Ordine di lettura consigliato:

1. **`input` con `outcome: "ignored"`** — se il sintomo è «non succede niente»,
   la risposta è quasi sempre qui, con il motivo già scritto.
2. **`error` e `invariant`** — arrivano con la loro cronologia davanti.
3. **`render`** — è la voce che separa due bug che sembrano identici:
   - `linksDrawn < links` → il renderer **non ha disegnato**: bug di culling;
   - `linksDrawn === links` ma l'utente non vede nulla → ha disegnato e non si
     vede: bug di pittura (colore, spessore sub-pixel, ordine di disegno).
   Lo stesso vale per `relsDrawn/rels` e `visible/nodes`.
4. **`op` e `layout`** con le durate, se il sintomo è lentezza.

Esempio — un gesto scartato da una guardia (forma del log):

```
INPUT wheel:pan applied x1
INPUT wheel:zoom applied x1
INPUT wheel ignored(reason) x1     ← la risposta
```

Nota: la rotella NON è più bloccata durante l'editing — il guard `editing` sul
wheel è stato rimosso (l'overlay deriva la sua posizione dalla camera dello
store a ogni render, quindi pan/zoom resta incollato al nodo).

### Regola per chi scrive codice

**Ogni `return` anticipato in un handler di input deve dire perché.**

```ts
if (someGuard) return trace.ignored("pointerdown", "some-guard");
```

Un `return` muto rende un comportamento voluto indistinguibile da un difetto,
e nessuna segnalazione a parole può colmare quella differenza. Stessa regola
per il renderer: se salti qualcosa, conta quanto ne hai saltato.

Il tracer è disattivato nelle build di produzione: ogni chiamata esce su un
booleano. Istruzioni per catturare: [README](../README.md#reporting-a-bug).

---

## 5. Cosa NON fare (già fatto o inesistente)

Verificato nel codice. Se una lista di miglioramenti propone questi, salta.

| Proposta ricorrente | Realtà |
|---|---|
| «Aggiungere una cache al text measuring» | **Esiste già**: `createCanvasTextMeasurer` ha una `Map` con chiave `weight\|italic\|size\|family\|text` (cap 20k) più una `metricsCache` per ascent/descent — `src/layout/measure.ts`. |
| «Rendere atomiche le transazioni nella history» | **Già atomiche**: `execOps` chiama `history.push(ops, inverses)` una volta per batch e `push` crea **una** `HistoryEntry` — `src/core/history.ts`. Un gesto multi-op occupa già uno slot di undo. |
| «Risolvere la race fra `layoutTimer` e `saveTimer`» | **`saveTimer` non esiste.** Il salvataggio è manuale (Ctrl+S). Esiste solo `layoutTimer` (30ms). |
| «Ottimizzare `mapBounds`» | Reale ma inutile: **un solo chiamante**, `fitToScreen`. Non è un hot path. |
| «Il canvas somma le larghezze dei token e accumula errore» | **Ipotesi testata e smentita.** Caso `real-topic-22px` nell'harness: 9/9 righe, altezza identica. Le righe di troppo venivano dal round-trip non idempotente. |

---

## 6. Definizione di "finito"

Un task è chiuso quando **tutti** questi sono veri:

1. `npm run typecheck` → 0 errori.
2. `npm test` → tutti verdi. Nessun test nuovo `skip`, nessuna soglia alzata
   per farlo passare.
3. Se hai toccato i file di §3: harness a **0 divergenze**.
4. Hai aggiunto almeno un test che **fallisce senza la tua modifica**. Se non
   sai scriverlo, probabilmente non hai capito il task.
5. Non hai modificato file fuori dalla lista `File` del task.

### Commit

Un commit per task. Messaggio in inglese, imperativo, che spiega **perché** —
non cosa (il diff dice già cosa):

```
Add runtime invariant checker for sheet topology

applyOp mutates the tree in place, so a wrong parentId silently corrupts
the in-memory state and only surfaces much later as an unexplained crash.
validateSheet turns that into an immediate, named failure.
```

---

## 7. Mappa rapida dei file

```
src/core/types.ts          TextRun, MindNode, Style, Sheet — schema, unica fonte
src/core/text.ts           helper runs: normalizeRuns, runsToPlain, nodeRuns…
src/core/ops.ts            op system: applyWithInverse
src/core/history.ts        undo/redo, un HistoryEntry per batch
src/core/doc.ts            DocumentModel: accesso ai nodi, walks
src/editor/store.ts        EditorStore: execOps, draft, commit, camera, save
src/layout/measure.ts      wrapRunLines, line box CSS, costanti condivise
src/layout/mindmap.ts      layoutSheet, applyLayout
src/render/renderer.ts     drawNode, renderTextBitmap, nodeColors, hit-test
src/ui/RichEditor.tsx      overlay Lexical (unico), toolbar, tasti, paste
src/ui/lexicalRuns.ts      bridge editor ↔ runs
src/ui/pasteSanitizer.ts   sanitizeHtml / htmlToRuns (Word, Draw.io, web)
src/ui/CanvasView.tsx      posizionamento overlay, pan, resize handle
dev/parity.ts              harness di parità (§3)
```

Documenti: [ARCHITECTURE.md](ARCHITECTURE.md) (struttura e fasi) ·
[RICH_TEXT_EDITOR.md](RICH_TEXT_EDITOR.md) (editor rich text in dettaglio) ·
[ROADMAP.md](ROADMAP.md) (cosa fare, in ordine).
