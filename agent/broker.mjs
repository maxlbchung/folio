// Inktile agent broker — dependency-free Node process, spawned by the app.
//
// Transport: JSON lines over stdio (stdout carries protocol messages only;
// all logging goes to stderr). The desktop shell pipes this to the webview,
// so there is no listening socket between app and broker at all; the only
// network surface is the loopback MCP endpoint the CLIs connect to, guarded
// by a per-run bearer token that never leaves this process tree.
//
// The broker never touches .inktile files: every document mutation crosses
// this protocol as a typed operation and is applied by the app through
// DocumentContext (see src/agent/protocol.ts for the message shapes).

import { randomBytes, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import * as claude from "./backend-claude.mjs";
import * as codex from "./backend-codex.mjs";
import { startMcpEndpoint } from "./mcp.mjs";
import { DocumentSession, OpRejectedError } from "./tools.mjs";

const OP_TIMEOUT_MS = 120_000;

const backends = { claude, codex };

const log = (line) => process.stderr.write(`[inktile-agent] ${line}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

// A dead parent makes stdout writes fail (EPIPE); treat that as shutdown, not a crash.
process.stdout.on("error", () => process.exit(0));

/** @type {{ promptId: string, runtime: object, handle: { finished: Promise<object>, interrupt: () => void } } | null} */
let activeTurn = null;
/** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
const pendingOps = new Map();
/** docId → the document revision when the agent's last completed turn ended.
 * Comparing it to the next prompt's revision detects user edits in between,
 * so an unchanged document doesn't force a wasteful re-read every turn. */
const lastTurnRevisions = new Map();

const dispatchOp = (op) =>
  new Promise((resolve, reject) => {
    const callId = randomUUID();
    const timer = setTimeout(() => {
      pendingOps.delete(callId);
      reject(new Error("The app did not answer the operation in time."));
    }, OP_TIMEOUT_MS);
    pendingOps.set(callId, { resolve, reject, timer });
    send({ type: "op", callId, op });
  });

const sendStatus = () => {
  send({ type: "status", backends: { claude: claude.availability(), codex: codex.availability() } });
};

const endTurn = (promptId, reason, error) => {
  if (activeTurn?.promptId === promptId) activeTurn = null;
  send({ type: "turn-end", promptId, reason, error });
};

const handlePrompt = (message, mcp, mcpToken) => {
  if (activeTurn) {
    endTurn(message.promptId, "error", "A turn is already running.");
    return;
  }
  const backend = backends[message.backend];
  if (!backend) {
    endTurn(message.promptId, "error", `Unknown backend "${message.backend}".`);
    return;
  }
  const probe = backend.availability();
  if (!probe.available) {
    endTurn(message.promptId, "error", probe.detail);
    return;
  }

  // Brief the model on whether re-reading is worth it: with conversation
  // memory and an unchanged revision, a fresh read would tell it nothing new.
  const remembered = backend.hasSession(message.docId) ? lastTurnRevisions.get(message.docId) : undefined;
  const documentState = !backend.hasSession(message.docId)
    ? "first"
    : remembered !== undefined && remembered === message.revision ? "unchanged" : "changed";

  const session = new DocumentSession(dispatchOp);
  // "unchanged" seeds the live revision, so the model can write immediately.
  // Otherwise a sentinel makes any write attempted before read_document bounce
  // off the app's revision guard — the read-first briefing is enforced, not
  // just suggested (models sometimes trust stale memory over instructions).
  session.seedRevision(documentState === "unchanged" ? message.revision : -1);
  const runtime = { document: session };

  send({ type: "turn-start", promptId: message.promptId, documentState });
  const handle = backend.startTurn({
    docKey: message.docId,
    prompt: message.prompt,
    model: typeof message.model === "string" && message.model ? message.model : undefined,
    documentState,
    mcpUrl: mcp.url,
    mcpToken,
    onNarration: (text) => send({ type: "narration", promptId: message.promptId, text }),
    onThinking: (text) => send({ type: "thinking", promptId: message.promptId, text }),
    log
  });
  activeTurn = { promptId: message.promptId, runtime, handle };

  void handle.finished.then((result) => {
    log(`turn ${message.promptId.slice(0, 8)} (${message.backend}, ${documentState}): ${result.reason}${result.error ? ` — ${result.error}` : ""}`);
    // Only a cleanly finished turn leaves the model's memory trustworthy; a
    // stopped or failed one may have acted without seeing the results, so the
    // next turn is briefed to re-read.
    if (result.reason === "done") lastTurnRevisions.set(message.docId, session.revision);
    else lastTurnRevisions.delete(message.docId);
    endTurn(message.promptId, result.reason, result.error);
  });
};

const main = async () => {
  const mcpToken = randomBytes(16).toString("hex");
  const mcp = await startMcpEndpoint(mcpToken, () => activeTurn?.runtime ?? null, log);
  log(`MCP endpoint: ${mcp.url} (loopback only, bearer-protected)`);

  const shutdown = () => {
    activeTurn?.handle.interrupt();
    for (const [, pending] of pendingOps) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The broker is shutting down."));
    }
    pendingOps.clear();
    mcp.close();
    process.exit(0);
  };

  const stdin = createInterface({ input: process.stdin, crlfDelay: Infinity });
  stdin.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;

    if (message.type === "probe") {
      sendStatus();
    } else if (message.type === "reset") {
      // A new session: the next turn starts a fresh CLI conversation with no
      // document memory to lean on.
      if (typeof message.docId === "string") {
        claude.clearSession(message.docId);
        codex.clearSession(message.docId);
        lastTurnRevisions.delete(message.docId);
      }
    } else if (message.type === "prompt") {
      handlePrompt(message, mcp, mcpToken);
    } else if (message.type === "stop") {
      activeTurn?.handle.interrupt();
    } else if (message.type === "tool-result") {
      const pending = pendingOps.get(message.callId);
      if (!pending) return;
      pendingOps.delete(message.callId);
      clearTimeout(pending.timer);
      if (message.ok && message.result) pending.resolve(message.result);
      else pending.reject(new OpRejectedError(message.code ?? "invalid", message.error ?? "The app rejected the operation."));
    }
  });
  // The app (or dev harness) owns this process: when the parent goes away the
  // pipe closes and the broker exits with it — no orphans, no idle daemons.
  stdin.on("close", shutdown);

  sendStatus();
};

void main().catch((error) => {
  log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
