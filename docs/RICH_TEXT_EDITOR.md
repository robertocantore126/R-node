# R-node — Editor rich text: come funziona

Questo documento spiega l'architettura **ibrida scoped** dell'editing di testo
di R-node: come il testo dei nodi viene modellato, misurato, disegnato sul
canvas e modificato tramite l'overlay Lexical, e come i due mondi (browser e
canvas) restano allineati.

> Stato: in sviluppo attivo. La parità geometrica fra editor e canvas è
> misurata, non asserita: vedi §7bis, oggi 16 casi su 16 allineati. Le sezioni
> *Limitazioni note* elencano i punti ancora aperti.

---

## 1. Panoramica: l'architettura ibrida

R-node disegna tutta la mappa su **un solo `<canvas>` 2D** (mai un DOM o SVG
per nodo). Il testo dei nodi è rich text, quindi servono due mondi:

| Aspetto | Dove vive |
|---|---|
| Modello dati | `TextRun[]` nello store (nativo, serializzabile) |
| Rendering statico | canvas 2D, con **bitmap cache per nodo** |
| Editing | **un solo** overlay HTML (Lexical) alla volta |
| Misura | `wrapRunLines` condivisa tra layout e renderer |
| Undo/redo | una sola history (Pattern Command nello store) |

Scelte architetturali esplicite (non ridiscutibili):
- **Lexical non ha la propria history**: è un puro generatore di draft.
- **Mai più di un overlay** montato: CanvasView lo chiava con `key={editingId}`.
- Il nodo in editing **non viene disegnato** dal canvas (niente ghosting).
- Il pan/zoom è **bloccato durante l'editing** (l'overlay non deve andare fuori
  sincrono).

---

## 2. Il modello dati: `TextRun[]`

```ts
export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;      // esadecimale; se assente eredita il colore del tema
  fontSize?: number;   // heading: h1=26 … h6=14 (in unità world)
  paraGap?: boolean;   // inizio di un nuovo blocco → gap verticale extra
  listIndent?: number; // inizio di un item di lista (1 = primo livello)
}
```

Il titolo di un nodo non è una stringa ma una sequenza di run stilizzati.
Vale l'invariante:

```
node.title === runsToPlain(node.titleRuns)
```

cioè il titolo "piatto" resta sempre sincronizzato con i run: search,
outliner, export e i test continuano a leggere la stringa, mentre canvas ed
editor usano i run. I vecchi documenti senza `titleRuns` funzionano (fallback:
tutto il titolo come un singolo run plain).

Semantica di blocco (aggiunta per replicare la spaziatura di Draw.io/Word):
- `fontSize` → un run più grande (heading) alza l'altezza della riga;
- `paraGap` → il blocco successivo parte con un gap verticale;
- `listIndent` → il renderer disegna il pallino "•" e fa l'hanging indent
  sulle righe di continuazione.

Helper in `src/core/text.ts`: `runsToPlain`, `plainToRuns`, `normalizeRuns`
(unisce run adiacenti con formattazione identica), `nodeRuns`, `runsEqual`,
`trimRuns`, `isEmptyRuns`.

---

## 3. Il ciclo di vita di una modifica

### 3.1 Apertura (doppio click / F2 / type-to-edit)

1. `store.startEdit(id)`:
   - committa eventuale draft in corso (`commitDraftOnLeave`);
   - imposta `editingId` e la selezione;
   - salva `editOriginal` (titolo + runs pre-edit, per undo e per Escape);
   - **semina il draft** con i runs correnti del nodo (`applyDraftRuns`), così
     il layout continua a misurare il nodo alla dimensione giusta finché
     l'editor non riporta la prima modifica.
2. React monta `<RichEditor>` (unico overlay) con `key={editingId}`: aprire
   l'editing su un altro nodo smonta il precedente.

### 3.2 Digitazione (draft live)

- Ad ogni modifica, il listener di Lexical (`DraftSyncPlugin`) converte lo
  stato dell'editor in `TextRun[]` e chiama `store.setEditingDraftRuns(...)`.
- Lo store applica i runs al nodo **in modo effimero** (nessuna op, nessuna
  history) e ricalcola il layout con debounce 30ms: la box del nodo cresce e
  il testo si ri-avvolge **mentre digiti**.

### 3.3 Commit (un'unica op)

- **Enter** (senza Shift) o click fuori → `commitEdit()`:
  - trim dei runs; se il titolo è vuoto e il nodo non ha figli, il nodo viene
    eliminato (altrimenti ripristina il titolo originale);
  - se il contenuto è cambiato → **una sola op `setTitle`** con
    `titleRuns`/`prevRuns` nella history dello store;
  - se non è cambiato → nessuna op, ripristino del titolo originale.
- **Escape** → `cancelEdit()`: scarta il draft e ripristina esattamente
  `editOriginal`.
- **Ctrl+S** mentre si digita → `commitDraftKeepEditing()`: committa il draft
  come op ma **senza chiudere** l'editor (salvi e continui).

Undo/redo passano esclusivamente dalla history dello store: Lexical non ha
HistoryPlugin attivo. `undo()` ripristina i runs pre-edit esatti.

### 3.4 Type/paste-to-edit

Digitare un carattere o incollare con un nodo selezionato avvia l'editing con
quel contenuto: `typeToEdit(text)` imposta `pendingInsert`, e l'editor lo
consuma al mount (`consumePendingInsert`). `appendPendingInsert` bufferizza i
keystroke persi tra l'avvio e il mount (per i dattilografi veloci).

---

## 4. L'overlay Lexical (`src/ui/RichEditor.tsx`)

Struttura:

```
.topic-rich-editor        ← posizionamento assoluto (left/top in px schermo)
└── .topic-rich-inner     ← layout in WORLD units, transform: scale(zoom)
    └── LexicalComposer
        ├── Toolbar       ← B / I / colore / barrato / clear (flottante sopra)
        ├── RichTextPlugin + ContentEditable (.topic-rich-editable)
        ├── ListPlugin
        ├── DraftSyncPlugin   ← seed + listener editor → runs
        ├── PasteSanitizerPlugin
        └── KeysPlugin        ← Enter/Esc/Ctrl+S/Tab in fase di capture
```

**Perché il `transform: scale`?** L'overlay viene ridimensionato in unità
world e scalato tutto insieme: font, padding, bordo e gap di blocco
coincidono col canvas pixel per pixel a qualsiasi zoom. (Scalare le singole
proprietà rompeva il WYSIWYG: i font-size degli heading erano px assoluti e i
padding px schermo, quindi il testo si gonfiava e avvolgeva altrove.)

- `fontSize` dell'inner = font del nodo (world, non scalato);
- `lineHeight: 1.25` = `LINE_HEIGHT_FACTOR`;
- il gap di blocco condiviso è passato come variabile CSS
  `--rnode-block-gap: calc(0.6 * 1.25em)` (costanti TS → CSS, unica fonte);
- la **toolbar flotta sopra la box** (`top: -30px` world): la box è misurata
  per il solo testo, se la toolbar stesse dentro ruberebbe altezza e il
  contenuto scorre/taglia;
- il padding dell'editable replica esattamente la geometria del canvas
  (vedi §7).

---

## 5. Il bridge Lexical ↔ runs (`src/ui/lexicalRuns.ts`)

Due direzioni:

- **`setEditorRuns(editor, runs)`** — semina l'editor dai runs del nodo:
  paragrafi → `<p>`, heading → `<p>` con span `font-size: Xpx`, liste →
  `<ul><li>` annidati; caret alla fine.
- **`editorStateToRuns(editorState)`** — ad ogni keystroke converte lo stato
  in runs:
  - bold/italic/underline → format bit del TextNode;
  - colore e font-size → inline style del TextNode (`color: #hex`,
    `font-size: Xpx`);
  - ogni figlio radice (paragrafo/list/heading) → gruppo; il primo run di un
    gruppo dopo il primo riceve `paraGap`;
  - `ListItemNode` → primo run con `listIndent` (il renderer disegna il
    pallino), item separati da run `\n`;
  - `HeadingNode` → run con `fontSize` assoluto (h1=26 … h6=14);
  - `\n` interno al paragrafo → run `\n` (linea senza gap).

La struttura a blocchi sopravvive al round-trip: è questo che permette al
canvas di riprodurre la spaziatura del contenuto incollato da Draw.io/Word.

---

## 6. Sanitizzazione del paste (`src/ui/pasteSanitizer.ts`)

Tre strati di difesa:

1. **`sanitizeHtml(html)`** — rimuove script/img/href/CSS di layout, ma
   **prima** legge `font-weight`/`font-style` delle span di Word/Google Docs e
   le converte in `<strong>`/`<em>` (altrimenti l'enfasi va persa
   silenziosamente); ricostruisce le liste Word (`MsoListParagraph` +
   margin-left + `mso-list`) in `<ul><li>` annidati; conserva h1–h6.
2. **`htmlToRuns(html)`** — HTML pulito → runs con `fontSize` (heading),
   `paraGap` (paragrafi), `listIndent` (item).
3. **`runsToParagraphNodes(runs)`** — runs → paragrafi/liste Lexical reali
   (l'utente può continuare a modificarli).

**Perché il paste passa sempre dal percorso runs?** `$insertNodes` di Lexical
converte un `HeadingNode` in paragraph quando inserito a selezione collassata
(bug riprodotto nei test). Il percorso runs produce paragrafi con font-size
inline: struttura identica, nessuna dipendenza dalle import rules di Lexical.

---

## 7. Misura condivisa e WYSIWYG (`src/layout/measure.ts`)

Layout e renderer usano **la stessa** `wrapRunLines`, con le stesse costanti:

| Costante | Valore | Significato |
|---|---|---|
| `LINE_HEIGHT_FACTOR` | 1.25 | line-height unitless, come nel CSS |
| `BLOCK_GAP_FACTOR` | 0.6 | gap di blocco = 0.6 × 1.25 × **font del blocco** |
| `TEXT_INSET` | 6 | insetto orizzontale dentro la box (entrambi i lati) |
| `BULLET_WIDTH_EM` | 1.2 | larghezza della colonna del pallino, in em |
| `FONT_STACK` | = `--font` | unico stack tipografico per canvas e overlay |
| `MIN_TOPIC_W` / `MAX_TOPIC_W` | 84 / 280 | clamp della larghezza |

Regole del modello (tutte verificate dall'harness, §7bis):
- l'altezza di riga è la **line box del CSS**: `max(above) + max(below)` su
  ogni inline box della riga — lo *strut* del blocco compreso — dove ciascuno
  contribuisce `ascent + half-leading` e `descent + half-leading`. Non è
  «font-size più grande × 1.25»: quella formula ignora lo strut (un run da
  10px dentro un topic da 14px dava 12.5px contro i 17.5px del browser) e
  sbaglia la baseline quando sulla riga convivono più corpi;
- la **baseline** è calcolata qui e il renderer la usa così com'è;
- ogni **confine di blocco** aggiunge `BLOCK_GAP_FACTOR × LINE_HEIGHT_FACTOR ×
  fontSize del nodo`. Il gap viene dallo **strut**, non dall'altezza della riga
  che segue: `margin-top: calc(.6 * 1.25em)` si risolve sull'`em` del blocco, e
  la dimensione di un heading vive su una span interna;
- un run con `paraGap` apre un blocco **anche senza `\n`** (l'editor segna il
  confine fra root children solo così);
- `listIndent` → il pallino sta in una colonna larga `BULLET_WIDTH_EM em` e il
  testo parte a `depth × bulletW` su **tutte** le righe dell'item;
- lo spazio finale non conta nella larghezza della riga (il CSS lo fa
  debordare), un token più largo della colonna va a capo a metà parola;
- una riga vuota fra due paragrafi è una riga vera; quelle in coda no.

L'overlay replica le stesse regole in CSS:
- `line-height: 1.25` (ereditato, unitless → relativo al font di ogni riga);
- `p, ul, ol, li { margin: 0 }` (zero margini nativi del browser);
- `> :not(:first-child), li + li, li > ul { margin-top: var(--rnode-block-gap) }`
  — stesso gap del canvas, liste annidate comprese;
- `li { padding-left: var(--rnode-bullet-w); text-indent: calc(-1 * ...) }` con
  il pallino disegnato da `li::before`: il marker nativo del browser non è
  utilizzabile, la sua larghezza è decisa dallo UA e nessuna lunghezza CSS la
  eguaglia;
- padding dell'editable calcolato da `pad` e `TEXT_INSET`:
  - verticale: `pad + 2`, e il blocco è centrato da `justify-content: center`
    (come il renderer centra la bitmap: con `flex: 1` restava in alto e
    derivava su diamond/hexagon/circle e dopo ogni resize);
  - orizzontale: `pad − 2` sx, `pad + TEXT_INSET − 2` dx (dentro il bordo da
    2px) → la larghezza di avvolgimento coincide con `boxW − pad·2 − TEXT_INSET`.

---

## 7bis. L'harness di parità (`dev/parity.html`)

La parità non è un'opinione: `npm run dev` →
`http://localhost:5173/dev/parity.html` monta un corpus di casi nel DOM vero
dell'editable, ne estrae le line box reali carattere per carattere con
`Range.getClientRects()`, e le confronta con l'output di `wrapRunLines`
(punti di a-capo, baseline, avanzamento riga, `left`, altezza totale).
Risultati anche su `window.__parity`.

Due trappole di misura che l'harness deve evitare — entrambe producevano
divergenze fantasma:
- il rect di un carattere è l'**inline box** (~19px a 14px), più alto della
  line box da 17.5px: la sovrapposizione verticale non separa le righe (si usa
  il ritorno a sinistra) e la sua altezza non è l'altezza di riga (si usa
  l'avanzamento);
- il *top* del glifo sta a distanze diverse dalla line box per ogni corpo, per
  cui il confronto è sulla **baseline**, ricavata dal rect e dall'ascent.

Stato: **16 casi su 16 allineati**, residuo massimo 0.5px (arrotondamento di
`fontBoundingBox`).

---

## 8. Rendering del nodo sul canvas (`src/render/renderer.ts`)

Il renderer dipinge: sfondo/griglia → relazioni → connettori → nodi →
indicatore di drop. Per ogni nodo (`drawNode`):

1. **Forma e bordo** (rounded/rect/capsule/circle/diamond/hexagon/underline/
   none) + fill + bordo + ombra.
2. **Anello di selezione** + maniglie di resize (solo bordo, con alone bianco
   per la visibilità su fill scuri).
3. **Testo rich** — solo se il nodo NON è in editing (no-ghosting).

### Bitmap cache per nodo

Il testo di ogni nodo viene renderizzato **una volta** in un offscreen canvas
(`renderTextBitmap`) e blittato con `drawImage` durante pan/zoom. La chiave
della cache include `JSON.stringify(titleRuns)` + stile + colore risolto +
larghezza di wrap + bucket di risoluzione (potenza di 2 dello zoom): si
invalida solo quando il contenuto cambia davvero, non ad ogni frame.

### Baseline come il browser

Il canvas **non** calcola più la baseline: la prende da `line.baseline`, che
`wrapRunLines` costruisce con la regola del CSS (half-leading per ogni inline
box, strut incluso — vedi §7). Prima il renderer applicava un solo
half-leading per riga, e con corpi misti la posizione verticale dei glifi si
scostava da quella dell'editor.

Sottolineato a ~0.1em sotto la baseline, barrato a ~0.28em sopra.

Il pallino di una lista viene disegnato in `line.bullet` alla sua `x` di
colonna, non è più un segmento di testo: la sua larghezza deve essere una
lunghezza che anche il CSS può esprimere.

---

## 9. Allineamento editor ↔ canvas: cosa è stato allineato

| Aspetto | Valore condiviso |
|---|---|
| Line box | `max(ascent+half) + max(descent+half)` su ogni inline box, strut incluso |
| Gap di blocco | `0.6 × 1.25 × font del blocco` (CSS var `--rnode-block-gap`) |
| Margini nativi | azzerati in CSS (p/ul/ol/li) come nel modello |
| Posizione glifi | `line.baseline`, calcolata una volta sola nella misura |
| Colonna pallino | `BULLET_WIDTH_EM em` (CSS var `--rnode-bullet-w`) |
| Wrap width | `boxW − pad·2 − TEXT_INSET` (padding dell'editable calcolato) |
| Centratura blocco | verticale, `justify-content: center` su entrambi i lati |
| Font | unico `FONT_STACK` (= `--font`), più weight/italic/decorazioni del nodo |
| Colori | fill e colore testo risolti da `Renderer.nodeColors` |
| Scala | overlay in world units + `transform: scale(zoom)`; toolbar **fuori** |

---

## 10. Tasti e interazioni durante l'editing

- **Enter** → commit dell'edit (Enter in capture-phase, prima dei handler di
  Lexical).
- **Esc** → annulla (ripristina `editOriginal`).
- **Ctrl/Cmd+S** → `saveNow()` con commit del draft, editor aperto.
- **Tab** → inserisce un carattere tab letterale nel titolo.
- **B / I / colore / barrato / clear** → toolbar.
- Pan/zoom (rotella e drag) → bloccati mentre `editingId` è attivo.

---

## 11. Bug noti risolti lungo la strada

- **React StrictMode** impediva la registrazione del listener di sincronia
  (effetto mount → cleanup → mount + guard `seeded`): seed e listener sono ora
  in **due effetti separati**.
- **`$insertNodes` appiattisce gli heading** a selezione collassata: il paste
  passa sempre dal percorso runs.
- **Liste Word**: `<li>` dentro `<li>` → HierarchyRequestError; `replaceWith`
  di un discendente col proprio antenato → albero invalido. Risolti con
  contenuto del wrapper + `insertBefore`.
- **Toolbar dentro la box** rubava altezza → contenuto con scrollbar: ora
  flottante sopra.
- **Scalatura per-proprietà** dell'overlay (heading px assoluti, padding px
  schermo) gonfiava il contenuto: sostituita dal `transform: scale`.
- **`<p>` dentro `<li>`**: un figlio *block* con `list-style-position: inside`
  manda il marker su una riga sua (item da 17.5px misurato 35px) — una riga
  intera di deriva per ogni elemento di lista. Ora gli item hanno figli inline.
- **Round-trip non idempotente**: `runs → editor → runs` cambiava il contenuto,
  quindi un titolo derivava a ogni modifica. Due cause: la profondità di lista
  contata due volte (nidificazione strutturale **e** `getIndent()` sommati) e
  il `\n` di chiusura di una lista riemesso ogni volta, che si accumulava in
  una riga vuota disegnata dal canvas e mai mostrata dall'editor.
- **`stripEmptyNestedLists` non rimuoveva nulla**: iterava i figli della lista
  (tutti `ListItemNode`) cercando `$isListNode` — ogni `<li>` si portava dietro
  un `<ul>` vuoto.
- **Marker nativo del browser**: la sua larghezza è decisa dallo UA e nessuna
  lunghezza CSS la eguaglia, quindi un item andato a capo non poteva allinearsi.
  Sostituito da una colonna di larghezza nota disegnata da `li::before`.

---

## 12. Limitazioni note e lavori in corso

- **Link nel testo**: non supportati (nessun campo `link` su `TextRun`) — i
  link di Draw.io vanno persi.
- **Liste numerate**: gli item vengono resi con pallini (list-style: disc);
  il tipo numerato non è ancora modellato.
- **Allineamento per paragrafo**: solo quello del nodo intero
  (center/left), non per singolo blocco. Gli **item di lista sono sempre
  allineati a sinistra** su entrambi i lati: centrare un hanging indent non è
  ben definito e i due renderer non potrebbero accordarsi.
- **Liste con contenuto misto**: un gruppo `paraGap` che contiene sia testo
  normale sia item di lista perde il testo che precede il primo item
  (`buildList` parte dal primo run con `listIndent`). Non raggiungibile
  dall'editor — `editorStateToRuns` mette `paraGap` su ogni root child, quindi
  la lista finisce sempre in un gruppo suo — ma runs costruiti a mano o
  migrati possono incapparci.
- **Toolbar**: mancano barrato, sottolineato, liste e heading; liste e heading
  si ottengono oggi solo incollando.
- **Note dei nodi**: ancora plain text (il rich text vale per i titoli).
- **Outliner/search/export**: mostrano il testo appiattito (`runsToPlain`).
- **Tabelle nel titolo**: non supportate.
- **RTL**: non implementato.

---

## 13. Mappa dei file

```
src/core/types.ts          TextRun, MindNode, Style, …
src/core/text.ts           helper runs: normalize, plain<->runs, nodeRuns…
src/core/ops.ts            op system (setTitle con titleRuns/prevRuns)
src/editor/store.ts        EditorStore: draft, commit, undo/redo, resize…
src/ui/RichEditor.tsx      overlay Lexical (unico), toolbar, tasti, paste
src/ui/lexicalRuns.ts      bridge editor <-> runs
src/ui/pasteSanitizer.ts   sanitizeHtml / htmlToRuns (Word, Draw.io, web)
src/layout/measure.ts      wrapRunLines condiviso, line box CSS, costanti
src/render/renderer.ts     drawNode, renderTextBitmap (cache), nodeColors
src/ui/CanvasView.tsx      overlay positioning, pan bloccato, resize handle
dev/parity.html · dev/parity.ts   harness di parità editor ↔ canvas (§7bis)
tests/pasteSanitizer.test.ts · lexicalRuns.test.ts · measure.test.ts · store.test.ts
```
