# Quiz mistake arrows

Right-click the topic holding a quiz. The red **Review** arrow beside the quiz
squares and **+** toggles study arrows for that topic's quizzes. Complete a quiz
first; the button becomes available after a wrong answer in a completed attempt.
The result window also offers **Show mistakes on map**.

Arrows point down at topics missed in the latest completed attempt of each quiz,
including text nodes inside freeform canvases. They stay legible as you zoom.
Correct answers in a retry clear the corresponding mistakes from that quiz;
other quizzes' mistakes remain. Collapsed topics collect their hidden children's
arrows until expanded. Answer records and review visibility survive save/reopen
and use the normal undo/redo operations. The arrows are study overlays; document
image/PDF exports omit them.

New **Copy as quiz prompt** output identifies outline topics and asks for
`sourceNodeIds` in every question. The parser keeps these optional for backward
compatibility. Source links are restricted to the quiz owner's current branch.
Missing/deleted/out-of-branch links fall back to the topic holding the quiz;
there is no guessed semantic match. Old quizzes with only a total score can also
mark that holding topic. Generate a new quiz from the updated prompt to get
individual source-topic arrows. Copy/paste remaps source links within the pasted
branch so arrows do not point back at the original topics.

Validation: quiz parser, prompt, wrong/correct retry, multi-quiz aggregation,
visibility/undo, invalid attempts, deleted/foreign source links, collapsed
targets and clipboard remapping are covered by automated tests. A React/jsdom
interaction test answers a question, finishes the quiz, checks that the attempt
is recorded once, shows the mistakes, and toggles them from the context menu.
The SQLite `.rnode` roundtrip test checks stored answers and source links.
Native Canvas2D screenshots were inspected at zoom 1 and 0.6. Real browser/Tauri
pointer interactions have not been smoke tested; jsdom does not prove layout.
