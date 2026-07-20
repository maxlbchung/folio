# Architecture

## Runtime layers

Inktile is a React 19 application compiled by Vite and hosted either in a browser or a thin Tauri 2 shell. The web and desktop builds share all editor state and behavior.

```text
App
├── Toolbar                         document-level commands and text formatting
└── PageStack                       rows, drag/drop, resize, external rails
    └── PageView                    one persisted page
        └── BlockRenderer           one component for a standard page

DocumentProvider                    document + assets + undo/redo + dirty/path state
├── factories / normalization       defaults and current-shape loading
├── inktileArchive                    ZIP encoding and decoding
├── fileSystem                      browser export download or Tauri filesystem
├── exportDocument                  .txt text extraction and PDF print-frame export
└── autosave                        IndexedDB recovery record
```

## Source map

| Area | Primary files |
| --- | --- |
| App boot, device preferences, recovery timer | `src/App.tsx`, `src/main.tsx`, `src/persistence/preferences.ts` |
| Inktile home, settings, search, sort, rename, pin, duplicate, delete | `src/components/InktileHome.tsx` |
| Header and document commands | `src/components/Toolbar.tsx` |
| Rows, drag targets, shared resizing | `src/components/PageStack.tsx` |
| Multi-tile selection, tile clipboard, tile shortcuts | `src/components/TileSelectionContext.tsx` |
| External handles and page faces | `src/components/PageView.tsx` |
| Text editing | `src/components/TextBlockView.tsx` |
| Versions | `src/components/VariantBlockView.tsx` |
| Drawing input and redraw | `src/components/DrawingCanvas.tsx` |
| Media rendering | `src/components/MediaBlocks.tsx` |
| Page creation and media dispatch | `src/components/PageInsertControl.tsx` |
| Persisted interfaces | `src/document/types.ts` |
| Defaults and loading normalization | `src/document/factories.ts` |
| State mutations and undo | `src/document/DocumentContext.tsx` |
| Archive format | `src/persistence/inktileArchive.ts` |
| Browser/native file IO | `src/persistence/fileSystem.ts` |
| Export format picker and .txt/PDF export | `src/components/ExportDialog.tsx`, `src/persistence/exportDocument.ts` |
| Recovery autosave | `src/persistence/autosave.ts` |
| Local inktile catalog | `src/persistence/library.ts`, `src/persistence/database.ts` |
| Geometry and visual contracts | `src/styles/app.css` |
| Native shell | `src-tauri/` |
| Inkjet protocol, connection, op application | `src/agent/protocol.ts`, `src/agent/connection.ts`, `src/agent/applyOp.ts` |
| Inkjet panel (provider/model setup + chat) | `src/components/InkjetPanel.tsx`, `src/components/InkjetMarkdown.tsx`, `src/components/ElementScrollbar.tsx` |
| Inkjet broker (zero-dependency, app-spawned) | `agent/*.mjs`, spawn commands in `src-tauri/src/lib.rs` |

## State model

`InktileDocument` is serializable. Runtime object URLs and media blobs are kept separately in `RuntimeAssetMap`; the document contains only `AssetMetadata`.

`DocumentContext` owns:

- the current document and runtime assets;
- dirty state and current native path;
- structural history (`past` and `future`, capped at 100);
- all document mutations and asset registration.

The `commit` helper clones the persisted document, applies a mutation, updates `modifiedAt`, optionally records structural history, and marks the document dirty. Continuous interactions such as typing or pointer movement normally avoid adding a history item on every event. Call `checkpoint()` once at the start of a gesture, update without history during it, and persist final geometry once at the end.

Multi-tile selection is editor UI state, not document state. `TileSelectionContext` (mounted around `PageStack` and `EditorContextMenu` in the editor view) owns the selected tile ids, an optional selected edge (an insertion point — a row edge between rows, the document-top edge, or a vertical column edge: a row's outer left edge, a boundary between grouped tiles, or its outer right edge; clicking the matching strip without dragging selects it, and paste plus the edge context menu insert there via `addPageAt`/`pastePagesAt`), the in-app tile clipboard (deep page snapshots, reset when a different document loads), and the tile-level keyboard shortcuts. The row- and column-resize gestures checkpoint on first pointer travel rather than pointer-down so a plain edge click leaves no undo entry. It acts on the document through the batch mutations in `DocumentContext` (`deletePages`, `duplicatePages`, `movePages`, `togglePagesSide`, `pastePages`), which apply each group operation as a single undoable commit; the single-page operations delegate to them. Group moves keep tiles that share a row together as one row segment, and rows whose membership changes reset their width split to the equal default.

## Pages and rows

`pageRows` is the canonical visual layout. Each inner array is one row in left-to-right order. `pageOrder` must always equal `pageRows.flat()` and exists as a flat index view.

Use `syncPageOrder` after structural row mutations. Loading passes through `normalizeDocumentPages`, which:

- removes missing and duplicate page references;
- splits any multi-block pages into one component per page;
- supplies current defaults such as vertical alignment;
- chunks oversized rows to the four-page maximum;
- adds valid pages omitted from old row data.

The row height is persisted as `layoutHeight` on every page in that row. Drawing height is synchronized with drawing data. Image and video pages fill their card and take their size from the same `layoutHeight` (currently seeded from a block `height` when present); they have no separate media resize control. Grouped pages default to equal width, and an optional `layoutWidthFraction` per page records a non-equal split (fractions sum to 1); dragging the vertical boundary between two adjacent cells redistributes only those two. Both the row-height and column-width gestures follow the same pattern: `checkpoint()` once at pointer-down, update the row DOM directly during movement for responsive cursor tracking, and commit the final geometry once on pointer release.

External handles and right rails are positioned from the row's outer edges rather than each page's own width. The row publishes its constant width as the `--inktile-row-width` CSS variable, and each cell's wrapper publishes `--inktile-cell-start` (`row width × the fraction before it`); `PageView` composes the handle and rail offsets from those two variables plus fixed pixel terms (the handle stack, the right-rail stack, and the versions-rail content padding). Because the row width never changes during a column drag, the only value that moves is the right cell's `--inktile-cell-start`, which `PageStack` updates in the pointer-move handler so every handle and rail stays pinned to the row edge until the commit re-renders consistent values.

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
InktileDocument + RuntimeAssetMap
        |
     encodeInktile
        |
   ZIP Blob / bytes
     /            \
browser export   Tauri filesystem
download         overwrite currentPath
```

Autosave is the save: after a short dirty-state debounce, one serialized persist writes the library snapshot, a confirmed (non-recovery) IndexedDB autosave record, and — in the native shell — the external file at `currentPath`. Native document writes are atomic (temp sibling + rename). Overlapping persists are chained so writes to the same file never interleave, and the dirty indicator clears only when no newer edit arrived during the persist.

No save gesture chooses a destination: Ctrl+S only flushes the pending persist immediately. Save As is the only action that opens the native destination dialog and changes `currentPath`, and the explicit export actions (the toolbar Export picker's `.inktile`/`.txt` choices or Ctrl+Shift+S) are the only browser paths that trigger a download.

The startup route is the inktile library. Its IndexedDB payload records are keyed by stable document ID and contain a complete encoded `.inktile` snapshot. A separate lightweight `library-index` store contains the derived catalog metadata: title, dates, last-opened time, page count, plain text, preview text, and an optional native path. Home reads only that index, and opening an inktile updates only its index entry, so repeated navigation does not deserialize or rewrite archive payloads. Creating, importing, editing, saving, or returning home with dirty state refreshes the snapshot. Clean returns perform no archive persistence. The current database version is 3 and currently derives index entries from version-2 payload records during upgrade, but that migration is an implementation detail rather than a compatibility contract.

Payload records also keep an IndexedDB-only working snapshot: a structured-cloned manifest plus the raw asset blobs. It is not part of the `.inktile` format. After an inktile has been opened, the working snapshot remains in the session cache so repeated opens can create fresh runtime object URLs without reading IndexedDB or parsing its ZIP again. Navigation renders the destination view before archive persistence, and identical document/asset state shares one in-flight or completed archive encoding across library and recovery writes.

Library lookup does not alter the document manifest. Searchable plain text is derived from text blocks, version text, and image alt text when a snapshot is written. Title and text matches share one result list ordered by the active last-opened, creation-date, or last-edited view and direction. Text matches carry a calculated occurrence count without overriding that view ordering.

Pinning stores a `pinned` flag on the `library-index` entry (and its cached record); Home renders pinned entries in a dedicated row above the unpinned grid. A save staged before the index cache warms must not drop an existing pin, so `library.ts` re-asserts the stored flag when staging. Duplication loads the source (session cache, working snapshot, or archive decode, in that order), deep-clones the document under a new ID with "<title> copy" and fresh dates, and saves it as a library-only inktile — the copy never inherits the source's external path.

Theme, UI scale, autosave, and library card size are application preferences rather than document content. `App.tsx` reads them synchronously from local storage, applies them to the root UI, and passes mutations to the Home Settings menu (card size is set from the library toolbar). UI scale zooms the whole application shell; the editor's document zoom remains an independent workspace control. The autosave preference gates the debounced persist effect: when off, leaving the editor or closing the window with dirty state raises a save/discard dialog instead of persisting silently.

## Inkjet

Inkjet is the built-in AI agent: it edits the currently open inktile from its panel with zero setup — in the desktop app, opening the panel is all it takes when Claude Code and/or Codex is installed and signed in on the machine (design history in [AGENT_INTEGRATION_PLAN.md](AGENT_INTEGRATION_PLAN.md)). The browser build cannot spawn processes, so Inkjet is a desktop feature.

Opening the panel auto-detects providers and shows only the usable ones (installed + signed in; with none, it explains what is missing per provider). The user picks a provider, picks a model from that provider's list (the broker owns the model catalog and ships it in its status message; "Default" defers to the CLI's own configuration), and presses **Start session**, which opens the chat view and resets any backend resume state so the conversation starts fresh. "New session" returns to the setup screen.

Chat view mechanics: the panel's left edge drags to resize (width persisted, 280–760px, UI-scale-aware); the composer grows with its content up to a cap instead of carrying a resize grip; the transcript hides the native scrollbar and is driven by `ElementScrollbar`, the vertical element-bound sibling of the workspace/row overlay scrollbars; and agent narration renders through `InkjetMarkdown`, a dependency-free renderer that builds React elements (never raw HTML, so model output cannot inject markup) for the chat subset of markdown — paragraphs, headings, lists, quotes, code, bold/italic, and links. Bubbles stop short of the far edge (the side each hugs marks its sender), animate in, and the model's live reasoning streams as an ephemeral, visually distinct "thinking" bubble (`thinking` protocol messages, kept out of `transcript`) that is dropped the moment a message lands or the turn ends — so it never reads as the final reply. The moving parts:

- **Broker.** `agent/broker.mjs` is dependency-free plain Node — no `node_modules`, nothing to install. The Tauri shell spawns it on demand (`agent_start` in `src-tauri/src/lib.rs`, which locates `agent/` next to the executable and a Node runtime on PATH) and bridges its stdin/stdout to the webview as events, so there is no listening socket between app and broker and no pairing step; the broker exits when its stdin closes and therefore cannot outlive the app. Its only network surface is a loopback streamable-HTTP MCP endpoint on an ephemeral port, guarded by a per-run bearer token that never leaves the process tree.
- **Backends drive the user's own CLIs.** Claude: the installed `claude` CLI headless (`--print --output-format stream-json`), with the MCP registration passed per run via `--mcp-config`/`--strict-mcp-config`, built-ins restricted to WebSearch/WebFetch, token-level narration, and extended-thinking deltas streamed as ephemeral reasoning (Codex forwards its `reasoning` items the same way). Codex: the installed `codex` CLI (`exec --json`) under the `read-only` sandbox with live web search, MCP registered through per-run `--config` overrides — nothing is written to `~/.codex/config.toml`. `agent/cli.mjs` finds the CLIs (native installs, PATH, or npm-global shims resolved to their real entries); a missing or signed-out CLI just reports itself unavailable in the panel.
- **Single writer.** The broker never touches `.inktile` files. Every mutation crosses the stdio protocol as a typed operation (`src/agent/protocol.ts`) and is applied by the app through the existing `DocumentContext` mutations (`src/agent/applyOp.ts`), so persistence, normalization, history, and the row/page invariants apply unchanged, and autosave stays the only file writer.
- **Tool surface — full document control.** `read_document` returns everything (title, rows, text HTML, notes, versions with drafts + active index, drawing stroke counts, row heights, width fractions, alignment); writes cover `set_title`, `append_text`/`edit_text`, `edit_notes` (back faces), `insert_page`/`delete_pages`/`arrange_pages`, `set_row_height`/`set_row_widths`/`set_vertical_align`, `create_drawing`/`edit_drawing` (normalized 0..1 strokes, append or replace), `insert_versions`/`edit_versions`/`convert_versions_to_text`, `create_image` (sanitized SVG), and `fetch_media`. Deletion included: everything reverts with the turn's single undo. `fetch_media` sniffs the downloaded bytes (magic numbers) and labels assets by what they actually are — mislabeled server MIME types are corrected and text/HTML responses are rejected instead of landing as unplayable media.
- **Turn lock.** Sending a prompt calls `beginAgentTurn()`: one undo checkpoint is recorded, `agentTurn` renders the workspace read-only (`workspace--agent-locked`, non-editable text blocks, a fixed "Inkjet is printing" indicator with Stop), and `commit` rejects non-agent mutations. Agent ops run inside `runAgentEdit`, which suppresses per-op history — an entire turn reverts with a single Ctrl+Z. Ops apply under `flushSync`, so each small append renders immediately (live typing).
- **Revision guard.** `DocumentContext` keeps a monotonic revision bumped by every mutation, undo/redo, and document switch. Write ops carry the revision they were computed against and are rejected on mismatch; the broker turns that into a tool error instructing the model to re-read. User edits between turns are therefore always observed.
- **Re-reads only when needed.** The broker remembers each document's revision at the end of the last cleanly finished turn. When the next prompt arrives with the same revision (and the CLI conversation is resumable, so the model still remembers the document), the turn is briefed "unchanged — skip read_document"; otherwise "changed" or "first". The briefing is enforced, not just suggested: on changed/first turns the broker seeds the op channel with a sentinel revision, so any write attempted before `read_document` bounces off the guard. Stopped or failed turns and "New session" clear the memory, forcing a fresh read.
- **Failure handling.** Stop, backend errors, and a dying broker all end the turn the same way: the lock releases, streamed content stays (still one undo step), and the panel reports what happened. Leaving the editor unmounts the panel, which stops the turn and detaches; the broker stays warm (it keeps per-document session ids for multi-turn resume) and exits with the app.
- **Testing.** `scripts/ui-smoke.mjs` drives the real panel through `window.__inktileAgentMock` (the same pattern as the Tauri IPC mock): lock behavior, live op streaming, stale-revision rejection, single-undo, and stop. `npm run check:agent` typechecks the broker modules.

## Native boundary

Tauri permissions are declared under `src-tauri/capabilities/`. JavaScript detects the native host with `window.__TAURI_INTERNALS__` and dynamically imports Tauri plugins, keeping the browser build usable without native APIs.
