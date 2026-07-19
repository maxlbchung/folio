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
- The top header owns document title, text formatting, zoom, fullscreen, and appearance controls.

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
- Support horizontal text alignment and page-level vertical anchoring.
- Formatting controls remain in the top header and include bold, italic, underline, strikethrough, alignment, and reset behavior.

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
- Startup opens the local folio library. Creating a folio opens a new empty document and immediately adds it to that library.
- The library keeps a local `.folio` snapshot for every document created or opened on the device. Opening an external `.folio` imports it into the library without changing the archive format.
- Library deletion removes the catalog copy only. It must not silently delete a separately saved `.folio` file.
- Library views sort by last opened, creation date, last edited, or title in either direction.
- Lookup searches document titles and visible text. Title matches render first; text-only matches render afterward in descending match-frequency order.
- Native Save reuses the current file path. Save As is explicit.
- Recovery autosave retains the native path and distinguishes recovery data from a confirmed save.
- Asset IDs and document IDs remain stable through an archive round trip.
- Only the current product's persisted shape must be supported. Legacy `.folio` files and old local database data may break or be reset when the current design benefits; add compatibility only when explicitly requested.
