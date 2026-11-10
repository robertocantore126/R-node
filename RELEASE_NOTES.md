# R-node 0.2.1

A safety release: it closes several ways a map or its pictures could be lost. Maps saved with earlier versions open as before.

## Safer saving

- A save whose file was moved, renamed or deleted outside R-node now fails and says why, instead of silently recreating the file without its pictures.
- Duplicating a saved map now copies its pictures too.
- Auto layout and changing the map structure can be undone with Ctrl+Z, hand-placed topics included.
- A file with a broken topic tree is refused with a message instead of freezing the app. Broken links to missing topics are simply dropped.
- Opening a file whose map is already open with unsaved changes asks before replacing it.
- If the interface crashes, a screen offers to export the map as JSON instead of leaving a blank window.
- A save error now shows its real cause.
- Cleaning up unused images now actually shrinks the file. The temporary file for never-saved maps is emptied at every start.

## Web version

- Saving writes the file first, so a full browser storage no longer blocks it.
- The save dialog no longer falls back to a download on maps with many pictures.
- Deleting a map counts as an unsaved change until you save, so it does not come back after a reload.

## Quizzes

- Answers are shown in a shuffled order on each run (resume keeps the order, Retry reshuffles).
- The quiz prompt asks for more theory and no questions about the outline's own examples.

## Faster

- Adding pictures and the first save of a map with many pictures are much faster.
- Hovering, panning and drawing with the pen stay smoother on large maps.
- Deleting or copying many topics at once is faster.

## Other fixes

- A picture that failed to load is retried instead of staying broken until restart.
- One damaged picture no longer prevents opening the whole file.

## Install

- `R-node_0.2.1_x64-setup.exe`: installer (NSIS).
- `R-node_0.2.1_x64_en-US.msi`: installer (MSI).
- `r-node.exe`: portable, runs without installing.

The app is unsigned, so Windows SmartScreen may warn. Choose *More info → Run anyway*.
