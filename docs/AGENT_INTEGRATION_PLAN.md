# Agent integration plan

Status: **implemented, then reworked for zero setup, shipped as "Inkjet"** (July 2026) — the living description is the Inkjet section of [ARCHITECTURE.md](ARCHITECTURE.md); this document is the design history. The panel opens on a provider-selection screen that lists only auto-detected usable providers, then a model choice (broker-owned catalog), then Start session into the chat view.

**v2 rework (same month):** the original ask hardened into "no installation, no setup — if the CLI is installed and logged in, it just works". That obsoleted two decisions below: the SDK-based broker (whose npm dependencies were themselves an install step) and the WebSocket topology (which required starting a server and pairing a token). The shipped shape instead: a **dependency-free** `agent/*.mjs` broker that drives the user's already-installed `claude` (`--print --output-format stream-json`) and `codex` (`exec --json`) CLIs directly; the desktop shell spawns it on demand and bridges **stdio** to the webview (no socket, no token, dies with the app); the MCP endpoint is hand-rolled on `node:http` (stateful streamable-HTTP sessions, per-run bearer). The agent is desktop-only — the browser build cannot spawn processes. Everything from the WebSocket down in this document describes v1; the app-side design (single writer through `DocumentContext`, turn lock, revision guard, one-undo turns, tool surface, panel) carried over unchanged.

Backend facts were verified against vendor docs and npm registry metadata in July 2026 (see [Sources](#sources)) and re-verified against the installed SDKs/CLIs at build time.

Deviations from the proposal, all found at build time and all in the simplifying direction:

- **No persistent Codex registration.** `@openai/codex-sdk` accepts per-instance `--config` overrides, so the MCP endpoint is registered per run (`mcp_servers.inktile.url` + `bearer_token_env_var`) and `~/.codex/config.toml` is never touched. The planned idempotent-registration/removal machinery was unnecessary.
- **Codex interrupt and live search are first-class.** The SDK exposes an `AbortSignal` per turn and `webSearchMode: "live"` / `sandboxMode: "read-only"` per thread — no process killing, no global config edits.
- **Pairing token.** The broker prints a token at startup; the panel stores it in localStorage after a one-time paste. This is how the app learns the per-session secret (the plan left the delivery mechanism unspecified).
- **Codex system prompt.** Thread options carry no system prompt, so standing instructions live in an `AGENTS.md` the broker writes into the Codex working directory.
- **MCP tool annotations are mandatory for Codex.** Under a restricted sandbox, Codex routes un-annotated MCP tool calls through a user-confirmation (elicitation) path that headless runs cannot answer, so every call fails with "user cancelled MCP tool call" ([openai/codex#16685](https://github.com/openai/codex/issues/16685)). The shared tool table therefore declares `readOnlyHint`/`destructiveHint`/`openWorldHint` on every tool, and the broker's MCP endpoint is a stateful streamable-HTTP session server (initialize → `Mcp-Session-Id` → POST/GET/DELETE), which the Codex rmcp client expects.

## Goal

Let the user prompt an AI agent from inside Inktile. The agent reads and edits the currently open inktile — streaming text into pages, researching on the web, and inserting media — while the user watches the document update live. The user edits freely between prompts; user and agent never write at the same time. Works identically in browser and desktop builds.

Two interchangeable backends are supported: **Claude** (Claude Agent SDK) and **Codex** (OpenAI Codex SDK). The document-editing experience is identical on both; the backends differ in research behavior, streaming smoothness, and model output. A user logged into either CLI works with zero additional setup.

## Summary of decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Where agent edits apply | Through the running app via `DocumentContext`, never to `.inktile` files on disk | Single-writer: existing autosave stays the only file writer, so no file locking or clobbering is possible; edits render live |
| Process topology | Local Node "broker" process hosts a WebSocket server; the app connects outward as a client | No Rust/Tauri changes (`src-tauri/tauri.conf.json` has `"csp": null`, so `ws://localhost` is allowed); works in the browser build too |
| LLM backends | Backend adapter interface (prompt in → event stream out) with Claude and Codex implementations | Both SDKs npm-bundle their CLI runtimes (incl. Windows binaries) and reuse the user's existing CLI login — setup parity confirmed; tool logic is shared, only the adapter differs |
| Auth | The user's existing CLI credentials — Claude Code login (`~/.claude`) or `codex login` (`~/.codex/auth.json` / OS keyring, auto-refresh) | Zero credential handling in Inktile; already-logged-in users need no setup on either backend. First-run login flow needed only for users with neither |
| Concurrency | Turn-based document lock + revision counter | Matches the desired UX (user edits between prompts, watches during them); avoids caret/`contentEditable` conflicts; ~20 lines of optimistic concurrency |
| Undo granularity | One `checkpoint()` at turn start, no-history updates during streaming, one commit at turn end | Reuses the existing gesture pattern; an entire agent turn reverts with a single Ctrl+Z |
| Tool sandbox | Custom document tools + each backend's built-in web research only; no shell, no filesystem tools | The agent's only side effects are document operations; web pages are a read-only research surface |

## Architecture

```text
┌──────────────── Inktile app (browser or Tauri webview) ────────────────┐
│  Prompt panel ── agent turn state ── DocumentContext ── autosave ──────┼── .inktile file /
│        │                                   ▲                           │   IndexedDB library
│        └────────── WebSocket client ───────┘  (applies ops)            │
└───────────────────────────│────────────────────────────────────────────┘
                            │ ws://127.0.0.1:<port>
┌───────────────────────────▼────────────────────────────────────────────┐
│  Agent broker (Node, started via npm script)                           │
│  WebSocket server ── protocol ── shared tool logic                     │
│                                       │                                │
│  Backend interface (prompt in → {text | tool-call | done} events out)  │
│   ├─ Claude adapter: Agent SDK query() + in-process MCP tools          │
│   │    (bundled Claude Code CLI, existing Claude login)                │
│   └─ Codex adapter: codex-sdk threads + broker-hosted                  │
│        streamable-HTTP MCP endpoint (bundled Codex CLI, ChatGPT login) │
└────────────────────────────────────────────────────────────────────────┘
```

The broker never touches `.inktile` files. Every document mutation crosses the WebSocket as a typed operation and is applied by the app through `DocumentContext`, so persistence, history, normalization, and the row/page invariants in [ARCHITECTURE.md](ARCHITECTURE.md) all apply unchanged — regardless of backend.

## Backends

Verified capability comparison (July 2026):

| | Claude — `@anthropic-ai/claude-agent-sdk` | Codex — `@openai/codex-sdk` |
| --- | --- | --- |
| Runtime distribution | npm package bundles the Claude Code CLI as platform binaries (incl. `win32-x64`) | Depends on `@openai/codex`, which ships platform binaries via optionalDependencies (incl. `win32-x64`, `win32-arm64`) |
| Auth | Existing Claude Code login from the shared per-user credential store | Existing `codex login` (ChatGPT account) from `~/.codex/auth.json` or OS keyring; tokens auto-refresh |
| Usage billed to | User's Claude plan | User's ChatGPT/OpenAI plan |
| Custom tool exposure | In-process functions via `tool()` + `createSdkMcpServer()`, passed per `query()` call | Broker-hosted **streamable-HTTP MCP endpoint**; registered persistently in `~/.codex/config.toml` (`codex mcp add` / `[mcp_servers.inktile]` with `url`) |
| Tool restriction | `tools: ["WebSearch", "WebFetch"]` strips other built-ins; `allowedTools: [..., "mcp__inktile__*"]` pre-approves (required — headless has no prompts). Never `permissionMode: "bypassPermissions"` (ignores `allowedTools`) | Sandbox preset `read_only` blocks built-in writes; `enabled_tools`/`disabled_tools` per MCP server scope the tool list |
| Web research | `WebSearch` + `WebFetch` built-ins, live, on by default once allowed | Built-in web search, **cached snippets by default**; `web_search = "live"` in config or `--search` per run for live pages. No separate page-fetch tool documented |
| Streaming | Token-level partial text via `includePartialMessages` | Item-level events via `runStreamed()` (`item.completed`, `turn.completed`); no token deltas documented |
| Multi-turn | `query({ resume: sessionId })` | `codex.resumeThread(threadId)` |
| Interrupt | Supported by the SDK | Not documented — adapter terminates the CLI process |
| Windows | Bundled binary, no caveats | Native since early 2026 incl. native sandbox (May 2026). Pin as a project dependency with a lockfile (global installs have a known optional-dependency resolution quirk) |

Implications:

- **Setup parity is real.** Both backends install as npm dependencies of the broker and authenticate from the user's existing CLI login. The prompt panel exposes a backend picker; availability is detected by probing each credential store.
- **Live document typing works on both.** It is driven by the agent making many small `append_text` calls, not by token streaming — the system prompt for each backend instructs incremental writes. Narration in the prompt panel is word-by-word on Claude and chunk-by-chunk on Codex.
- **Research differs in character.** Claude fetches live pages by default; Codex defaults to cached snippets unless the adapter enables live mode. The adapter sets `web_search = "live"` scoped to Inktile's runs where possible.
- **Codex registration is persistent.** Registering the MCP endpoint edits the user's `~/.codex/config.toml`; the adapter must add the entry idempotently and offer clean removal. The Claude adapter has no equivalent footprint.
- Model-dependent behavior (SVG quality, prose, protocol discipline) needs per-backend prompt tuning and cannot be equalized by design.

## Turn lifecycle

1. User types a prompt in the app; the app sends `{prompt, revision, backend}` to the broker.
2. App enters **agent turn** mode: content becomes read-only, a visible "agent is writing" indicator and stop button appear, and `DocumentContext` records one `checkpoint()`.
3. Broker routes the prompt to the selected backend adapter (resuming that document's session/thread). Assistant narration streams to the prompt panel at whatever granularity the backend provides.
4. Each tool call is forwarded to the app, applied as a no-history mutation, and answered with a result (including the new revision). Text appends and media insertions render live as React re-renders.
5. On the backend's terminal event (or stop/error/disconnect), the broker signals turn end; the app commits final state, releases the lock, and resumes normal editing. Autosave persists as usual.

**Revision guard.** The app maintains a monotonically increasing revision, bumped on every mutation (user or agent). Reads return it; writes carry the revision they were based on and are rejected on mismatch, forcing the agent to re-read. This covers user edits made between prompts (sessions remember the conversation, not the document — each backend's system prompt instructs reading current state at the start of every turn).

**Failure handling.** Broker disconnect, stop button, or a backend error mid-turn all resolve the same way: the app ends the turn, keeps whatever streamed in (still one undo step), and reports the interruption in the prompt panel. Stop maps to the SDK interrupt on Claude and process termination on Codex; the app-side teardown is identical.

## Tool surface

Tool *logic* is written once in the broker and exposed through both backends: as in-process MCP tools to Claude, and over the broker's streamable-HTTP MCP endpoint to Codex.

| Tool | Direction | Behavior |
| --- | --- | --- |
| `read_document` | app → broker | Returns manifest-shaped state (pages, rows, text as HTML, asset metadata) plus current revision |
| `append_text` / `edit_text` | broker → app | Incremental HTML mutation of one text block; small appends make streaming visible |
| `insert_page` / `arrange_pages` | broker → app | Page creation and row placement through existing context operations (`pageRows` canonical, ≤4 per row, one component per page) |
| `create_image` | broker → app | Agent-authored SVG; broker sanitizes (strip scripts, event handlers, external refs) before the app registers it as an `image/svg+xml` asset |
| `fetch_media` | broker only, result → app | Broker downloads a URL, validates MIME against the accepted sets in `PageInsertControl.tsx` and a size cap, ships bytes to the app for normal asset registration (content-hash dedup applies) and media-page insertion |
| `add_drawing` (later) | broker → app | Emit normalized strokes for a drawing page |
| Web research | backend built-in | Claude: `WebSearch`/`WebFetch`. Codex: built-in web search (live mode enabled by the adapter). Binary downloads always go through `fetch_media` on both |

What the agent cannot do on either backend: run shell commands, touch the filesystem, edit any document other than the open one, or write while the user holds the document (outside a turn).

## Components to build

| Component | Location (proposed) | Contents |
| --- | --- | --- |
| Agent broker | `agent/broker.ts` (new top-level dir), run via `npm run agent` | WebSocket server, shared tool logic, SVG sanitizer, media validator. ~400–500 lines |
| Backend interface | `agent/backends/types.ts` | Prompt in → `{text | tool-call | done | error}` events out; session handle per document. ~50 lines |
| Claude adapter | `agent/backends/claude.ts` | Agent SDK `query()`, in-process MCP tools, `allowedTools` config, interrupt. ~150–250 lines |
| Codex adapter | `agent/backends/codex.ts` + `agent/mcpHttp.ts` | codex-sdk threads, streamable-HTTP MCP endpoint, idempotent `config.toml` registration/removal, live-search config, process-kill stop. ~250–400 lines |
| Protocol types | `agent/protocol.ts` shared with `src/agent/` | Typed messages: prompt (with backend), ops, results, narration chunks, turn start/end, errors, revision. ~100 lines |
| App WebSocket client | `src/agent/connection.ts` | Connect/reconnect, message dispatch, connection state for the UI. ~100 lines |
| Agent turn state | `src/document/DocumentContext.tsx` | `agentTurn` flag, lock enforcement in `commit`, revision counter, checkpoint-at-turn-start wiring. ~100–150 lines |
| Op application | `src/agent/applyOp.ts` | Maps protocol ops onto existing context mutations and asset registration. ~150 lines |
| Prompt panel | `src/components/AgentPanel.tsx` | Prompt input, backend picker, streamed narration, stop button, connection/status and usage note. ~250–350 lines |
| Lock UI | `Toolbar.tsx` / `PageStack.tsx` styling | Read-only mode indicator while a turn runs |

Total: roughly 1,600–2,100 new lines (the current app is ~4,900 lines of TS/TSX). No changes to: `src-tauri/`, the `.inktile` format, autosave, or the release pipeline; the shipped app bundle grows only by the small `src/agent/` + panel code. The SDK dependencies (both CLIs' platform binaries) live in the broker's `node_modules`, not in release artifacts. Per [AGENTS.md](../AGENTS.md), agent-support work does not require rebuilding desktop binaries.

## Security posture

- **Blast radius**: the agent's only write path is the document tool set on both backends; a hostile web page encountered during research can at worst corrupt the open document, which is one Ctrl+Z from recovery and never silently persisted over the user's other work.
- **SVG sanitation**: agent SVG renders inside the webview, so the broker strips scripts/handlers/external references before insertion.
- **Media validation**: MIME allowlist + size cap in the broker before bytes reach the app.
- **Broker exposure**: WebSocket and the MCP HTTP endpoint bind to `127.0.0.1` only. The app's WebSocket uses a random per-session token; the MCP endpoint requires a bearer token (Codex config supports `http_headers`/`bearer_token_env_var`), so other local processes can't issue document ops.
- **Codex sandbox**: adapter runs threads with the `read_only` sandbox preset so Codex's own built-ins cannot write; the MCP tools remain the only mutation path.
- **Config footprint**: the Codex adapter's `config.toml` entry is added idempotently, clearly named (`inktile`), and removable from the panel; no other user config is touched.
- **Usage transparency**: agent turns consume the user's Claude or ChatGPT plan; the panel says which.

## Build phases

1. **Skeleton** — broker with WebSocket server + echo protocol; app connection module + turn lock + revision counter; hardcoded test op stream to prove live rendering and single-undo semantics. No SDK yet.
2. **Claude backend** — backend interface + Claude adapter, session-per-document resume, `read_document` + `append_text` + `insert_page`; streaming narration in a minimal prompt panel. First end-to-end prompt.
3. **Media + web** — enable `WebSearch`/`WebFetch`, add `fetch_media`, `create_image` with sanitizer.
4. **Polish** — stop button, error/reconnect handling, lock UI, usage note, prompt-panel styling; `ui-smoke.mjs` coverage for lock behavior and op application; docs update ([ARCHITECTURE.md](ARCHITECTURE.md) gains an Agent section when this ships).
5. **Codex backend** — streamable-HTTP MCP endpoint, Codex adapter (threads, live-search config, config.toml registration), backend picker in the panel, per-backend prompt tuning. Re-verify Codex SDK facts at build time; the SDK surface is younger than Claude's.

Phases 1–2 are the minimum demo; each phase is independently shippable. The backend interface lands in phase 2 so phase 5 touches nothing outside `agent/backends/` and the panel picker.

## Out of scope (deliberate)

- Editing closed inktiles or whole-library operations (would need a different concurrency story).
- Page/block-level locking or CRDT merging — turn-based locking matches the product; revisit only if concurrent co-editing becomes a goal.
- Bundling the broker into the Tauri binary as a sidecar (packaging complexity; manual `npm run agent` first).
- Generating photographic images (needs an external image-gen API; the tool surface accommodates it later).
- Backends beyond Claude and Codex (the adapter interface accommodates them).

## Sources

Backend facts verified July 2026 against:

- [Claude Agent SDK docs](https://code.claude.com/docs/en/agent-sdk) — query API, in-process MCP tools, `allowedTools`/headless permissions, bundled CLI, session resume
- [Codex SDK docs](https://developers.openai.com/codex/sdk) and [TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md) — thread API, `runStreamed()` events, CLI wrapping
- npm registry metadata for [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk) and `@openai/codex` — dependency chain and platform binaries (incl. `win32-x64`)
- [Codex authentication docs](https://developers.openai.com/codex/auth) — `codex login` default, `auth.json`/keyring storage, auto-refresh
- [Codex MCP docs](https://developers.openai.com/codex/mcp/) — stdio + streamable-HTTP transports, `config.toml` shapes, `codex mcp add`
- [Codex Windows docs](https://developers.openai.com/codex/windows) — native Windows support and sandbox
- [Codex web-search configuration](https://codex.danielvaughan.com/2026/05/09/codex-cli-web-search-configuration-cached-live-domain-allow-lists-prompt-injection-defence/) — cached vs live modes, defaults
