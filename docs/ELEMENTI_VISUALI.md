# R-node — Catalogo degli elementi visuali e della GUI

Foglio di riferimento di **tutto ciò che è visibile e modificabile** in R-node:
tema del canvas, design system della GUI, elementi per nodo, per foglio e per
testo, e asset di branding. I valori riportati sono quelli reali del codice
(`src/render/theme.ts`, `src/styles.css`, `src/core/types.ts`,
`src/ui/Inspector.tsx`).

> Fonti da aggiornare insieme a questo file: `src/render/theme.ts` (tokens del
> canvas), `src/styles.css` (tokens e componenti GUI), `src/core/types.ts`
> (modello `Style`, `TaskInfo`, `StructureConfig`, `TopicShape`, `TextRun`).

---

## 1. Logo e branding

| Asset | File | Note |
|---|---|---|
| Logo principale | `public/favicon.svg` | SVG 256×256 con **PNG base64** incorporato (23 KB). Marchio **rosso** (`#e10100`) su sfondo trasparente: mappa mentale stilizzata — due nodi collegati a un corpo arrotondato. È l'icona usata dal web. |
| Favicon | `public/favicon-16.png` / `favicon-32.png` / `favicon-64.png` | Rendering del logo a 16 / 32 / 64 px. |
| Apple touch | `public/apple-touch-icon.png` | Icona per home screen iOS. |
| Icone desktop (Tauri) | `src-tauri/icons/icon.png`, `icon.ico`, `icon.icns`, `32x32.png`, `128x128.png`, `128x128@2x.png` | Icone dell'installer desktop (Windows/macOS/Linux). |
| Punto del brand (sidebar) | CSS `.brand-dot` | Cerchio 14 px, `conic-gradient`: indigo → rosa → verde → indigo (`#4f46e5 → #db2777 → #16a34a`). |

**Colori del brand** (unica fonte informale): indigo `#4f46e5` (accento,
selezione, pill), rosso logo `#e10100`, rosa `#db2777`, verde `#16a34a`.
Non esiste un logo file dedicato diverso da `favicon.svg`: il marchio è
condiviso tra web e desktop.

---

## 2. Tema del canvas — design tokens (`src/render/theme.ts`)

Un solo tema oggi: **`"light"`** (il tema scuro è stato rimosso di proposito;
aggiungerlo è una palette nuova, non un refactoring). Ogni token vive in
`RenderTheme` e governa il disegno del canvas:

| Token | Valore light | Cosa colora |
|---|---|---|
| `background` | `#ffffff` | sfondo della mappa |
| `grid` | `#f5f7fa` | griglia di sfondo |
| `text` | `#111827` | testo dei nodi (default) |
| `textMuted` | `#6b7280` | testi secondari |
| `selection` | `#4f46e5` | selezione, drop indicator, relazioni |
| `selectionFill` | `rgba(79,70,229,0.10)` | riempimento selezione/marquee |
| `dropIndicator` | `#4f46e5` | indicatore di drop durante il drag |
| `rootFill` | `#ffffff` | riempimento del nodo centrale |
| `rootText` | `#111827` | testo del nodo centrale |
| `branch[]` | 8 colori (vedi sotto) | palette dei rami principali, ruotata per indice |
| `branchSoft[]` | 8 colori pastello | riempimento dei discendenti di ciascun ramo |
| `connector` | `#9aa3b2` | connettori struttura |
| `collapsedBadge` | `#e5e7eb` | cerchio "collapsed" sui rami chiusi |
| `collapsedBadgeText` | `#374151` | numero di nodi nascosti nel badge |
| `nodeBorder` | `rgba(0,0,0,0.06)` | bordo dei nodi |
| `shadow` | `rgba(28,35,51,0.14)` | ombre |

**Palette dei rami** (`branch`, ordine di rotazione):

```
#ff646b  #ff9a66  #4eb5e8  #55c9bd  #a7d9bb  #d979e5  #70b9e8  #f0bd62
```

**Pastelli dei discendenti** (`branchSoft`, stesso ordine):

```
#ffdfe1  #ffe8dc  #dff4ff  #dff8f5  #e5f6ec  #f6e1f9  #deeffb  #fff0d3
```

Il nodo centrale usa `rootFill`/`rootText`; i rami `main` prendono
`branch[i]`; i discendenti `branchSoft[i]` — finché lo stile del nodo non
sovrascrive il riempimento (vedi §5).

---

## 3. Design system CSS — GUI (`src/styles.css`)

### 3.1 Variabili globali (`:root`)

| Variabile | Valore | Uso |
|---|---|---|
| `--accent` | `#4f46e5` | indigo: azioni primarie, focus, selezione |
| `--accent-soft` | `rgba(79,70,229,0.14)` | fondi selezionati (attivo) |
| `--radius` | `8px` | angoli grandi (menu, palette, toast) |
| `--radius-sm` | `6px` | angoli piccoli (bottoni, input, righe) |
| `--font` | system-ui stack | tipografia GUI |
| `--mono` | SF Mono / Cascadia / Consolas | hint e testi mono (palette) |

### 3.2 Variabili tema chiaro (`:root[data-theme="light"]`)

| Variabile | Valore | Uso |
|---|---|---|
| `--bg` | `#ffffff` | sfondo app |
| `--surface` | `#ffffff` | superfici (pannelli, barre) |
| `--surface-2` | `#f8fafc` | hover/righe |
| `--border` | `#e5e7eb` | bordi e separatori |
| `--text` | `#1c2333` | testo principale |
| `--text-muted` | `#6b7280` | etichette, hint |
| `--accent` / `--accent-soft` | come sopra | coerenza con il canvas |
| `--danger` | `#dc2626` | azioni distruttive |
| `--shadow` | `0 10px 30px rgba(28,35,51,0.16)` | ombre di menu/palette/overlay |

Il selettore `[data-theme="light"]` è il punto d'innesto per un tema scuro
futuro: basta aggiungere `:root[data-theme="dark"]`.

---

## 4. Elementi della GUI — inventario per componente

### 4.1 Sidebar (colonna sinistra, 264 px)
- **Brand**: punto `conic-gradient` + nome "R-node".
- **Ricerca** documenti (`Ctrl/Cmd+F` dal canvas porta qui).
- **Azioni**: crea documento, apre file (`Open`).
- **Lista documenti**: righe (`doc-row`) con titolo, hover mostra azioni
  (rinomina, duplica, archivia, elimina); riga attiva con fondo accent-soft.
- **Footer**: metadati (conteggio, storage).

### 4.2 TopBar
- **Titolo documento** (input inline, rename on blur/Enter).
- **Gruppo storico**: Undo `↶` / Redo `↷` (disabilitati se vuoti).
- **Save** (primario) + **Open** + stato salvataggio (`Saved` / `Unsaved`
  ambra quando sporco).
- **Gruppo zoom**: `−` / `%` (click = fit view) / `+`.
- **Pannelli**: Outliner `☰`, Inspector `⚙`, Zen `◎`, Palette `⌘`.
- **Trace** `⏺` (solo dev, compilato fuori dalle build di produzione).
- **Menu Export ▾**: JSON (`.rnode.json`), Markdown, PNG, `.rnode.zip`
  (completo / compatto, solo se ci sono immagini), voci placeholder
  SVG·PDF·DOCX.

### 4.3 Canvas
- **Canvas unico** a piena area, viewport culling.
- **Marquee** (selezione a riquadro): bordo 1.5px accent + fondo
  `color-mix(accent 12%)`, overlay DOM temporaneo.
- **Ghost del drag esterno** (immagini da Explorer/browser): anteprima 150×110
  con bordo tratteggiato accent che segue il cursore.
- **Overlay di editing rich text** (uno solo): box posizionato in world unit,
  scala via `transform: scale(zoom)`, bordo 2px accent, riempimento e colore
  testo del nodo; **toolbar flottante** sopra (`top: -32px`) con B / I / U /
  colore / clear-color.
- **Pill relazione pendente** (`.rel-pending`): pillola accent in alto al
  centro ("Click target node…") mentre si crea un collegamento.

### 4.4 Inspector (colonna destra, 292 px)
Sezioni mostrate a seconda della selezione:
- **Topic**: titolo, azioni (+Child, +Sibling, ↑Promote, ↓Demote, ⧉Duplicate,
  Delete, ⇄Link…, ❐Group, ❨Summary, Collapse/Expand), checkbox *Free
  positioning branch* (solo nodi `main`).
- **Style**: Fill, Text, Font size, Node width (slider + Auto), Image size
  (solo se c'è immagine), Bold, Shape (dropdown), Reset to branch color.
- **Task**: Status, Priority, Progress (slider), Assignee.
- **Notes**: textarea testo semplice (rich notes in Phase 4).
- **Sheet**: titolo, Structure (9 tipi), Orientation, Level spacing, Branch
  spacing, ⟳ Auto layout, conteggio nodi visibili.
- **Relationship** (se selezionata): etichetta, bidirezionale, stile linea
  (solid/dashed/dotted), elimina.
- **Group**: numero di membri, elimina.
- **Summary**: etichetta, numero di membri, elimina.

### 4.5 Outliner (pannello inferiore, 38% di altezza)
- Header (etichetta), righe indentate: caret `▸/▾`, checkbox task,
  **pallino priorità** (8 px: verde `#a3e635`, ambra `#fbbf24`, arancio
  `#fb923c`, rosso `#f87171`), titolo editabile; riga selezionata con fondo
  accent-soft.

### 4.6 Palette comandi (`Ctrl/Cmd+K`)
- Overlay scuro (35%), pannello 520 px, input, lista con righe
  etichetta+hint mono, footer con scorciatoie.

### 4.7 StatusBar
- Hints contestuali (accent), zoom %, info selezione, separatori.

### 4.8 Toast
- Pillola centrata in basso (border-radius 999px, ombra), entrata animata
  (`toast-in` 0.16s), cliccabile per chiudere.

### 4.9 Testo rich (dentro il canvas)
- Blocchi con **gap condiviso** (`--rnode-block-gap`), liste senza marker UA:
  pallini disegnati `•` (livello 1), `◦` (2), `▪` (3) in colonna
  `--rnode-bullet-w`.

---

## 5. Elementi modificabili per NODO

### 5.1 Modello `Style` (`src/core/types.ts`) — cosa esiste e cosa è esposto

| Campo | Valori / default | Nell'Inspector? |
|---|---|---|
| `fill` | hex; default `undefined` → palette ramo | ✅ color picker |
| `textColor` | hex; default → tema | ✅ color picker |
| `fontSize` | 10–48; default 14 | ✅ numero |
| `fontWeight` | 400 / 600 (bold) | ✅ checkbox Bold |
| `shape` | 8 forme (vedi sotto); default `rounded` | ✅ dropdown |
| `width` | 90–640, default auto (max 640); text re-wraps | ✅ slider + Auto |
| `image` + `imageWidth` | id asset; larghezza 48–640 (naturale ≤ 240) | ✅ slider + Natural |
| `stroke` | default `transparent` | ⛔ nel modello, non in UI |
| `borderWidth` | default 0 | ⛔ |
| `borderStyle` | `solid`/`dashed`/`dotted` | ⛔ |
| `cornerRadius` | default 10 | ⛔ (usato dalle forme) |
| `fontFamily` | default stack di sistema | ⛔ |
| `italic` / `underline` / `strikethrough` | booleani | ⛔ (via editor di testo) |
| `opacity` | default 1 | ⛔ |
| `shadow` | booleano | ⛔ |
| `icon` | stringa (id icona) | ⛔ (non implementato) |
| `link` | stringa URL | ⛔ (Phase 4, roadmap) |
| `padding` | default 10 | ⛔ |
| `align` | `left`/`center`; default center | ⛔ (solo testo) |
| `height` | numero | ⛔ |
| `rotation` | gradi | ⛔ |
| `locked` / `hidden` | booleani | ⛔ |

**Forme** (`TopicShape`): `rounded` (default) · `rect` · `capsule` ·
`circle` · `diamond` · `hexagon` · `underline` · `none`.
`cloud` esiste nel tipo ma **non** è né disegnato né nel dropdown (8 voci).

### 5.2 Task
| Campo | Valori |
|---|---|
| `status` | `not-started` · `in-progress` · `blocked` · `completed` · `cancelled` |
| `priority` | `none` · `low` · `medium` · `high` · `urgent` |
| `progress` | 0–100 (al 100% → completed) |
| `assignee` | testo |

Rendering sul canvas: completato → **ribbon**; priorità → pallino colorato
(high/urgent `#f87171`, medium `#fbbf24`, low `#a3e635`).

### 5.3 Altro
- **Notes**: testo semplice (rich notes in Phase 4).
- **Collapsed/expand**: badge con conteggio nascosti (`collapsedBadge`).
- **Posizione manuale**: `position.manual` (branch a posizionamento libero).
- **Immagine**: sopra il testo, proporzioni bloccate, livelli original /
  1024px / 256px, decodifica al livello giusto per lo zoom.

---

## 6. Elementi della MAPPA / foglio

| Elemento | Valori / default | Esposto? |
|---|---|---|
| `structureType` | `mindmap` (default) · `logic` · `tree` · `org` · `timeline` · `fishbone` · `matrix` · `treetable` · `freeform` | ✅ dropdown Sheet |
| `orientation` | `horizontal`/`vertical` (disabilitato per mindmap/freeform) | ✅ |
| `spacing` (livelli) | 80–400, default 180 | ✅ slider |
| `branchSpacing` (fratelli) | 4–80, default 14 | ✅ slider |
| `connectorStyle` | `curved` (default) · `straight` · `elbow` | ⛔ nel modello, non in UI |
| `padding` / `compactMode` / `autoBalance` | nel modello | ⛔ |
| `freePositioningBranches` | booleano | via checkbox per-nodo |
| `allowManualPositioning` | booleano | ⛔ |

**Relazioni** (frecce indipendenti dall'albero): etichetta, `bidirectional`,
`lineStyle` (`dashed` default, `solid`, `dotted`), colore (default =
selezione), stato selezionato evidenziato. **Group** (confine): membri.
**Summary**: etichetta + intervallo di membri.

---

## 7. Elementi di TESTO (`TextRun[]`)

| Proprietà | Valori |
|---|---|
| `bold` / `italic` / `underline` / `strikethrough` | booleani |
| `color` | hex (default: colore tema/nodo) |
| `fontSize` | heading h1=26 … h6=14 (px world), usato come `font-size` inline |
| `paraGap` | inizio nuovo blocco → gap verticale |
| `listIndent` | 1+ → item di lista (pallini `•` `◦` `▪`) |

Invariante: `node.title === runsToPlain(node.titleRuns)`.

---

## 8. Nota sulla personalizzazione

- **Tema**: solo `light` oggi; il tema scuro è un cambio di palette
  (`:root[data-theme="dark"]` + nuovo token in `THEMES`), non un refactoring.
- **Font**: stack di sistema, nessun font bundled.
- **Icone nodi** (`Style.icon`) e **link** (`Style.link`) sono nel modello ma
  non ancora implementati/visibili.
- Le voci GUI marcate ⛔ esistono nel modello dati ma non hanno controllo UI:
  sono i candidati naturali per l'Inspector in fasi successive.
