import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { applyAgentOp, AgentOpError } from "../agent/applyOp";
import { AgentClient, type AgentConnectionState } from "../agent/connection";
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

const PROVIDER_IDS: AgentBackendId[] = ["claude", "codex"];

const PROVIDER_LABEL: Record<AgentBackendId, string> = {
  claude: "Claude",
  codex: "Codex"
};

const PREFS_KEY = "inkjet-session";
const WIDTH_KEY = "inkjet-panel-width";
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 760;
const MAX_COMPOSER_HEIGHT = 190;

const readPrefs = (): Partial<SessionChoice> => {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return JSON.parse(raw) as Partial<SessionChoice>;
  } catch {
    // Fall through to defaults.
  }
  return {};
};

const clampWidth = (width: number) => Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.round(width)));

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
  const [open, setOpen] = useState(false);
  const [connection, setConnection] = useState<AgentConnectionState>("disconnected");
  const [startError, setStartError] = useState<string | null>(null);
  const [providers, setProviders] = useState<Record<AgentBackendId, AgentBackendStatus> | null>(null);
  const [view, setView] = useState<"setup" | "chat">("setup");
  const [session, setSession] = useState<SessionChoice | null>(null);
  const [provider, setProvider] = useState<AgentBackendId | null>(null);
  const [model, setModel] = useState("");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  // The agent's live reasoning is ephemeral: it renders as a temporary bubble
  // while the turn runs and is dropped the moment a message lands or the turn
  // ends. It never joins `transcript`, so it is never persisted or scrolled back to.
  const [thinking, setThinking] = useState<{ promptId: string; text: string } | null>(null);
  const [prompt, setPrompt] = useState("");
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

  const appendEntry = useCallback((role: TranscriptEntry["role"], text: string) => {
    setTranscript((entries) => [...entries, { id: uuid(), role, text }]);
  }, []);

  const appendNarration = useCallback((text: string) => {
    // A real message supersedes whatever the agent was thinking toward.
    setThinking(null);
    setTranscript((entries) => {
      const last = entries[entries.length - 1];
      if (last?.role === "agent") {
        return [...entries.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...entries, { id: uuid(), role: "agent", text }];
    });
  }, []);

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
        else if (message.type === "narration") {
          if (turnRef.current?.promptId === message.promptId) appendNarration(message.text);
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

  // Zero setup: opening the panel starts (or reuses) the broker, which then
  // reports which providers are installed and signed in on this machine.
  useEffect(() => {
    if (open) startAgent();
  }, [open, startAgent]);

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
    const view = transcriptViewRef.current;
    if (view) view.scrollTop = view.scrollHeight;
    // Keep the latest reasoning in view inside the capped thinking bubble.
    const think = thinkingTextRef.current;
    if (think) think.scrollTop = think.scrollHeight;
  }, [transcript, thinking]);

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
    // A session is a fresh conversation: drop any backend resume state.
    clientRef.current?.send({ type: "reset", docId: getDocumentSnapshot().id });
    setSession(choice);
    setTranscript([]);
    setThinking(null);
    setView("chat");
  };

  const endSession = () => {
    if (agentTurn) return;
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

  const availableProviders = providers ? PROVIDER_IDS.filter((id) => providers[id]?.available) : null;
  const modelOptions = provider && providers ? providers[provider]?.models ?? [] : [];
  const sessionModelLabel = session && providers
    ? providers[session.provider]?.models.find((option) => option.id === session.model)?.label ?? (session.model || "Default")
    : session?.model || "Default";
  const inChat = view === "chat" && session !== null && connection === "connected";

  return (
    <>
      {agentTurn && (
        <div className="inkjet-turn-indicator" role="status">
          <span className="inkjet-turn-indicator__pulse" aria-hidden="true" />
          Inkjet is printing…
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
              <button className="inkjet-panel__new" onClick={endSession} disabled={agentTurn}>New session</button>
            )}
          </header>

          {!inChat && (
            <div className="inkjet-setup">
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
                  <p className="inkjet-setup__error">No AI providers were found.</p>
                  {PROVIDER_IDS.map((id) => (
                    <p key={id} className="inkjet-setup__note">{PROVIDER_LABEL[id]}: {providers?.[id]?.detail}</p>
                  ))}
                  <button className="inkjet-setup__retry" onClick={startAgent}>Check again</button>
                </>
              )}

              {availableProviders && availableProviders.length > 0 && (
                <>
                  <p className="inkjet-setup__label">Provider</p>
                  <div className="inkjet-setup__providers" role="radiogroup" aria-label="Inkjet provider">
                    {availableProviders.map((id) => (
                      <label key={id} className={provider === id ? "is-selected" : ""}>
                        <input
                          type="radio"
                          name="inkjet-provider"
                          checked={provider === id}
                          onChange={() => setProvider(id)}
                        />
                        <strong>{PROVIDER_LABEL[id]}</strong>
                        <span>{providers?.[id]?.detail}</span>
                      </label>
                    ))}
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
                      Ask Inkjet to write into this inktile. It reads the open document,
                      streams text into pages, researches on the web, and inserts media —
                      you can watch it work and undo a whole turn with Ctrl+Z.
                    </p>
                  )}
                  {transcript.map((entry) => (
                    <div key={entry.id} className={`inkjet-entry inkjet-entry--${entry.role}`}>
                      {entry.role === "agent" ? <InkjetMarkdown text={entry.text} /> : entry.text}
                    </div>
                  ))}
                  {thinking && thinking.text.trim() && (
                    <div className="inkjet-entry inkjet-entry--thinking" aria-live="polite">
                      <span className="inkjet-thinking__label">
                        <span className="inkjet-thinking__spark" aria-hidden="true" />
                        Thinking
                      </span>
                      <div className="inkjet-thinking__text" ref={thinkingTextRef}>{thinking.text}</div>
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
