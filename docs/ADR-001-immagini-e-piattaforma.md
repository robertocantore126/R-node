# ADR-001 — Immagini nei nodi: storage, memoria di decodifica, piattaforma

**Stato:** aperto, in cerca di secondo parere
**Data:** 2026-08-12
**Decide:** il proprietario del progetto

---

## 0. Come usare questo documento

Questo file è scritto per essere dato in pasto a un modello che **non conosce
il progetto**. Contiene quindi tutti i fatti necessari, e distingue
esplicitamente ciò che è stato misurato da ciò che è stimato.

**Cosa si chiede al lettore.** Non un riassunto delle opzioni: quelle sono già
enumerate in §5. Si chiede di rispondere alle **domande aperte di §9**, di
attaccare il ragionamento di §7 se è debole, e di segnalare opzioni mancanti.

**Cosa NON serve.** In §10 c'è un elenco di proposte già valutate e scartate,
con il motivo. Riproporle non aiuta. In particolare: questa codebase ha già
ricevuto analisi automatiche che proponevano cose **già implementate** (una
cache del text measuring che esiste da mesi, transazioni atomiche nella history
che sono atomiche dal primo commit). Il codice va letto prima di proporre.

**Convenzione sulle affermazioni:**

| Marca | Significato |
|---|---|
| **[M]** | misurato in questa codebase, con il numero riportato |
| **[V]** | verificato leggendo il codice |
| **[S]** | stima, con il ragionamento esplicitato |
| **[?]** | incerto, da verificare |

---

## 1. Il prodotto, in due righe

R-node è uno spazio di lavoro per mappe mentali: nodi collegati ad albero,
disegnati su **un solo `<canvas>`** per reggere migliaia di elementi. Il testo
dentro ogni nodo è **rich text** (grassetto, corsivo, colori, heading, liste).

Ora si vuole aggiungere le **immagini nei nodi**, in stile XMind: si trascina
un file su un nodo, appare sopra il testo, si ridimensiona con uno slider.

Requisito dichiarato dal proprietario: **varie centinaia di immagini per
mappa**, con gli **originali conservati a piena risoluzione**, e la possibilità
di **mandare una mappa come file singolo**.

---

## 2. Lo stato attuale, in fatti

**Stack** [V]: TypeScript, React 18, Vite 6, Lexical 0.49, vitest.
Nessuna dipendenza grafica: il rendering è Canvas2D scritto a mano.

**Struttura** [V] — il motore è framework-free, solo `ui/` usa React:

```
src/core/     schema, modello documento, sistema di operazioni, history
src/layout/   misura del testo e posizionamento (funzioni pure)
src/render/   renderer Canvas2D, viewport, temi, hit-test, export PNG
src/editor/   store (orchestrazione), scorciatoie
src/persist/  adapter di storage (localStorage oggi)
src/ui/       React: canvas, sidebar, topbar, outliner, inspector, palette
src-tauri/    shell desktop Tauri 2 — presente ma MAI COMPILATA
dev/          harness di parità testo (solo sviluppo)
```

**Test** [M]: 101 test in 8 suite, typecheck pulito.

**Performance** [M], dalla suite `tests/perf.test.ts` a 10.000 nodi:
operazioni ~0.005 ms/op, layout ~150 ms, writeback ~135 ms.

**Rendering del testo** [V]: ogni nodo ha il titolo come `TextRun[]` (sequenza
di run stilizzati). Il canvas lo disegna con una **cache bitmap per nodo**;
durante pan e zoom si fa solo `drawImage`.

**Editing** [V]: quando si edita **un** nodo, si monta **un solo** overlay HTML
(Lexical) sopra di esso, e il canvas smette di disegnare quel nodo. Mai più di
un overlay.

**Parità editor↔canvas** [M]: il canvas riproduce a mano il layout testuale del
browser, e la coincidenza è **misurata**, non asserita — un harness confronta
le line box reali del DOM con l'output della misura del canvas su 16 casi.
Stato attuale: **16 su 16 allineati**, scarto massimo 0.5px. Ci è voluta una
sessione di lavoro dedicata e ha prodotto la correzione di ~14 divergenze.

**Persistenza** [V]: `LocalStorageAdapter` scrive `JSON.stringify(docs)` in
localStorage. Il salvataggio è **manuale** (Ctrl+S), non c'è autosave.
`src-tauri/src/lib.rs` espone già `list_documents`, `load_document`,
`save_document`, `delete_document` su SQLite — **mai compilati**, `rustc` e
`cargo` non sono installati sulla macchina [M].

**Seam già previsti** [V]:
- `Style.image?: string // attachment id` esiste nello schema dal primo commit
- `Sheet.attachments: unknown[]` esiste, non tipizzato
- il renderer è **isolato dietro una classe** con hit-test ed export, e
  `docs/ARCHITECTURE.md` dichiara *"WebGPU (preferred) / WebGL2 fallback"* come
  percorso di aggiornamento previsto
- `StorageAdapter` è un'interfaccia con più implementazioni previste

---

## 3. Il problema, con i numeri

Sono due problemi distinti che è facile confondere.

### 3.1 Storage — dove stanno i byte

localStorage regge **~5MB per origine** e una mappa da 10k nodi ne occupa già
~3.6 [M, dal README del progetto]. Il base64 gonfia i byte del **33%**.

Centinaia di immagini, anche solo a 500KB l'una, fanno **centinaia di MB**: non
è che va stretto, non ci sta di **due ordini di grandezza**. In più un
documento da decine di MB blocca il thread principale a ogni `JSON.parse`.

Conclusione già presa: **le immagini escono dal documento**, in un archivio
separato indirizzato per contenuto (SHA-256 → deduplicazione gratuita).

### 3.2 Memoria di decodifica — quanti pixel stanno in RAM

Questo è il problema **non risolto** e il motivo di questo documento.

Un'immagine compressa è piccola; decodificata è RGBA grezzo:
`larghezza × altezza × 4 byte`.

| Bitmap | Memoria decodificata |
|---|---|
| 256×192 | 0,19 MB |
| 512×384 | 0,75 MB |
| 1024×768 | **3,0 MB** |
| 2048×1536 | 12 MB |
| 4000×3000 (12 megapixel) | **46 MB** |

Quindi: **dieci originali da 12MP decodificati sono ~460MB**. E 100 bitmap da
1024px sono 300MB. Con "varie centinaia di immagini" si va fuori memoria
banalmente.

Aggravante specifica di questa architettura: essendo tutto **un solo canvas**,
non esiste il lazy-loading gratuito che daresti per scontato con `<img>` nel
DOM. Il renderer deve gestire esplicitamente cosa decodificare, quando, e cosa
liberare.

**Trappola tecnica** [V, comportamento noto della piattaforma]: la memoria di
un `ImageBitmap` **non sta nello heap JavaScript**. Non appare negli heap
snapshot e non viene liberata dalla pressione del GC in modo prevedibile.
Serve `bitmap.close()` esplicito. Con `new Image()` quel controllo non esiste.

### 3.3 Rischio di perdita dati

[V, comportamento della piattaforma] I browser **possono cancellare
IndexedDB**. Ma il rischio **non è uniforme**: dipende da come l'app viene
distribuita, e va valutato per canale invece che in astratto.

| Canale | Rischio | Perché |
|---|---|---|
| Chromium, `persist()` concesso o installata come PWA | **basso** | l'origine diventa persistente e non viene sfrattata automaticamente sotto pressione di spazio |
| Chromium, sito normale senza `persist()` | **medio** | storage "best-effort", sfrattabile quando lo spazio scarseggia |
| Safari, sito non installato | **alto** | l'ITP cancella lo storage scrivibile da script dopo ~7 giorni senza interazione, e `persist()` non protegge |
| Firefox | **medio** | `persist()` richiede un permesso esplicito all'utente |
| Desktop (Tauri) | **nullo** | file veri, nessuna politica di eviction |

`navigator.storage.persist()` resta una *richiesta*, non una garanzia: su
Chromium viene concessa in base a euristiche (installazione, engagement), non
su domanda.

Conseguenza per la decisione: **questa casella non si può riempire senza
sapere il canale di distribuzione**. Se R-node vive come app installata o
desktop, l'argomento perde peso; se deve funzionare come sito aperto in Safari,
diventa il rischio principale — centinaia di originali insostituibili
cancellati dopo una settimana di inattività.

Nota su un numero ricorrente: la quota "~60% dello spazio disco" è
**specifica di Chrome**. Firefox usa criteri diversi e Safari si attesta intorno
a ~1GB prima di chiedere conferma. Ogni conclusione del tipo "sul web la quota
basta" vale su Chromium e va riverificata altrove.

---

## 4. Vincoli

**Duri** (non negoziabili senza cambiare il prodotto):

1. **Un solo canvas.** Niente elemento DOM per nodo: è la ragione per cui la
   mappa regge migliaia di nodi.
2. **Il rich text nei nodi è il differenziatore del prodotto.** Ci è stato
   investito il grosso del lavoro finora, inclusa la parità misurata.
3. Undo/redo su ogni modifica, sistema di operazioni con inverso.
4. Local-first: nessuna dipendenza da un server.

**Morbidi** (preferenze, cedibili con una motivazione):

5. Il web resta un target — non necessariamente il principale.
6. Il core resta framework-free e testabile senza DOM.
7. Un solo linguaggio nel motore, per non moltiplicare la superficie di test.

**Del contesto, che pesano sulla decisione:**

8. Sviluppo assistito da AI, con modelli di capacità diversa. Le scelte devono
   essere **verificabili**: l'harness di parità esiste per questo.
9. Nessun team: costo di manutenzione a lungo termine su una persona.

---

## 5. Le opzioni

### Famiglia A — restare nel browser

#### A1. Status quo: Canvas2D + IndexedDB + varianti pre-scalate

L'archivio asset in IndexedDB conserva due varianti per immagine: l'originale e
una `display` a 1024px. Il canvas decodifica solo la `display`, con
`createImageBitmap`, per i soli nodi visibili, in una cache LRU a budget di
byte, liberando con `close()`.

- **Risolve**: la quota (IndexedDB regge centinaia di MB), la memoria (con il
  budget), la deduplicazione (hash).
- **Non risolve**: il rischio di eviction di §3.3; ogni cambio di zoom richiede
  una ri-decodifica al nuovo bucket di risoluzione.
- **Costo** [S]: basso. Nessun cambio di stack, il codice esistente resta.
- **Rischio**: il budget di memoria va calibrato a mano; sbagliarlo si vede
  solo sotto carico reale.

#### A2. A1 + renderer WebGPU

Il renderer passa da Canvas2D a WebGPU. Le immagini diventano texture con
**mipmap**: si caricano una volta e la GPU sceglie il livello per lo zoom.
Possibilità di **texture compresse** in VRAM (BC7): ~1MB invece di 3 per una
1024×768.

- **Risolve**: elimina i bucket di risoluzione e le ri-decodifiche; ~3× più
  immagini nella stessa memoria; anche il disegno dei nodi diventa più veloce.
- **Non risolve**: eviction di IndexedDB.
- **Costo** [S]: **alto**. Va riscritto tutto il disegno — forme, connettori,
  testo. Il testo su GPU richiede un **atlante di glifi** o il riuso delle
  bitmap attuali come texture. Settimane, non giorni.
- **Nota favorevole** [V]: il renderer è già isolato dietro una classe con
  hit-test ed export, e l'architettura dichiara WebGPU come percorso previsto.
  L'isolamento è già stato pagato.
- **Rischio**: WebGPU su Safari è arrivato tardi; serve un fallback WebGL2 o
  Canvas2D, quindi **due renderer da mantenere e da testare**.

#### A3. A1 + decodifica in Web Worker con OffscreenCanvas

Sposta decodifica e ridimensionamento fuori dal thread principale.

- **Risolve**: lo scatto durante l'import e durante la panoramica.
- **Non risolve**: la memoria totale (le bitmap pesano uguale).
- **Costo** [S]: medio-basso, incrementale su A1.
- **Nota**: `createImageBitmap` già decodifica fuori dal main thread; il
  guadagno aggiuntivo è sul ridimensionamento e sull'hashing.

### Famiglia B — ibrido: shell nativa + interfaccia in webview

Tutte usano **Tauri 2**, che su Windows incorpora WebView2 (Chromium).
`src-tauri/` esiste già [V].

> **Punto cruciale, spesso frainteso:** Tauri **usa comunque una webview**. Il
> canvas, `createImageBitmap` e la memoria delle bitmap decodificate sono
> identici al browser. Andare "in locale" sposta **dove stanno i byte**, non
> **quanti pixel stanno in RAM**. Tutto §3.2 resta valido invariato.

#### B1. Tauri + asset su filesystem/SQLite

L'archivio asset diventa file veri o BLOB in SQLite.

- **Risolve**: quota (praticamente illimitata), **rischio di eviction (§3.3)**,
  export a file singolo più semplice.
- **Non risolve**: memoria di decodifica.
- **Costo** [S]: basso-medio. `rustup` da installare, primo build lungo, i
  comandi Rust per gli asset da aggiungere (i 4 per i documenti esistono già).
- **Rischio**: due target da mantenere se il web resta vivo; catena di build
  più lunga; testing del layer Tauri più scomodo.

#### B2. B1 + pipeline immagini lato Rust

All'import, Rust legge il file, calcola l'hash e genera i livelli ridotti su
thread veri, in parallelo. La webview riceve immagini già della dimensione
giusta e non ridimensiona mai nulla.

- **Risolve**: costo di import e di ridimensionamento tolto dal thread
  dell'interfaccia; parallelismo reale.
- **Non risolve**: la memoria delle bitmap a schermo.
- **Costo** [S]: medio. Una crate immagini in Rust (`image`), più i comandi.
- **Nota**: si combina bene con A2 — Rust può produrre direttamente texture
  compresse pronte per la GPU.

#### B3. B1 + B2 + renderer WebGPU (A2)

La combinazione massima senza uscire dalla webview.

- **Costo** [S]: somma dei precedenti. Alto.
- **Copre** [S]: ~80% del vantaggio di una soluzione nativa, mantenendo Lexical
  e quindi tutto l'editing di testo.

### Famiglia C — nativo, niente webview

#### C1. GUI Rust (egui / iced / Slint / GPUI)

#### C2. Flutter (motore Impeller/Skia proprio)

#### C3. Skia o wgpu diretti, con GUI custom

Tutte e tre condividono benefici e costi, quindi si valutano insieme.

- **Risolvono**: controllo totale su texture, mipmap e sfratto; texture
  compresse; niente webview né suo consumo di memoria; avvio più rapido;
  binario più piccolo. Sul problema §3.2 sono **tecnicamente superiori**.
- **Costo dominante — leggere con attenzione** [S]: **bisogna riscrivere un
  editor di rich text da zero.**

  In una webview il browser regala: shaping del testo, andata a capo Unicode,
  bidi, caret, selezione col mouse, **IME** per cinese/giapponese/coreano,
  dead key per gli accenti, accessibilità. Lexical ci sta sopra.

  Nativamente **nulla di tutto ciò esiste**. Servono HarfBuzz/rustybuzz per lo
  shaping, line breaking Unicode, gestione IME per piattaforma, caret e
  selezione. È fra le cose più insidiose che si possano scrivere; ci lavorano
  team interi per anni.

  Più: 101 test da riscrivere, tutta l'interfaccia React da rifare, il core in
  un altro linguaggio.

- **Ironia da notare**: l'intero lavoro di parità testo esiste **perché** c'è
  un browser con cui coincidere. In nativo quel problema sparisce — ma al suo
  posto arriva "scrivi il motore di testo", che è di due ordini di grandezza
  più grosso.
- **Verdetto** [S]: sproporzionato rispetto al problema, **finché il rich text
  resta il differenziatore**. Vedi §8.

---

## 6. Confronto

Legenda: ✅ risolve · ➖ neutro · ❌ non risolve o peggiora.

| | Quota | Eviction §3.3 | Memoria decodifica | Fluidità import | Costo | Rischio manutenzione |
|---|---|---|---|---|---|---|
| **A1** Canvas2D + IndexedDB | ✅ (Chrome) | dipende dal canale | ✅ (a mano) | ➖ | Basso | Basso |
| **A2** + WebGPU | ✅ (Chrome) | dipende dal canale | ✅✅ (mipmap) | ➖ | Alto | **Alto** (2 renderer) |
| **A3** + Worker | ✅ (Chrome) | dipende dal canale | ➖ **come A1** | ✅ | Basso-medio | Basso |
| **B1** Tauri + fs | ✅✅ | ✅ | eredita dalla webview | ➖ | Basso-medio | Medio (2 target) |
| **B2** + pipeline Rust | ✅✅ | ✅ | eredita dalla webview | ✅✅ | Medio | Medio |
| **B3** + WebGPU | ✅✅ | ✅ | ✅✅ | ✅✅ | Alto | Alto |
| **C** Nativo | ✅✅ | ✅ | ✅✅ | ✅✅ | **Altissimo** | **Altissimo** |
| **D** Composizione OS | ✅✅ | ✅ | ✅✅ | ✅✅ | **Altissimo** | **Ingestibile** |

Tre avvertenze su come si legge questa tabella, perché da sola induce in errore.

**Il Worker non riduce la memoria.** A3 sposta *dove* avviene la decodifica,
non *quanto* pesa la bitmap: una 1024×768 occupa 3MB nel worker esattamente
come nel thread principale. Su quell'asse A3 è **uguale** ad A1, non migliore.

**Tauri non peggiora né migliora la memoria: la eredita.** B1 e B2 valgono
quanto vale la strategia lato web che ci gira dentro.

**L'opzione D fallisce sull'interazione, non sull'import.** Comporre una
finestra nativa sopra una webview significa due loop di rendering da
sincronizzare a ogni scroll e zoom, più z-order, click-through, DPI misti fra
monitor e tearing del compositore. L'import in Rust andrebbe benissimo: è
l'interazione a rompersi.

> ⚠️ **Questa tabella nasconde la variabile che decide.** Su queste sei
> colonne C e B3 vincono quasi ovunque, perché la colonna che escluderebbe C
> non esiste: **quanto editing di testo bisogna riscrivere**. Shaping, line
> breaking Unicode, bidi, caret, selezione, IME. In webview lo dà il browser;
> in nativo sono anni-persona, compressi qui dentro la parola "Altissimo".
> Chi ottimizza la tabella sceglie il nativo. **Leggere §8 prima di
> concludere.**

---

## 7. Il ragionamento attuale (da attaccare)

1. **§3.1 e §3.2 sono problemi diversi e vanno risolti separatamente.**
   Confonderli porta a credere che "andare in locale" risolva la memoria.
   Non la risolve: Tauri è una webview.

2. **La memoria di decodifica si risolve nel renderer, non nello storage.**
   Le leve sono: decodificare alla dimensione che serve (`createImageBitmap`
   con `resizeWidth`), budget in **byte** e non in numero di bitmap, sfratto
   LRU con `close()`, decodifica solo dei nodi visibili, coda limitata.

3. **Il sistema si auto-bilancia** [S]: zoom alto e numero di immagini visibili
   sono inversamente proporzionali. A zoom 0,4 si vedono 300 immagini ma basta
   il livello più piccolo (~57MB totali); a zoom 3 servono 1024px ma il culling
   ne lascia a schermo una decina (~24MB). Non esiste uno stato che richieda
   **molte** immagini **e** ad alta risoluzione insieme.

4. **Lo storage e il rischio di perdita dati si risolvono andando desktop.**
   È l'argomento migliore per B1, più della quota.

5. **Il rich text vincola la famiglia C fuori dal tavolo**, finché resta il
   differenziatore del prodotto.

6. **Quindi**: A1 subito (funziona ovunque), B1 appena `rustup` è installato
   (l'interfaccia `AssetStore` rende il passaggio indolore), A2/B3 solo se la
   fluidità con centinaia di immagini si rivela insufficiente **dopo averla
   misurata**.

---

## 8. Il criterio che decide tutto

> **Il rich text dentro i nodi è *il* prodotto, o è un accessorio?**

- Se è il prodotto: **restare in webview**. Andare nativo significa buttare il
  differenziatore e ricostruirlo peggio.
- Se R-node diventasse un canvas di diagrammi ad altissime prestazioni con
  etichette semplici, allora la famiglia C diventa razionale e `wgpu` o Slint
  sono candidati seri.

Allo stato attuale il progetto è nettamente nel primo caso.

---

## 9. Domande aperte — è qui che serve il secondo parere

1. **Il budget di memoria di §7.2 è calibrato bene?** Un tetto di 128MB di
   bitmap decodificate è ragionevole per un'app desktop-like nel 2026, o è
   troppo aggressivo/conservativo? Esistono numeri pubblicati su cui basarsi?

2. **L'auto-bilanciamento di §7.3 regge davvero?** Esiste un pattern d'uso
   plausibile che richieda molte immagini ad alta risoluzione insieme — per
   esempio una mappa "moodboard" con 200 immagini grandi tutte visibili a zoom
   1? In quel caso l'argomento cade e serve A2.

3. **Il costo di A2 (WebGPU) è stato sovrastimato?** Il testo è già renderizzato
   in bitmap cache per nodo: riusarle come texture invece di costruire un
   atlante di glifi renderebbe il porting molto più economico di quanto stimato.
   Qualcuno ha esperienza di questo percorso specifico?

4. **Esiste una quarta famiglia che non ho considerato?** Per esempio: webview
   per l'editing di testo + finestra nativa per il canvas, composite a livello
   di OS. È una via reale o una complicazione senza ritorno?

5. **Sul rischio eviction (§3.3)**: quanto è concreto nella pratica per un'app
   che l'utente usa quotidianamente e che chiama `persist()`? Ci sono dati su
   quanto spesso Chrome effettivamente cancella origini persistite?

6. **Su C**: esiste oggi una libreria di rich text editing nativa, matura e
   multipiattaforma (Rust o Flutter) che renda la famiglia C meno proibitiva di
   come è descritta? Se sì, cambia il quadro.

---

## 10. Già valutato e scartato — non riproporre

| Proposta | Perché no |
|---|---|
| Immagini come data URL nel documento | localStorage regge ~5MB, il documento ne farebbe centinaia. Bloccherebbe anche il `JSON.parse` all'apertura. |
| Un elemento `<img>` per nodo, sopra il canvas | Viola il vincolo duro n.1: l'architettura a canvas singolo esiste per reggere migliaia di nodi. |
| Decodificare l'originale e scalarlo a schermo | Un originale da 12MP occupa 46MB decodificato per disegnarne 240 unità world. È esattamente il problema. |
| Aggiungere una cache al text measuring | **Già esiste** in `src/layout/measure.ts`, con chiave `weight\|italic\|size\|family\|text`. |
| Rendere atomiche le transazioni della history | **Già atomiche**: un `execOps` = una `HistoryEntry`. |
| Risolvere la race fra `layoutTimer` e `saveTimer` | **`saveTimer` non esiste**: il salvataggio è manuale. |
| Il canvas somma le larghezze dei token e accumula errore di wrap | **Ipotesi testata e smentita** con un caso dedicato nell'harness: 9/9 righe, altezze identiche. |
| SVG fra i formati immagine accettati | Documento eseguibile; l'hardening XSS è esplicitamente differito. |
| Monaco Editor al posto di Lexical | **Non è un'alternativa né una soluzione locale.** È una libreria web (gira comunque in webview) ed è un editor di *codice*: il suo modello è testo semplice, la colorazione è decorazione della vista calcolata da un tokenizer, quindi non può rappresentare formattazione autoriale come `TextRun[]`. In più è orientato a righe e monospazio, e avendo un proprio motore di layout invaliderebbe i 16 casi di parità. Avrebbe senso solo per una vista "sorgente" del documento (JSON/outline), che è una feature diversa. |
| Sostituire Lexical con ProseMirror / TipTap / Slate / Quill | Sono alternative *legittime* (a differenza di Monaco), ma cambiarle ora invaliderebbe la parità misurata e Lexical funziona. Da riaprire solo davanti a un problema concreto che Lexical non risolve, non per preferenza. |

---

## 11. Riferimenti nel repository

| File | Contenuto |
|---|---|
| `docs/ARCHITECTURE.md` | struttura, schema, piano per fasi, decisioni aperte |
| `docs/AGENT_GUIDE.md` | invarianti, contratto di parità, trappole già pagate |
| `docs/ROADMAP.md` | T12a–T15 specificano la feature immagini sull'ipotesi A1+B1 |
| `docs/RICH_TEXT_EDITOR.md` | come funziona il rich text, e perché la parità è difficile |
| `dev/parity.ts` | l'harness che misura la coincidenza editor↔canvas |
| `src/render/renderer.ts` | il renderer Canvas2D, isolato dietro una classe |
| `src/layout/measure.ts` | misura condivisa e costanti |
| `src-tauri/src/lib.rs` | i 4 comandi SQLite già scritti, mai compilati |
