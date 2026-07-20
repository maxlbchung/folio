# Product invariants

These rules capture deliberate product decisions. Treat them as acceptance criteria unless the user explicitly changes one.

## Document geometry

1. The document has one constant outer width. A row never widens because it contains more pages.
2. A row contains one to four pages. Grouped pages divide the available width equally by default, but the user may drag the vertical boundary between two adjacent pages to change how those two split the row. Only that split changes; the document's constant outer width never changes, and each page keeps a per-page minimum width.
3. Pages in the same row stretch to one shared height and share the entire bottom edge.
4. The row resize target spans the full document width. Expanding and shrinking visually follow the pointer one-to-one, including when workspace zoom is not 100%.
5. A row cannot shrink below the largest natural minimum of its pages. Text must not compact or clip existing content; drawings clamp to `MIN_DRAWING_HEIGHT`, image/video pages clamp to `MIN_MEDIA_HEIGHT`, and versions pages clamp to `MIN_VERSIONS_HEIGHT` so their control rail never extends past the card.
6. Horizontal insertion highlights span the complete line above or below a row. Side insertion highlights the relevant vertical page edge.
7. Horizontal separators between stacked rows and vertical separators between grouped pages run all the way through the shared boundary.

## Controls and rails

- Each page has one narrow left handle rendered outside the page.
- Left rails are ordered by page order from left to right before the document.
- Page notes and deletion live in the left handle.
- Version and drawing controls render as right-side rails outside the document.
- Right rails follow page order: controls for the first page are furthest left.
- Rails do not consume or change document width.
- Handles and right rails are positioned from the row's constant outer edges, not each page's own box, so they stay fixed while a column-boundary drag changes how two pages split the row.
- Right rails anchor to the top of their page card.
- The top header owns document title, text formatting, document zoom, and fullscreen controls.
- Home owns an extensible Settings menu for device-level preferences: theme, UI scale, the autosave toggle, and a native fullscreen switch. Theme, UI scale, and autosave apply to Home and the editor and persist between sessions; fullscreen is live window state.
- UI scale rescales the whole interface in place: the layout keeps filling the viewport width, stays horizontally centered, and never introduces horizontal overflow.

## Tile selection

- Ctrl/Cmd+Click on a tile's left handle toggles it in and out of a multi-selection. A plain handle click (press and release without movement) selects only that tile, releasing any others; starting a drag from an unselected handle selects it first, while dragging a selected handle keeps and moves the whole group.
- Ctrl+A selects every tile unless an editable field has focus, where it keeps its native select-all-text meaning. Escape clears the selection; so does a plain left click anywhere other than a handle.
- Selected tiles show a selection ring on both the tile card and its left handle, and act as one group: dragging any selected handle moves the whole selection (tiles taken from one row stay grouped; a side drop still respects the four-per-row maximum), Delete/Backspace deletes, Ctrl+C/X/V copy, cut, and paste through an in-app tile clipboard, Ctrl+D duplicates, and F flips between page and notes.
- Right-clicking a selected tile opens a menu with the same group actions; right-clicking an unselected tile retargets the selection to it first. The tile clipboard is document-local and resets when another inktile opens.
- Edges double as insertion points: a plain click (not a drag, which still resizes) selects the edge, Ctrl+V pastes there, and right-clicking an edge opens a menu with "Add tile here" and "Paste here". Selectable edges are each row's bottom strip, the strip above the first row (the document top), and the vertical edges of each row — its outer left edge, each boundary between grouped tiles, and its outer right edge. Vertical edges insert into that row at that column and respect the four-per-row maximum (menu items disable and paste reports when tiles will not fit). Edge selection and tile selection are mutually exclusive, and Escape or a click elsewhere clears either.
- Tile shortcuts and the tile clipboard never fire while an input or rich-text field owns the keyboard, so text editing keeps native shortcuts.

## Page ownership

- Every page owns exactly one component: text, versions, drawing, image, video, or audio.
- Never add an interface for inserting another component inside an existing page.
- Do not restore the Rule/divider page type to the add-page menu.
- The add menu exposes one Media action. File type selects image, video, or audio; unsupported formats produce a visible error.
- Drawing pages have no title and the canvas fills the page.
- Version pages have no generated title; users may type title-like content themselves.

## Text behavior

- New text and versions are empty. Placeholder text is visual-only and disappears as the user types.
- Typing must not move the caret to the beginning.
- Do not show a decorative left rule while editing text.
- Text and version pages use minimal, matched top and bottom spacing.
- Font controls default to Arial and Normal; do not add blank placeholder options.
- Support horizontal text alignment and page-level vertical anchoring. New pages anchor text to the top; middle and bottom stay selectable per page.
- Formatting controls remain in the top header and include bold, italic, underline, strikethrough, alignment, and reset behavior.
- Formatting controls reflect the current selection: the font and size dropdowns follow the caret's tile (so switching tiles updates them), and the bold, italic, underline, strikethrough, and alignment buttons show an active state while that style is in effect.
- The Ctrl+B / Ctrl+I / Ctrl+U shortcuts run through the same command path as the toolbar buttons, so toggling a style at a collapsed caret updates its highlight immediately rather than lagging until the next keystroke.

## Drawing behavior

- New drawings start at `MIN_DRAWING_HEIGHT`.
- The canvas fills all available page area and redraws whenever its CSS size changes.
- Theme changes redraw existing strokes immediately; they must not wait for the next pointer input.
- Drawing controls live in the external right rail.

## Media behavior

- Image and video pages fill their page edge-to-edge with zero padding; the media occupies the whole card using its fit mode.
- Media size follows the shared row-height resize on the page's bottom edge. There is no per-media resize control.
- Image/video pages clamp to `MIN_MEDIA_HEIGHT`; new image/video pages open at their block height (default 420).
- Audio pages keep the compact inline treatment and are not full-bleed.

## Persistence behavior

- A new document has no pages and no sample assets.
- Startup opens the local inktile library. Creating an inktile opens a new empty document and immediately adds it to that library.
- The library keeps a local `.inktile` snapshot for every document created or opened on the device. Opening an external `.inktile` imports it into the library without changing the archive format.
- Library deletion removes the catalog copy only. It must not silently delete a separately saved `.inktile` file.
- Library views sort by last opened, creation date, or last edited in either direction. Title is not a view mode.
- Lookup searches document titles and visible text, combines both kinds of matches in one result list, and keeps that list ordered by the active library view mode and direction. Text occurrence counts remain visible.
- A library card can be pinned. Pinned inktiles render in a dedicated horizontally scrollable row at the top of Home beside the New and Open action cards; unpinned cards fill the grid below. Pin state is device-level library data, never part of the document or its archive.
- A library card can be duplicated. The copy is a fresh library-only inktile with a new ID, "<title> copy" as its name, fresh dates, and no tie to the source's external file path.
- The library toolbar's card-size control (small, medium, large) is a device-level preference applied to every card grid, including search results and the pinned row.
- With autosave on (the default), editing autosaves continuously after a short debounce: the local-library snapshot always, plus the external file at the current native path when one exists. No explicit save gesture is required.
- With autosave off, the debounced persistence is suspended; leaving the editor or closing the window with unsaved edits asks to save or discard first, so edits are never dropped silently.
- Native document writes are atomic: bytes go to a temp sibling that is renamed over the target, so a crash mid-write never leaves a truncated `.inktile`.
- Ctrl+S only flushes the same persistence immediately. Save As is the only path-choosing action, and Export actions are the only browser actions that produce downloads.
- The toolbar Export button opens a format picker: `.inktile` archive (same as Ctrl+Shift+S), PDF through the system print dialog, or a plain-text `.txt` that keeps every tile's text, all versions, and notes.
- Autosave records are confirmed (non-recovery) snapshots; the recovery flag remains readable so older records still import on startup.
- Asset IDs and document IDs remain stable through an archive round trip.
- Only the current product's persisted shape must be supported. Legacy `.inktile` files and old local database data may break or be reset when the current design benefits; add compatibility only when explicitly requested.
