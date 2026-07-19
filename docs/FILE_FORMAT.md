# `.folio` file format

## Container

A `.folio` document is a DEFLATE-compressed ZIP archive:

```text
manifest.json
README.txt
assets/<asset-id>.<extension>
```

`manifest.json` is UTF-8 JSON. `README.txt` is informational. Asset entries are addressed by the `internalPath` stored in their metadata; do not infer paths only from filenames.

## Identity and version

Every manifest starts with:

```json
{
  "format": "com.folio.document",
  "formatVersion": 1
}
```

The decoder rejects another format identifier or unsupported version. UUIDs provide stable identity for the document, pages, blocks, variants, assets, and drawing strokes.

## Compatibility policy

Folio only needs to support the current product and current persisted shape. Backward compatibility with older `.folio` files, prior IndexedDB schemas, retired fields, or legacy UI shapes is not a requirement. Prefer direct schema changes and simple current code; old local data may fail to load or be reset. Add a migration or compatibility shim only when the user explicitly requests one for that change.

## Manifest outline

```text
FolioDocument
├── format, formatVersion, id
├── title, createdAt, modifiedAt
├── settings
│   ├── theme
│   ├── pageWidth
│   └── contentPadding
├── pageOrder[]
├── pageRows[][]
├── pages{id -> FolioPage}
└── assets{id -> AssetMetadata}
```

The TypeScript source of truth is `src/document/types.ts`.

## Layout fields

- `pageRows` is the canonical row/column arrangement.
- `pageOrder` must equal `pageRows.flat()`.
- A row contains at most four page IDs.
- `layoutHeight` records the shared row height on every member page.
- `layoutWidthFraction` is optional and records a page's fraction of its row width (0..1). Absent means an equal split (`1 / rowSize`); a row whose fractions are invalid or do not sum to ~1 is normalized back to equal.
- `verticalAlign` is `top`, `center`, or `bottom`.
- `activeSide` selects `front` or `back`; the back face is optional until created.

The current `normalizeDocumentPages` implementation still repairs some previously produced shapes, but that behavior is incidental and may be removed when it complicates current work.

## Components

The block union currently includes text, image, video, audio, variants, drawing, and divider. New UI creates one component per page and does not expose divider creation. Drawing pages store their active `DrawingBlock` on the page rather than in the standard face.

Image and video sizing follows the page's shared `layoutHeight`. The current normalizer still recognizes the retired block `height` field, but preserving that behavior is not required.

Text and variants persist HTML. Do not insert placeholder or generated title content into those fields.

Drawing points are normalized coordinates. Stroke tools are pen, highlighter, or eraser, with width and opacity stored per stroke.

## Assets

An `AssetMetadata` entry records:

- stable ID;
- original filename and MIME type;
- byte length and content hash;
- ZIP `internalPath`.

At runtime, `RuntimeAssetMap` adds the `Blob` and an object URL. Those runtime-only fields must never be serialized into the manifest.

Assets are deduplicated by content hash when added. Decoding tolerates a missing asset entry by leaving it absent from the runtime map; renderers should remain defensive.

## Save semantics

- Browser saves create a download and cannot retain a writable path.
- Native Save writes to `currentPath` when present.
- Native Save As asks for a path and then updates `currentPath`.
- Writes use `create: true`, `createNew: false`, and `append: false`, so an existing file is replaced.
- Autosave encodes the same archive plus recovery/path metadata in IndexedDB.

## Local library catalog

The home-page library is application data, not part of the version-1 manifest. IndexedDB stores a complete `.folio` blob for each stable document ID in the `library` payload store. A separate `library-index` store holds derived title, date, last-opened, page-count, preview, plain-text, and optional native-path fields, allowing Home and last-opened updates to avoid reading or rewriting archive payloads. Payload records also store a working snapshot made from a structured-cloned manifest and raw asset blobs. The working snapshot avoids ZIP decoding on repeated library navigation and never enters `manifest.json`. Database version 3 currently migrates version-2 payload metadata into the lightweight index, but future schema changes do not need to retain that migration behavior.

Opening an external `.folio` decodes it through the normal archive path and adds a snapshot to the library. Deleting a library entry deletes only that IndexedDB record; a separately saved native file is left untouched. The current startup path also copies the single autosave record into the library when present.

## Schema-change checklist

1. Update `src/document/types.ts` and factories for the new current shape.
2. Update the encoder/decoder and database code directly; bump or reset schema versions when useful.
3. Extend `scripts/archive-smoke.ts` for the new round trip and `scripts/ui-smoke.mjs` for user-visible persistence behavior.
4. Remove obsolete compatibility code when it no longer helps the current implementation.
5. Update this document.

Do not add legacy fixtures, version bridges, or data migrations unless the user explicitly asks for compatibility.
