---
name: folio-app
description: Build, debug, extend, validate, and release the Folio React/Vite/Tauri local-first document editor. Use for Folio page layout, dragging, grouped rows, resizing, text or version editing, drawing, media, themes, `.folio` persistence, autosave, desktop packaging, project documentation, or future-agent handoff work.
---

# Folio app

## Orient

Read the smallest relevant project references before editing:

- Read `../../../docs/PRODUCT_INVARIANTS.md` for every user-visible UI or interaction change.
- Read `../../../docs/ARCHITECTURE.md` for ownership, state flow, and source routing.
- Read `../../../docs/FILE_FORMAT.md` before changing persisted types, archives, assets, save behavior, or autosave.
- Read `../../../docs/TESTING_AND_RELEASE.md` before validating or rebuilding desktop artifacts.

Inspect the affected source and current workspace state. Preserve unrelated changes and root release deliverables.

## Implement

Route work by responsibility:

- Put document structure and mutations in `src/document/DocumentContext.tsx`.
- Put persisted interfaces in `src/document/types.ts` and current defaults/loading normalization in `src/document/factories.ts`.
- Keep row drag, grouping, and shared resize logic in `src/components/PageStack.tsx`.
- Keep external page rails and face behavior in `src/components/PageView.tsx`.
- Use the component-specific renderer for text, versions, drawing, or media behavior.
- Treat `src/styles/app.css` as part of the geometry contract, not cosmetic cleanup.
- Keep browser/native differences inside `src/persistence/fileSystem.ts` or the Tauri boundary.

Maintain `pageRows` as canonical and synchronize `pageOrder`. Preserve one component per page, a four-column maximum, constant document width, equal grouped height with default-equal (but draggable) grouped widths, external control rails, content-aware minimum heights, and empty placeholder-only defaults.

Legacy files, old IndexedDB schemas, and backward compatibility are not requirements. Optimize for the current product and keep persistence changes simple, even when they break old local data. Add compatibility code or migrations only when the user explicitly asks for them.

For continuous pointer gestures, checkpoint once, update visible DOM without cloning the full document on every move, and persist the final value once. Account for workspace zoom when mapping screen-space deltas to layout-space values.

## Verify

Update tests with behavior:

- Extend `scripts/archive-smoke.ts` for format or persistence changes.
- Extend `scripts/ui-smoke.mjs` for user-visible behavior or regressions.
- Update the matching project reference when a contract or workflow changes.

Run the narrowest sufficient commands:

```text
docs only                 npm run check:docs
logic or persistence      npm run check
UI interaction            npm run check, then npm run test:ui
desktop shipping change   npm run release:desktop
```

Report UI runtime failures honestly. A syntax check is not an interaction run. Skip desktop artifact rebuilds for docs-only, skills-only, tests-only, or hook-only changes.

## Release

Use `npm run release:desktop` for a shippable desktop change. Confirm that it refreshes the root executable and portable ZIP, produces MSI and NSIS installers, and prints hashes after all copies are complete. Update `TEST_RESULTS.md` with only the commands and results actually observed.
