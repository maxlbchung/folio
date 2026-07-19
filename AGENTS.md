# Folio agent instructions

These instructions apply to the entire repository.

## Start here

1. Read `skills/folio-app/SKILL.md` completely for Folio implementation, debugging, testing, persistence, or release work.
2. Read only the reference needed for the task:
   - `docs/PRODUCT_INVARIANTS.md` for any UI, layout, drag, resize, text, drawing, or control-rail change.
   - `docs/ARCHITECTURE.md` for state flow, component ownership, and likely edit locations.
   - `docs/FILE_FORMAT.md` for current persisted types, archive, and autosave behavior.
   - `docs/TESTING_AND_RELEASE.md` for validation and Windows artifacts.
3. Inspect the current implementation before editing. Treat existing user changes and generated release files as owned work.

## Non-negotiable contracts

- Keep the document width constant across all rows.
- Keep one component per page and no more than four pages in a row.
- Keep every page in a grouped row equal-height with one shared bottom resize edge; grouped widths default to equal and change only through the draggable vertical boundary between two pages.
- Clamp shrinking to the natural content minimum; cursor movement and visible resize movement must remain one-to-one at every workspace zoom.
- Keep left and right rails outside document width and ordered by page order.
- Keep new documents empty and placeholders non-persistent.
- Preserve stable text selection/caret behavior and compact text/version spacing.
- Legacy and backward compatibility are not project requirements. Prefer the simplest implementation for the current app; breaking old `.folio` files, IndexedDB data, or retired shapes is acceptable unless the user explicitly requests compatibility for a specific change.
- Native Save overwrites `currentPath`; Save As is the only normal path-changing action.

## Change workflow

- Put structural mutations in `DocumentContext`; keep `pageRows` canonical and synchronize `pageOrder`.
- Update factories and current-shape normalization when persisted fields or defaults change. Do not add migration or legacy-loading work unless explicitly requested.
- Update `scripts/ui-smoke.mjs` for changed user-visible behavior and `scripts/archive-smoke.ts` for persistence changes.
- Update the relevant doc when an invariant, format, command, or artifact changes.
- Prefer targeted edits; avoid replacing established editor behavior with a new UI system unless explicitly requested.

## Validation

- Documentation-only: `npm run check:docs`.
- TypeScript, state, archive, or non-visual changes: `npm run check`.
- UI/interaction changes: run `npm run test:ui` in addition to `npm run check` and inspect the app when a browser runtime is available.
- Shippable desktop changes: run `npm run release:desktop` after other checks.
- Do not claim the UI suite ran if only `node --check scripts/ui-smoke.mjs` ran. Record environmental failures precisely.
- Documentation-only or agent-support changes do not require rebuilding desktop binaries.

## Generated and release files

- `dist/`, `dist-smoke/`, `src-tauri/target/`, and TypeScript build info are generated.
- Root `Folio.exe` and the portable ZIP are release deliverables, not source.
- Never hand-edit archive contents or generated bundles.
