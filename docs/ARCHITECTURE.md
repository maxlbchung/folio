# Architecture

## Runtime layers

Folio is a React 19 application compiled by Vite and hosted either in a browser or a thin Tauri 2 shell. The web and desktop builds share all editor state and behavior.

```text
App
├── Toolbar                         document-level commands and text formatting
└── PageStack                       rows, drag/drop, resize, external rails
    └── PageView                    one persisted page
        └── BlockRenderer           one component for a standard page

DocumentProvider                    document + assets + undo/redo + dirty/path state
├── factories / normalization       defaults and current-shape loading
├── folioArchive                    ZIP encoding and decoding
├── fileSystem                      browser download or Tauri filesystem
└── autosave                        IndexedDB recovery record
```

## Source map

| Area | Primary files |
| --- | --- |
| App boot, theme, recovery timer | `src/App.tsx`, `src/main.tsx` |
| Folio home, search, sort, rename, delete | `src/components/FolioLibrary.tsx` |
| Header and document commands | `src/components/Toolbar.tsx` |
| Rows, drag targets, shared resizing | `src/components/PageStack.tsx` |
| External handles and page faces | `src/components/PageView.tsx` |
| Text editing | `src/components/TextBlockView.tsx` |
| Versions | `src/components/VariantBlockView.tsx` |
| Drawing input and redraw | `src/components/DrawingCanvas.tsx` |
| Media rendering | `src/components/MediaBlocks.tsx` |
| Page creation and media dispatch | `src/components/PageInsertControl.tsx` |
| Persisted interfaces | `src/document/types.ts` |
| Defaults and loading normalization | `src/document/factories.ts` |
| State mutations and undo | `src/document/DocumentContext.tsx` |
| Archive format | `src/persistence/folioArchive.ts` |
| Browser/native file IO | `src/persistence/fileSystem.ts` |
| Recovery autosave | `src/persistence/autosave.ts` |
| Local folio catalog | `src/persistence/library.ts`, `src/persistence/database.ts` |
| Geometry and visual contracts | `src/styles/app.css` |
| Native shell | `src-tauri/` |

## State model

`FolioDocument` is serializable. Runtime object URLs and media blobs are kept separately in `RuntimeAssetMap`; the document contains only `AssetMetadata`.

`DocumentContext` owns:

- the current document and runtime assets;
- dirty state and current native path;
- structural history (`past` and `future`, capped at 100);
- all document mutations and asset registration.

The `commit` helper clones the persisted document, applies a mutation, updates `modifiedAt`, optionally records structural history, and marks the document dirty. Continuous interactions such as typing or pointer movement normally avoid adding a history item on every event. Call `checkpoint()` once at the start of a gesture, update without history during it, and persist final geometry once at the end.

## Pages and rows

`pageRows` is the canonical visual layout. Each inner array is one row in left-to-right order. `pageOrder` must always equal `pageRows.flat()` and exists as a flat index view.

Use `syncPageOrder` after structural row mutations. Loading passes through `normalizeDocumentPages`, which:

- removes missing and duplicate page references;
- splits any multi-block pages into one component per page;
- supplies current defaults such as vertical alignment;
- chunks oversized rows to the four-page maximum;
- adds valid pages omitted from old row data.

The row height is persisted as `layoutHeight` on every page in that row. Drawing height is synchronized with drawing data. Image and video pages fill their card and take their size from the same `layoutHeight` (currently seeded from a block `height` when present); they have no separate media resize control. Grouped pages default to equal width, and an optional `layoutWidthFraction` per page records a non-equal split (fractions sum to 1); dragging the vertical boundary between two adjacent cells redistributes only those two. Both the row-height and column-width gestures follow the same pattern: `checkpoint()` once at pointer-down, update the row DOM directly during movement for responsive cursor tracking, and commit the final geometry once on pointer release.

External handles and right rails are positioned from the row's outer edges rather than each page's own width. The row publishes its constant width as the `--folio-row-width` CSS variable, and each cell's wrapper publishes `--folio-cell-start` (`row width × the fraction before it`); `PageView` composes the handle and rail offsets from those two variables plus fixed pixel terms (the handle stack, the right-rail stack, and the versions-rail content padding). Because the row width never changes during a column drag, the only value that moves is the right cell's `--folio-cell-start`, which `PageStack` updates in the pointer-move handler so every handle and rail stays pinned to the row edge until the commit re-renders consistent values.

## Component ownership

A standard page renders exactly one block from its active face. A drawing page owns its drawing object directly. The current format still models a `blocks` array and divider type, while UI creation enforces one component per page and does not expose divider pages.

To add or change a component type:

1. Update the union and persisted fields in `src/document/types.ts`.
2. Add factory/default/normalization behavior in `src/document/factories.ts`.
3. Add context operations if the component needs structural mutation.
4. Route creation through `PageInsertControl` and rendering through `BlockRenderer` or a page-specific renderer.
5. Preserve one-component ownership and the row geometry invariants.
6. Add archive coverage for persisted data and UI smoke coverage for interaction.

## Text editing

Text uses `contentEditable` and stores HTML. Browser selection is global, while formatting controls live outside each page, so changes must preserve the active selection and avoid React rewrites that reset the caret. Structural undo/redo does not replace the browser's native text editing history.

## Drawing

Drawing strokes store normalized points, so they scale with the canvas. Canvas bitmap dimensions follow its rendered rectangle. A `ResizeObserver` redraws strokes during row resizing, and a theme observer redraws when appearance changes. Keep CSS flex sizing independent from intrinsic canvas bitmap attributes so the bitmap cannot resist row shrinking.

## Persistence flow

```text
FolioDocument + RuntimeAssetMap
        |
     encodeFolio
        |
   ZIP Blob / bytes
     /          \
browser       Tauri filesystem
download      overwrite currentPath
```

Autosave uses the same archive encoding and writes one IndexedDB recovery record after a short dirty-state delay. A successful native save writes a non-recovery autosave carrying the confirmed path.

The startup route is the folio library. Its IndexedDB payload records are keyed by stable document ID and contain a complete encoded `.folio` snapshot. A separate lightweight `library-index` store contains the derived catalog metadata: title, dates, last-opened time, page count, plain text, preview text, and an optional native path. Home reads only that index, and opening a folio updates only its index entry, so repeated navigation does not deserialize or rewrite archive payloads. Creating, importing, editing, saving, or returning home with dirty state refreshes the snapshot. Clean returns perform no archive persistence. The current database version is 3 and currently derives index entries from version-2 payload records during upgrade, but that migration is an implementation detail rather than a compatibility contract.

Payload records also keep an IndexedDB-only working snapshot: a structured-cloned manifest plus the raw asset blobs. It is not part of the `.folio` format. After a folio has been opened, the working snapshot remains in the session cache so repeated opens can create fresh runtime object URLs without reading IndexedDB or parsing its ZIP again. Navigation renders the destination view before archive persistence, and identical document/asset state shares one in-flight or completed archive encoding across library and recovery writes.

Library lookup does not alter the document manifest. Searchable plain text is derived from text blocks, version text, and image alt text when a snapshot is written. Title matches are separated from text-only matches; text-only results carry a calculated occurrence count and are ordered most frequent first.

## Native boundary

Tauri permissions are declared under `src-tauri/capabilities/`. JavaScript detects the native host with `window.__TAURI_INTERNALS__` and dynamically imports Tauri plugins, keeping the browser build usable without native APIs.
