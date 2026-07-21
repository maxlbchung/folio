# Testing and release

## Validation levels

### Documentation

```bash
npm run check:docs
```

This validates local Markdown links and required project handoff files.

### Fast project check

```bash
npm run check
```

This runs documentation checks, TypeScript/Vite production build, `.inktile` archive round trip, the Inkjet broker typecheck, and a syntax check of the UI smoke script. It deliberately does not pretend that checking the UI script syntax exercised the UI.

### Inkjet broker

```bash
npm run check:agent     # typechecks agent/*.mjs (checkJs, no install needed)
```

The broker (`agent/*.mjs`) is dependency-free plain Node — there is nothing to install and no standalone server: the desktop app spawns `agent/broker.mjs` itself and talks to it over stdio. Run `npm run check:agent` after touching anything under `agent/` or the shared protocol in `src/agent/`; it is also part of `npm run check`, so the pre-commit hook and release preflight catch a broken broker (a dangling import there crashes every Inkjet session in the shipped app). For manual debugging, `node agent/broker.mjs` speaks JSON lines on stdin/stdout (send `{"type":"probe"}` to get backend availability); it needs the Claude Code, Codex, and/or OpenCode CLI installed and signed in for real turns.

### UI interaction suite

```bash
npm run test:ui
```

This builds `dist-smoke/`, starts the test server, and drives Chromium through the main editor flows. Set `CHROMIUM_PATH` to a Chromium-family executable when the default location is unavailable.

The suite serves the smoke bundle from a loopback HTTP origin so IndexedDB and Web Crypto run in a browser-secure context. It covers the empty library; persisted Home theme and UI scale settings; inktile creation, rename, persisted and cached reopen, six repeated clean Home/Open cycles without accumulating latency, deletion, sort direction, unified title/text lookup ordered by the active view mode, and visible text occurrence counts; then text caret and formatting, versions pages sized to fit their control rail, media insertion, drawings, theme redraw, row grouping, constant/equal geometry, external rail order, zoom-correct resizing, content minimums, drop highlighting, separators, page deletion, download-free browser Ctrl+S flush plus export download, native autosave-to-path without any save gesture, Inkjet turns through a mocked broker transport (provider auto-detection greying out unavailable providers, model selection carried into the session, panel edge-drag resize, the auto-growing composer, the overlay transcript scrollbar, markdown answer rendering with in-progress notes confined to the ephemeral thinking bubble and a typewriter reveal observed mid-answer, read-only lock, live op streaming, stale-revision rejection, the full-control ops — rename, versions lifecycle, drawing authoring, notes, row resize, deletion, and audio insertion asserted to keep the true MIME of its bytes — single-undo-per-turn, stop keeping partial work, Exit session returning to setup), and return to the library.

If an environment-owned browser cannot initialize, record the exact error and still run `node --check scripts/ui-smoke.mjs`. Never report that as a passed UI run.

### Full web test

```bash
npm test
```

This runs the production build, archive test, and live UI suite.

## Tracked Git hook

Install the repository's pre-commit hook once per clone:

```bash
npm run hooks:install
```

The installer configures `core.hooksPath=.githooks`. The pre-commit hook runs `npm run check`. It is tracked and reviewable; no script writes directly into `.git/hooks`.

Use `npm run hooks:install -- --dry-run` to verify the installer without changing Git configuration.

## Windows desktop release

Requirements:

- Node dependencies installed;
- Rust toolchain and Tauri 2 Windows prerequisites;
- permission to write Tauri's target directory and root release artifacts.

Run:

```powershell
npm run release:desktop
```

The release hook performs these steps:

1. Run `npm run check`.
2. Run the optimized Tauri build.
3. Copy `src-tauri/target/release/inktile.exe` to root `Inktile.exe`.
4. Recreate `Inktile_<version>_windows_x64_portable.zip` from that executable.
5. Print SHA-256 hashes for portable and installer artifacts.

Expected outputs for version `0.1.0`:

```text
Inktile.exe
Inktile_0.1.0_windows_x64_portable.zip
src-tauri/target/release/bundle/msi/Inktile_0.1.0_x64_en-US.msi
src-tauri/target/release/bundle/nsis/Inktile_0.1.0_x64-setup.exe
```

Tauri already runs the frontend production build through `beforeBuildCommand`. The separate preflight is intentional because it also covers docs and archive behavior.

## Release discipline

- Rebuild desktop artifacts after user-visible code, persistence, dependency, version, Tauri configuration, icon, or permission changes.
- Do not rebuild for documentation, tests-only, agent instructions, skills, or hook changes.
- Keep `package.json` and `src-tauri/tauri.conf.json` versions aligned.
- Update `TEST_RESULTS.md` with the date, commands actually run, outcomes, and exact environment blockers.
- Hash artifacts after the final copy and ZIP operation, not before.
