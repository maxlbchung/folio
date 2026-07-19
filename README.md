# Folio

Folio is a compact, local-first document editor for arranging text, versions, drawings, images, video, and audio in a fixed-width document. It runs in the browser during development and ships as a Windows desktop app through Tauri 2.

## Product model

- A new folio is empty. Page inputs use ghost text; they do not insert sample content.
- Every page owns exactly one component. Components are never nested inside another page.
- Rows may contain one to four pages. Grouped pages split the same document width equally and share one bottom edge.
- Page handles and component controls stay outside the document width.
- Text pages stay compact. Version pages open at a minimum height that fits their control rail. Drawing and media pages fill their page and resize through the shared row height without shrinking below their minimum.
- Documents and media remain local. Native saves overwrite the current file unless Save As is requested.

The non-negotiable interaction and layout rules are recorded in [Product invariants](docs/PRODUCT_INVARIANTS.md).

## Features

- A local home library for creating, importing, reopening, renaming, and deleting folios
- Library views by last opened, creation date, last edited, or title, each ascending or descending
- Lookup across titles and folio text, with title matches first and text-only results ranked by frequency
- Rich text with Arial/Normal defaults, emphasis, underline, strikethrough, horizontal alignment, and vertical page anchoring
- Minimal text-version pages with selection, progress, deletion, and conversion to plain text
- Full-page vector drawing with pen, highlighter, eraser, undo, clear, and theme-reactive colors
- A single Media action that detects supported image, video, and audio file types
- Pointer-based page ordering, side-by-side grouping, full-row drop targets, and shared row resizing
- Page notes, deletion, front/back faces, structural undo/redo, workspace zoom, fullscreen, and light/dark/system themes
- ZIP-based `.folio` documents with separate binary assets
- IndexedDB folio catalog and recovery autosave, plus browser/Tauri open/save flows

## Quick start

Requirements: Node.js with npm. Desktop development also requires the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) and Rust.

```bash
npm install
npm run dev
```

Vite serves the browser build at the URL printed in the terminal. To run the native shell:

```bash
npm run tauri dev
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Vite development mode |
| `npm run build` | Type-check and create the production web bundle |
| `npm run check` | Check docs, build, archive round trip, and UI test syntax |
| `npm run test:archive` | Exercise `.folio` encode/decode with an asset |
| `npm run test:ui` | Run the Chromium interaction smoke suite |
| `npm test` | Run build, archive, and live UI smoke coverage |
| `npm run hooks:install` | Point Git at the tracked `.githooks` directory |
| `npm run release:desktop` | Validate, build Windows bundles, and refresh portable artifacts |

The UI smoke suite needs Chromium. Set `CHROMIUM_PATH` if Chromium is not available at the script's default location. See [Testing and release](docs/TESTING_AND_RELEASE.md) for the exact validation matrix and artifact locations.

## Architecture at a glance

```text
Toolbar / PageStack / PageView
              |
       DocumentContext
        /            \
 document state    runtime assets
        \            /
       archive + file system
       browser or Tauri shell
```

`DocumentContext` is the only mutation boundary for document structure. `pageRows` is the canonical visual arrangement and `pageOrder` is its flattened index. Media bytes live in a runtime asset map and are written beside `manifest.json` inside the `.folio` ZIP container.

Read [Architecture](docs/ARCHITECTURE.md) before changing state flow, page layout, dragging, persistence, or drawing behavior. Read [File format](docs/FILE_FORMAT.md) before changing persisted types or archive code.

## Repository map

```text
src/components/       Editor UI and page renderers
src/document/         Persisted types, factories, normalization, state mutations
src/persistence/      ZIP archive, native/browser file IO, recovery autosave
src/styles/           Shared application CSS and layout contracts
src-tauri/            Native Tauri shell, permissions, icons, and bundling
scripts/              Smoke tests, documentation checks, hooks, and release automation
docs/                 Architecture, invariants, format, testing, and release notes
skills/folio-app/      Project-local workflow skill for coding agents
.githooks/             Tracked Git hooks (installed explicitly)
```

## `.folio` files

A `.folio` file is a ZIP container with this shape:

```text
manifest.json
README.txt
assets/<uuid>.<extension>
```

The manifest identifier is `com.folio.document`; the current schema version is `1`. IDs are stable UUIDs within current documents. This project does not require backward compatibility: persisted changes may break old `.folio` files or local database data, and migration work should be added only when explicitly requested.

## Desktop artifacts

A Windows release produces:

- `Folio.exe` and `Folio_0.1.0_windows_x64_portable.zip` at the repository root
- MSI and NSIS installers below `src-tauri/target/release/bundle/`

Do not rebuild desktop artifacts for documentation-only changes. For changes that ship in the app, use `npm run release:desktop` so validation, bundles, portable copies, and hashes stay in sync.

## Agent support

Future coding agents should start with [AGENTS.md](AGENTS.md) and the local [Folio app skill](skills/folio-app/SKILL.md). Those files route work to the smallest relevant reference and preserve the product's layout and persistence contracts.

## Current boundaries

Collaboration, PDF export, print layout, and cloud synchronization are outside this local-first editor. Text formatting currently uses the browser editing engine; structural undo/redo is separate from native text editing history.
