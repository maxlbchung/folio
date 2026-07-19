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

This runs documentation checks, TypeScript/Vite production build, `.folio` archive round trip, and a syntax check of the UI smoke script. It deliberately does not pretend that checking the UI script syntax exercised the UI.

### UI interaction suite

```bash
npm run test:ui
```

This builds `dist-smoke/`, starts the test server, and drives Chromium through the main editor flows. Set `CHROMIUM_PATH` to a Chromium-family executable when the default location is unavailable.

The suite serves the smoke bundle from a loopback HTTP origin so IndexedDB and Web Crypto run in a browser-secure context. It covers the empty library; folio creation, rename, persisted and cached reopen, six repeated clean Home/Open cycles without accumulating latency, deletion, sort direction, title-first lookup, and frequency-ranked text results; then text caret and formatting, versions pages sized to fit their control rail, media insertion, drawings, theme redraw, row grouping, constant/equal geometry, external rail order, zoom-correct resizing, content minimums, drop highlighting, separators, page deletion, browser save, and return to the library.

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
3. Copy `src-tauri/target/release/folio.exe` to root `Folio.exe`.
4. Recreate `Folio_<version>_windows_x64_portable.zip` from that executable.
5. Print SHA-256 hashes for portable and installer artifacts.

Expected outputs for version `0.1.0`:

```text
Folio.exe
Folio_0.1.0_windows_x64_portable.zip
src-tauri/target/release/bundle/msi/Folio_0.1.0_x64_en-US.msi
src-tauri/target/release/bundle/nsis/Folio_0.1.0_x64-setup.exe
```

Tauri already runs the frontend production build through `beforeBuildCommand`. The separate preflight is intentional because it also covers docs and archive behavior.

## Release discipline

- Rebuild desktop artifacts after user-visible code, persistence, dependency, version, Tauri configuration, icon, or permission changes.
- Do not rebuild for documentation, tests-only, agent instructions, skills, or hook changes.
- Keep `package.json` and `src-tauri/tauri.conf.json` versions aligned.
- Update `TEST_RESULTS.md` with the date, commands actually run, outcomes, and exact environment blockers.
- Hash artifacts after the final copy and ZIP operation, not before.
