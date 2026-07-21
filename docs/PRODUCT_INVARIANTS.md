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
- Interactive cursors use the same rounded, monochrome ink-line family across Home and the editor. Their semantic shapes remain distinct (pointer, text, grab, drawing crosshair, and resize), rendering black in light mode and white in dark mode.
- UI scale rescales the whole interface in place: the layout keeps filling the viewport width, stays horizontally centered, and never introduces horizontal overflow.

## Tile selection

- Ctrl/Cmd+Click on a tile's left handle toggles it in and out of a multi-selection. A plain handle click (press and release without movement) selects only that tile, releasing any others; starting a drag from an unselected handle selects it first, while dragging a selected handle keeps and moves the whole group.
- Ctrl+A selects every tile unless an editable field has focus, where it keeps its native select-all-text meaning. Escape clears the selection; so does a plain left click anywhere other than a handle.
- Selected tiles show a selection ring on both the tile card and its left handle, and act as one group: dragging any selected handle moves the whole selection (tiles taken from one row stay grouped; a side drop still respects the four-per-row maximum), Delete/Backspace deletes, Ctrl+C/X/V copy, cut, and paste through an in-app tile clipboard, Ctrl+D duplicates, and F flips between page and notes.
- Right-clicking a selected tile opens a menu with the same group actions; right-clicking an unselected tile retargets the selection to it first. The tile clipboard is document-local and resets when another inktile opens.
- Edges double as insertion points: a plain click (not a drag, which still resizes) selects the edge, Ctrl+V pastes there, and right-clicking an edge opens a menu with one "Add" entry per tile type — text, versions, drawing, and media (via the file picker) — plus "Paste here". The tile and background context menus offer the same per-type add entries (below the tile, or at the document end). Selectable edges are each row's bottom strip, the strip above the first row (the document top), and the vertical edges of each row — its outer left edge, each boundary between grouped tiles, and its outer right edge. Vertical edges insert into that row at that column and respect the four-per-row maximum (menu items disable and paste reports when tiles will not fit). Edge selection and tile selection are mutually exclusive, and Escape or a click elsewhere clears either.
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
- Formatting controls remain in the top header. Font, size, bold, italic, underline, strikethrough, subscript, superscript, text color, highlight color, and horizontal alignment render inline; bulleted/numbered/checklist lists, links, table insertion, math insertion, divider-line insertion (the same `<hr>` as the `---` autoformat), vertical text anchoring, and clear formatting live in the header's More-formatting dropdown — a single horizontal row of icon buttons whose top-right corner aligns with the More button's bottom-right, which carries the UI scale (its buttons render the same size as the header's), and which preserves the text selection while open.
- The tile handle's notes button shows the flip glyph on both sides — the action is always "flip", whichever face is showing.
- Links are plain `<a href>` (http, https, or mailto only — other schemes are stripped). The webview itself never navigates: a plain click inside a tile opens the link popover — the display text and destination both editable in place (Apply/Remove, each one undo step), an Open action that launches the destination externally, and a preview — on desktop the page's own Open Graph card (image, title, description) unfurled by the native shell, otherwise a small inert live embed that appears only once the page has provably loaded (sites that refuse embedding simply show no preview section, and a card image that fails to load disappears) — while Ctrl/Cmd+Click opens the link externally right away. The URL-only link editor still opens from the dropdown or Ctrl+K for creating links at the caret or selection. Typing a URL followed by a space autolinks it, and so does pasting one (Ctrl+V or the context menu): at a caret the URL inserts as linked text, over a selection it links the selected text — never inside an existing link. Plain-text export renders `text (url)` unless the text already is the URL.
- Formatting controls reflect the current selection: the font and size dropdowns follow the caret's tile (so switching tiles updates them), and the style buttons show an active state while that style is in effect.
- The Ctrl+B / Ctrl+I / Ctrl+U shortcuts run through the same command path as the toolbar buttons, so toggling a style at a collapsed caret updates its highlight immediately rather than lagging until the next keystroke.
- Toggling subscript/superscript at a collapsed caret raises or lowers the caret immediately, before any typing; the invisible caret anchors this requires never reach stored or exported HTML.
- Spellcheck squiggles appear only in the tile currently being edited; tiles show no spelling markers once they lose focus.
- Documents store text and highlight colors as their canonical light-theme values, so archives are theme-independent and PDF/print output (rendered on white) needs no mapping.
- In dark mode, only greyscale text colors mirror (black renders as white, greys flip lightness); hue colors render identically in both themes. This is the intended contract, not an omission.
- Pale highlights keep their color in dark mode, and a highlighted run renders as a light-mode island (default text inside goes dark, mirrored greys keep their light value) so it stays readable and looks the same in both themes; the grey highlight mirrors like greyscale text does.
- Checklists are decorated unordered lists (`ul.checklist`, items carrying `data-checked`). Clicking an item's box toggles it without moving the caret or editing text, each toggle is one undo step, and Enter after a checked item starts an unchecked one. Checked items render muted and struck through.
- Tables are plain HTML tables (`table.text-table`) inside the text flow. Tab and Shift+Tab step through cells, Tab on the last cell appends a row, Up/Down arrows step between rows in the same column (multi-line cells keep native line movement until the caret reaches their boundary line, and the caret leaves the table naturally from the first/last row), and row/column insertion and deletion live in the right-click menu over a cell.
- Math fields are atomic, non-editable spans that persist ONLY their TeX source (`data-tex`, plus `data-display` for centered blocks). KaTeX renders them at display time into a shadow root that never reaches stored, archived, or exported HTML; clicking a field opens the math editor; PDF export bakes static KaTeX markup instead.
- Markdown-style autoformat: at the start of a line, `- `/`* `, `1. `, `[] `, `[x] `, `# `, and `## ` convert on the space (lists, checklists, and the Heading/Large sizes), and `---` followed by Enter becomes a horizontal rule. One undo restores the literal typed marker.
- Plain-text export keeps the new structures legible: checklist items as `[x] `/`[ ] ` lines, table rows as ` | `-separated lines, and math as `$…$` or `$$…$$` TeX.
- Undo/redo must be immediately visible: restoring history releases rich-text focus first, because a focused tile never repaints from state (the caret-protection guard). Discrete in-tile actions — checkbox toggles, table structure edits, math saves and removals, autoformat conversions — each get their own undo step.
- Ctrl+Z / Ctrl+Y inside single-line inputs and textareas (the document title, the math editor's TeX source) keep the browser's native text undo; structural undo owns the tiles.

## Drawing behavior

- New drawings start at `MIN_DRAWING_HEIGHT`.
- The canvas fills all available page area and redraws whenever its CSS size changes.
- The drawing cursor's circle matches the active tool's rendered stroke diameter exactly, including the eraser's doubled width, workspace zoom, and UI scale; its fixed crosshair prongs do not count toward that diameter.
- Theme changes redraw existing strokes immediately; they must not wait for the next pointer input.
- Drawing controls live in the external right rail.

## Media behavior

- Image and video pages fill their page edge-to-edge with zero padding; the media occupies the whole card using its fit mode.
- Media size follows the shared row-height resize on the page's bottom edge. There is no per-media resize control.
- Image/video pages clamp to `MIN_MEDIA_HEIGHT`; new image/video pages open at their block height (default 420).
- Audio pages keep the compact inline treatment and are not full-bleed.

## Inkjet turn presentation

- Agent edits commit to document state instantly — acks, the revision guard, undo, and autosave never wait on visuals. Only the on-screen reveal is animated.
- Reveals run through one sequential queue, quickly but one at a time: text types out (and deletes backward) like a fast typewriter, drawing strokes draw point by point one stroke at a time (removed strokes erase one by one; moved or restyled strokes glide), and agent row resizes ease briefly. The user's own drag-resizes stay one-to-one with the pointer.
- While a turn runs, a full-viewport scrim dims and blocks everything except the Inkjet panel, its toggle, and the printing indicator with its Stop button — the only interactive surfaces during a turn. Wheel scrolling still works so the user can follow the agent around the document.
- Stop or turn end snaps every in-flight reveal to the committed document state, and `prefers-reduced-motion` disables the reveals entirely (edits appear instantly).
- Newly created tiles fade in briefly (~0.3s), whoever makes them — user inserts, paste, redo, or agent ops. Tiles already present when the document opened never animate.
- The printing indicator carries a follow toggle beside Stop: while armed, the viewport smoothly centers (y only) on the tile the agent is currently working on. Any manual document scroll — wheel or a page-scrolling key outside the panel — disarms it automatically; scrolling the chat transcript does not.

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
