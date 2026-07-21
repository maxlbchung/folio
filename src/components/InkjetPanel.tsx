import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { lastAgentFocus, onAgentFocus } from "../agent/animations";
import { applyAgentOp, AgentOpError } from "../agent/applyOp";
import { FollowIcon } from "./icons";
import { AgentClient, agentSupportedHere, type AgentConnectionState } from "../agent/connection";
import type { AgentBackendId, AgentBackendStatus, BrokerToAppMessage } from "../agent/protocol";
import { useDocument } from "../document/DocumentContext";
import { uuid } from "../document/factories";
import { ElementScrollbar } from "./ElementScrollbar";
import { InkjetMarkdown } from "./InkjetMarkdown";

interface TranscriptEntry {
  id: string;
  role: "user" | "agent" | "info" | "error";
  text: string;
}

interface SessionChoice {
  provider: AgentBackendId;
  model: string;
}

const PROVIDER_IDS: AgentBackendId[] = ["claude", "codex", "opencode"];

const PROVIDER_LABEL: Record<AgentBackendId, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode"
};

const PREFS_KEY = "inkjet-session";
const WIDTH_KEY = "inkjet-panel-width";
const CHAT_KEY_PREFIX = "inkjet-chat:";
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 760;
const MAX_COMPOSER_HEIGHT = 190;
const MAX_STORED_ENTRIES = 200;
const MAX_STORED_CHATS = 50;

const readPrefs = (): Partial<SessionChoice> => {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return JSON.parse(raw) as Partial<SessionChoice>;
  } catch {
    // Fall through to defaults.
  }
  return {};
};

/** The per-document conversation store: the visible transcript plus the
 * provider/model it runs on, so reopening the panel drops straight back into
 * the chat. Its counterpart lives broker-side — the CLI resume ids persisted
 * by agent/session-store.mjs — which is what lets the *model* remember the
 * conversation; this store is what lets the *user* see it again. */
interface StoredChat {
  provider: AgentBackendId;
  model: string;
  updatedAt: number;
  transcript: TranscriptEntry[];
}

const isTranscriptEntry = (value: unknown): value is TranscriptEntry => {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<TranscriptEntry>;
  return typeof entry.id === "string" && typeof entry.text === "string"
    && (entry.role === "user" || entry.role === "agent" || entry.role === "info" || entry.role === "error");
};

const readStoredChat = (docId: string): StoredChat | null => {
  try {
    const raw = localStorage.getItem(CHAT_KEY_PREFIX + docId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredChat>;
    if (!parsed || !PROVIDER_IDS.includes(parsed.provider as AgentBackendId)) return null;
    return {
      provider: parsed.provider as AgentBackendId,
      model: typeof parsed.model === "string" ? parsed.model : "",
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      transcript: Array.isArray(parsed.transcript) ? parsed.transcript.filter(isTranscriptEntry) : []
    };
  } catch {
    return null;
  }
};

const writeStoredChat = (docId: string, chat: Omit<StoredChat, "updatedAt" | "transcript"> & { transcript: TranscriptEntry[] }) => {
  try {
    const stored: StoredChat = { ...chat, transcript: chat.transcript.slice(-MAX_STORED_ENTRIES), updatedAt: Date.now() };
    localStorage.setItem(CHAT_KEY_PREFIX + docId, JSON.stringify(stored));
    // Growth guard: drop the longest-untouched documents' conversations.
    const keys = Object.keys(localStorage).filter((key) => key.startsWith(CHAT_KEY_PREFIX));
    if (keys.length > MAX_STORED_CHATS) {
      const age = (key: string) => {
        try {
          return (JSON.parse(localStorage.getItem(key) ?? "") as Partial<StoredChat>).updatedAt ?? 0;
        } catch {
          return 0;
        }
      };
      keys.sort((a, b) => age(b) - age(a)).slice(MAX_STORED_CHATS).forEach((key) => localStorage.removeItem(key));
    }
  } catch {
    // Persistence is best-effort; the live conversation is unaffected.
  }
};

const clearStoredChat = (docId: string) => {
  try {
    localStorage.removeItem(CHAT_KEY_PREFIX + docId);
  } catch {
    // Best-effort.
  }
};

const clampWidth = (width: number) => Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.round(width)));

/**
 * Reveals text as a fast typewriter instead of snapping whole chunks in: a
 * few characters per frame at minimum, accelerating with the backlog so even
 * a whole answer arriving at once finishes in well under a second. `instant`
 * skips the animation for entries that already typed out once. The callbacks
 * ride refs so parents can pass fresh closures without restarting the effect.
 */
function InkjetTyped({ text, markdown, instant, onReveal, onDone }: {
  text: string;
  markdown?: boolean;
  instant?: boolean;
  onReveal?: () => void;
  onDone?: () => void;
}) {
  const [visible, setVisible] = useState(instant ? text.length : 0);
  const onRevealRef = useRef(onReveal);
  onRevealRef.current = onReveal;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    onRevealRef.current?.();
    if (visible >= text.length) {
      onDoneRef.current?.();
      return;
    }
    const frame = requestAnimationFrame(() => {
      setVisible((current) =>
        current >= text.length ? current : Math.min(text.length, current + Math.max(3, Math.ceil((text.length - current) / 12)))
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [text, visible]);
  const shown = visible >= text.length ? text : text.slice(0, visible);
  return markdown ? <InkjetMarkdown text={shown} /> : <>{shown}</>;
}

const readPanelWidth = (): number => {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(raw) && raw > 0) return clampWidth(raw);
  } catch {
    // Fall through to the default.
  }
  return 316;
};

export function InkjetPanel() {
  const documentContext = useDocument();
  const { agentTurn, beginAgentTurn, getRevision, getDocumentSnapshot } = documentContext;
  const docId = documentContext.document.id;
  const [open, setOpen] = useState(false);
  const [connection, setConnection] = useState<AgentConnectionState>("disconnected");
  const [startError, setStartError] = useState<string | null>(null);
  const [providers, setProviders] = useState<Record<AgentBackendId, AgentBackendStatus> | null>(null);
  const [view, setView] = useState<"setup" | "chat">("setup");
  // The session remembers which document it belongs to: the panel outlives
  // document switches (toolbar New/Open swaps the document under it), and the
  // docId pins persistence writes to the chat's own document.
  const [session, setSession] = useState<(SessionChoice & { docId: string }) | null>(null);
  const [provider, setProvider] = useState<AgentBackendId | null>(null);
  const [model, setModel] = useState("");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  // Everything the agent says mid-turn (reasoning and working notes) is
  // ephemeral: it renders as a temporary stylized bubble while the turn runs
  // and is dropped the moment the final answer lands or the turn ends. It never
  // joins `transcript`, so it is never persisted or scrolled back to.
  const [thinking, setThinking] = useState<{ promptId: string; text: string } | null>(null);
  const [prompt, setPrompt] = useState("");
  // Follow mode: keep the viewport vertically centered on the tile the agent is
  // working on. Any manual scroll gesture switches it back off.
  const [follow, setFollow] = useState(false);
  const [panelWidth, setPanelWidth] = useState(readPanelWidth);
  const widthDragRef = useRef<{ startX: number; startWidth: number; zoom: number } | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // The handlers below outlive renders, so they read the latest context and
  // turn state through refs instead of stale closures.
  const contextRef = useRef(documentContext);
  contextRef.current = documentContext;
  const turnRef = useRef<{ promptId: string } | null>(null);
  const opChainRef = useRef(Promise.resolve());
  const transcriptViewRef = useRef<HTMLDivElement>(null);
  const thinkingTextRef = useRef<HTMLDivElement>(null);
  // Entries that finished their typewriter reveal: reopening the panel (which
  // remounts the transcript) must render them instantly, not retype them.
  const typedRef = useRef(new Set<string>());

  const scrollToEnd = useCallback(() => {
    const view = transcriptViewRef.current;
    if (view) view.scrollTop = view.scrollHeight;
    // Keep the latest reasoning in view inside the capped thinking bubble.
    const think = thinkingTextRef.current;
    if (think) think.scrollTop = think.scrollHeight;
  }, []);

  const appendEntry = useCallback((role: TranscriptEntry["role"], text: string) => {
    setTranscript((entries) => [...entries, { id: uuid(), role, text }]);
  }, []);

  const appendAnswer = useCallback((text: string) => {
    // The final answer replaces the ephemeral thinking/working bubble.
    setThinking(null);
    appendEntry("agent", text);
  }, [appendEntry]);

  const appendThinking = useCallback((promptId: string, text: string) => {
    setThinking((current) =>
      current && current.promptId === promptId
        ? { promptId, text: current.text + text }
        : { promptId, text }
    );
  }, []);

  const finishTurn = useCallback((note?: { role: "info" | "error"; text: string }) => {
    // Thinking is always dropped at the boundary of a turn, active or not.
    setThinking(null);
    if (!turnRef.current) return;
    turnRef.current = null;
    contextRef.current.endAgentTurn();
    if (note) appendEntry(note.role, note.text);
  }, [appendEntry]);

  const clientRef = useRef<AgentClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = new AgentClient({
      onStateChange: (state) => {
        setConnection(state);
        if (state === "disconnected") {
          setProviders(null);
          finishTurn({ role: "error", text: "Inkjet stopped; the turn ended. Everything already written stays in place (one Ctrl+Z reverts the turn)." });
        }
      },
      onMessage: (message: BrokerToAppMessage) => {
        if (message.type === "status") setProviders(message.backends);
        else if (message.type === "answer") {
          if (turnRef.current?.promptId === message.promptId) appendAnswer(message.text);
        } else if (message.type === "thinking") {
          if (turnRef.current?.promptId === message.promptId) appendThinking(message.promptId, message.text);
        } else if (message.type === "op") {
          // Ops apply strictly in arrival order even when one (media) is async.
          opChainRef.current = opChainRef.current.then(async () => {
            const client = clientRef.current;
            if (!client) return;
            if (!turnRef.current) {
              client.send({ type: "tool-result", callId: message.callId, ok: false, code: "locked", error: "No agent turn is active." });
              return;
            }
            try {
              const result = await contextRef.current.runAgentEdit(() => applyAgentOp(message.op, contextRef.current));
              client.send({ type: "tool-result", callId: message.callId, ok: true, result });
            } catch (error) {
              const code = error instanceof AgentOpError ? error.code : "invalid";
              const text = error instanceof Error ? error.message : "The operation could not be applied.";
              client.send({ type: "tool-result", callId: message.callId, ok: false, code, error: text });
            }
          });
        } else if (message.type === "turn-end") {
          if (turnRef.current?.promptId !== message.promptId) return;
          if (message.reason === "error") finishTurn({ role: "error", text: message.error ?? "The provider reported an error." });
          else if (message.reason === "stopped") finishTurn({ role: "info", text: "Stopped. Everything already written stays (one Ctrl+Z reverts the turn)." });
          else finishTurn();
        } else if (message.type === "notice") appendEntry("info", message.text);
      }
    });
  }

  const startAgent = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;
    setStartError(null);
    if (client.connected) {
      client.send({ type: "probe" });
      return;
    }
    client.connect().catch((error: Error) => setStartError(error.message));
  }, []);

  // The browser build has no broker transport: the panel says so with a single
  // note and never attempts to connect. Computed per render so the ui-smoke
  // mock (injected before the panel opens) is picked up.
  const desktopOnly = !agentSupportedHere();

  // Zero setup: opening the panel starts (or reuses) the broker, which then
  // reports which providers are installed and signed in on this machine.
  useEffect(() => {
    if (open && !desktopOnly) startAgent();
  }, [open, desktopOnly, startAgent]);

  // Conversations persist per document: opening the panel on a document with a
  // stored chat drops straight back into it — across panel closes, document
  // switches, and app restarts. The broker keeps the matching CLI resume ids
  // on disk, so the next prompt continues the same conversation. Restored
  // entries render instantly (marked typed), not as a replayed typewriter.
  const restoredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || desktopOnly || restoredRef.current === docId) return;
    restoredRef.current = docId;
    const stored = readStoredChat(docId);
    setThinking(null);
    typedRef.current = new Set(stored ? stored.transcript.map((entry) => entry.id) : []);
    setTranscript(stored ? stored.transcript : []);
    setSession(stored ? { provider: stored.provider, model: stored.model, docId } : null);
    setView(stored ? "chat" : "setup");
    if (stored) {
      setProvider(stored.provider);
      setModel(stored.model);
    }
  }, [open, desktopOnly, docId]);

  // Mirror the live conversation into the per-document store as it grows. The
  // docId guard keeps the transient render right after a document switch (old
  // transcript state, new document) from filing the chat under the wrong id.
  useEffect(() => {
    if (!session || session.docId !== docId) return;
    writeStoredChat(docId, { provider: session.provider, model: session.model, transcript });
  }, [docId, session, transcript]);

  // A restored chat whose CLI has since vanished (uninstalled, signed out)
  // falls back to the setup screen, where the provider list explains why.
  useEffect(() => {
    if (!providers || !session || turnRef.current) return;
    if (!providers[session.provider]?.available) {
      setSession(null);
      setView("setup");
    }
  }, [providers, session]);

  // When provider availability arrives, seed the setup choices: restore the
  // remembered provider/model when still valid, otherwise the first available.
  useEffect(() => {
    if (!providers) return;
    const available = PROVIDER_IDS.filter((id) => providers[id]?.available);
    setProvider((current) => {
      if (current && available.includes(current)) return current;
      const remembered = readPrefs().provider;
      return remembered && available.includes(remembered) ? remembered : available[0] ?? null;
    });
  }, [providers]);

  useEffect(() => {
    if (!providers || !provider) return;
    const options = providers[provider]?.models ?? [];
    setModel((current) => {
      if (options.some((option) => option.id === current)) return current;
      const remembered = readPrefs().model;
      return remembered !== undefined && options.some((option) => option.id === remembered) ? remembered : options[0]?.id ?? "";
    });
  }, [providers, provider]);

  // Leaving the editor (this panel unmounts) ends any running turn and detaches
  // from the broker; the broker itself stays warm for the next visit and exits
  // with the app.
  useEffect(() => () => {
    clientRef.current?.send({ type: "stop" });
    clientRef.current?.disconnect();
    if (turnRef.current) {
      turnRef.current = null;
      contextRef.current.endAgentTurn();
    }
  }, []);

  useEffect(() => {
    scrollToEnd();
  }, [transcript, thinking, scrollToEnd]);

  // The composer grows with its content instead of carrying a resize grip:
  // measure the scroll height on every value change, capped so long prompts
  // scroll inside (their native bar hidden like the transcript's).
  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "auto";
    composer.style.height = `${Math.min(composer.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
  });

  const startWidthDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const panel = event.currentTarget.parentElement;
    // Pointer distances are visual px; the panel lives inside the zoomed
    // app-shell, so convert through its rect/offsetWidth ratio (UI scale).
    const zoom = panel && panel.offsetWidth > 0 ? panel.getBoundingClientRect().width / panel.offsetWidth : 1;
    widthDragRef.current = { startX: event.clientX, startWidth: panelWidth, zoom };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveWidthDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = widthDragRef.current;
    if (!drag) return;
    setPanelWidth(clampWidth(drag.startWidth + (drag.startX - event.clientX) / drag.zoom));
  };

  const endWidthDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!widthDragRef.current) return;
    widthDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setPanelWidth((width) => {
      try {
        localStorage.setItem(WIDTH_KEY, String(width));
      } catch {
        // Preference is best-effort.
      }
      return width;
    });
  };

  const startSession = () => {
    if (!provider || connection !== "connected") return;
    const choice: SessionChoice = { provider, model };
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(choice));
    } catch {
      // Preference is best-effort.
    }
    // A session is a fresh conversation: drop any backend resume state. The
    // per-document store follows along — the persistence effect overwrites it
    // with this fresh session.
    clientRef.current?.send({ type: "reset", docId });
    setSession({ ...choice, docId });
    setTranscript([]);
    typedRef.current = new Set();
    setThinking(null);
    setView("chat");
  };

  const endSession = () => {
    if (agentTurn) return;
    // Exiting ends the conversation for real: with sessions now resuming
    // automatically, this is the one gesture that discards the stored chat and
    // the backends' resume state instead of picking it back up next open.
    clientRef.current?.send({ type: "reset", docId });
    clearStoredChat(docId);
    setTranscript([]);
    typedRef.current = new Set();
    setSession(null);
    setView("setup");
  };

  const sendPrompt = () => {
    const text = prompt.trim();
    const client = clientRef.current;
    if (!text || !client?.connected || !session || turnRef.current) return;
    if (!beginAgentTurn()) return;
    const promptId = uuid();
    turnRef.current = { promptId };
    appendEntry("user", text);
    setPrompt("");
    const sent = client.send({
      type: "prompt",
      promptId,
      backend: session.provider,
      model: session.model || undefined,
      prompt: text,
      docId: getDocumentSnapshot().id,
      revision: getRevision()
    });
    if (!sent) finishTurn({ role: "error", text: "The prompt could not be sent." });
  };

  const stopTurn = () => {
    if (!clientRef.current?.send({ type: "stop" })) {
      finishTurn({ role: "error", text: "Stop could not reach Inkjet; the turn ended locally." });
    }
  };

  // Follow mode: center the viewport (y only) on whatever the agent animates
  // next, seeded with its current focus when toggled on mid-turn. Wheel input
  // or a page-scrolling key anywhere outside the panel means the user took the
  // wheel back — follow switches off instead of fighting them.
  useEffect(() => {
    if (!agentTurn || !follow) return;
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const center = (element: HTMLElement) => {
      if (!element.isConnected) return;
      const rect = element.getBoundingClientRect();
      const top = window.scrollY + rect.top + rect.height / 2 - window.innerHeight / 2;
      window.scrollTo({ top: Math.max(0, top), behavior: reduced ? "auto" : "smooth" });
    };
    const seed = lastAgentFocus();
    if (seed) center(seed);
    const offFocus = onAgentFocus(center);
    const disable = () => setFollow(false);
    // Gestures inside the panel scroll the chat, not the document — only
    // document-scrolling input takes follow off.
    const insidePanel = (event: Event) =>
      event.target instanceof HTMLElement && Boolean(event.target.closest(".inkjet-panel"));
    const onWheel = (event: WheelEvent) => {
      if (!insidePanel(event)) disable();
    };
    const onKey = (event: KeyboardEvent) => {
      if (insidePanel(event)) return;
      if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "].includes(event.key)) disable();
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      offFocus();
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, [agentTurn, follow]);

  const availableProviders = providers ? PROVIDER_IDS.filter((id) => providers[id]?.available) : null;
  const modelOptions = provider && providers ? providers[provider]?.models ?? [] : [];
  const sessionModelLabel = session && providers
    ? providers[session.provider]?.models.find((option) => option.id === session.model)?.label ?? (session.model || "Default")
    : session?.model || "Default";
  const inChat = view === "chat" && session !== null && connection === "connected";

  return (
    <>
      {/* Full-viewport lock while a turn runs: everything except the Inkjet
          panel, its toggle, and the Stop indicator sits under this scrim (they
          stack above it), so "the document is read-only right now" is visible
          and every other surface is uninteractable. Wheel scrolling still
          reaches the document scroller, so the user can follow the agent. */}
      {agentTurn && <div className="inkjet-lock-scrim" aria-hidden="true" />}
      {agentTurn && (
        <div className="inkjet-turn-indicator" role="status">
          <span className="inkjet-turn-indicator__pulse" aria-hidden="true" />
          Inkjet is printing…
          <button
            className={`inkjet-turn-indicator__follow ${follow ? "is-active" : ""}`}
            title={follow ? "Following Inkjet — scroll to stop" : "Follow Inkjet's edits"}
            aria-label="Follow Inkjet's edits"
            aria-pressed={follow}
            onClick={() => setFollow((value) => !value)}
          >
            <FollowIcon size={13} />
          </button>
          <button onClick={stopTurn}>Stop</button>
        </div>
      )}
      <button
        className={`inkjet-toggle ${open ? "is-open" : ""}`}
        aria-label="Inkjet panel"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`inkjet-toggle__dot inkjet-toggle__dot--${connection}`} aria-hidden="true" />
        Inkjet
      </button>
      {open && (
        <aside className="inkjet-panel" aria-label="Inkjet" style={{ width: panelWidth }}>
          <div
            className="inkjet-panel__resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the Inkjet panel"
            onPointerDown={startWidthDrag}
            onPointerMove={moveWidthDrag}
            onPointerUp={endWidthDrag}
            onPointerCancel={endWidthDrag}
          />
          <header className="inkjet-panel__header">
            <strong>Inkjet</strong>
            {inChat && (
              <span className="inkjet-panel__session">
                {PROVIDER_LABEL[session.provider]} · {sessionModelLabel}
              </span>
            )}
            {inChat && (
              <button className="inkjet-panel__new" onClick={endSession} disabled={agentTurn}>Exit session</button>
            )}
          </header>

          {!inChat && desktopOnly && (
            <div className="inkjet-setup">
              <p className="inkjet-setup__note">Inkjet is a desktop-only feature.</p>
            </div>
          )}

          {!inChat && !desktopOnly && (
            <div className="inkjet-setup">
              <p className="inkjet-setup__intro">
                Inkjet is Inktile's built-in AI agent: it writes right into this document,
                connecting automatically to the AI CLIs installed and signed in on this machine.
              </p>
              {connection !== "connected" && !startError && <p className="inkjet-setup__note">Starting Inkjet…</p>}
              {startError && (
                <>
                  <p className="inkjet-setup__error">{startError}</p>
                  <button className="inkjet-setup__retry" onClick={startAgent}>Retry</button>
                </>
              )}
              {connection === "connected" && !providers && <p className="inkjet-setup__note">Looking for AI providers on this machine…</p>}

              {availableProviders && availableProviders.length === 0 && (
                <>
                  <p className="inkjet-setup__note">
                    No AI CLIs are available — install and sign in to {PROVIDER_IDS.map((id) => PROVIDER_LABEL[id]).join(", ")}, then check again.
                  </p>
                  <button className="inkjet-setup__retry" onClick={startAgent}>Check again</button>
                </>
              )}

              {availableProviders && availableProviders.length > 0 && (
                <>
                  <p className="inkjet-setup__label">Provider</p>
                  <div className="inkjet-setup__providers" role="radiogroup" aria-label="Inkjet provider">
                    {PROVIDER_IDS.map((id) => {
                      const available = providers?.[id]?.available === true;
                      return (
                        <label
                          key={id}
                          className={[provider === id ? "is-selected" : "", available ? "" : "is-unavailable"].filter(Boolean).join(" ")}
                        >
                          <input
                            type="radio"
                            name="inkjet-provider"
                            checked={provider === id}
                            disabled={!available}
                            onChange={() => setProvider(id)}
                          />
                          <strong>{PROVIDER_LABEL[id]}</strong>
                          <span>{providers?.[id]?.detail}</span>
                        </label>
                      );
                    })}
                  </div>
                  <p className="inkjet-setup__label">Model</p>
                  <select
                    aria-label="Inkjet model"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                  >
                    {modelOptions.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                  <button className="inkjet-setup__start" onClick={startSession} disabled={!provider}>
                    Start session
                  </button>
                </>
              )}
            </div>
          )}

          {inChat && (
            <>
              <div className="inkjet-panel__transcript-wrap">
                <div className="inkjet-panel__transcript" ref={transcriptViewRef}>
                  {transcript.length === 0 && (
                    <p className="inkjet-panel__empty">
                      Ask Inkjet to write in this inktile — one Ctrl+Z undoes its whole turn.
                    </p>
                  )}
                  {transcript.map((entry) => (
                    <div key={entry.id} className={`inkjet-entry inkjet-entry--${entry.role}`}>
                      {entry.role === "agent"
                        ? (
                          <InkjetTyped
                            text={entry.text}
                            markdown
                            instant={typedRef.current.has(entry.id)}
                            onReveal={scrollToEnd}
                            onDone={() => typedRef.current.add(entry.id)}
                          />
                        )
                        : entry.text}
                    </div>
                  ))}
                  {thinking && thinking.text.trim() && (
                    <div className="inkjet-entry inkjet-entry--thinking" aria-live="polite">
                      <span className="inkjet-thinking__label">
                        <span className="inkjet-thinking__spark" aria-hidden="true" />
                        Thinking
                      </span>
                      <div className="inkjet-thinking__text" ref={thinkingTextRef}>
                        <InkjetTyped key={thinking.promptId} text={thinking.text} onReveal={scrollToEnd} />
                      </div>
                    </div>
                  )}
                  {agentTurn && !thinking && transcript[transcript.length - 1]?.role !== "agent" && (
                    <div className="inkjet-entry inkjet-entry--printing" role="status" aria-label="Inkjet is printing">
                      <span className="inkjet-printing__dots" aria-hidden="true"><i /><i /><i /></span>
                    </div>
                  )}
                </div>
                <ElementScrollbar
                  scrollerRef={transcriptViewRef}
                  watch={transcript}
                  label="Scroll the conversation"
                  className="inkjet-scrollbar"
                />
              </div>

              <form
                className="inkjet-panel__composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  sendPrompt();
                }}
              >
                <textarea
                  ref={composerRef}
                  rows={1}
                  aria-label="Inkjet prompt"
                  placeholder="Prompt Inkjet…"
                  value={prompt}
                  disabled={agentTurn}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      sendPrompt();
                    }
                  }}
                />
                {agentTurn
                  ? <button type="button" className="inkjet-panel__stop" onClick={stopTurn}>Stop</button>
                  : <button type="submit" disabled={!prompt.trim()}>Send</button>}
              </form>
            </>
          )}
        </aside>
      )}
    </>
  );
}
