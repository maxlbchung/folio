/**
 * Wire protocol between the Inktile app and the agent broker
 * (agent/broker.mjs), exchanged as JSON lines over the broker's stdio: the
 * desktop shell spawns the broker and bridges its stdin/stdout to the webview.
 * The broker never touches .inktile files: every document mutation crosses
 * this protocol as a typed operation and is applied by the app through
 * DocumentContext, so persistence, history, and the row/page invariants apply
 * unchanged. agent/*.mjs mirrors these shapes.
 */

export type AgentBackendId = "claude" | "codex";

/** Snapshot of one page as the agent sees it (manifest-shaped, no runtime blobs). */
export interface AgentPageSnapshot {
  id: string;
  /** The page's single component: matches the one-component-per-page invariant. */
  component: "text" | "versions" | "drawing" | "image" | "video" | "audio" | "empty";
  /** Current HTML for text pages (front face). */
  html?: string;
  /** Asset metadata for media pages. */
  asset?: { id: string; filename: string; mimeType: string; byteLength: number };
  alt?: string;
  /** Persisted row height in px (pages in one row share it). */
  height?: number;
  /** This page's share of its row width (only in multi-page rows). */
  widthFraction?: number;
  align?: "top" | "center" | "bottom";
  /** Back-face ("notes") HTML, when the page has notes. */
  notesHtml?: string;
  /** Versions pages: every draft plus which one is showing. */
  variants?: { label: string; html: string }[];
  activeVariant?: number;
  /** Drawing pages: canvas height and how many strokes exist (stroke data
   * itself stays in the app; edit_drawing appends or replaces). */
  drawing?: { height: number; strokeCount: number };
}

/** An agent-authored drawing stroke: normalized 0..1 coordinates. */
export interface AgentStroke {
  tool?: "pen" | "highlighter" | "eraser";
  width?: number;
  opacity?: number;
  points: { x: number; y: number; pressure?: number }[];
}

export interface AgentDocumentSnapshot {
  id: string;
  title: string;
  /** Rows of page ids, left to right — the canonical visual layout (max 4 per row). */
  pageRows: string[][];
  pages: AgentPageSnapshot[];
}

/** Operations the broker asks the app to perform. Writes carry the revision they
 * were computed against and are rejected on mismatch (optimistic concurrency). */
export type AgentOp =
  | { kind: "read_document" }
  | { kind: "set_title"; title: string; baseRevision: number }
  | { kind: "append_text"; pageId: string; html: string; baseRevision: number }
  | { kind: "edit_text"; pageId: string; html: string; baseRevision: number }
  | { kind: "edit_notes"; pageId: string; html: string; baseRevision: number }
  | { kind: "insert_page"; afterPageId?: string; html?: string; baseRevision: number }
  | { kind: "delete_pages"; pageIds: string[]; baseRevision: number }
  | { kind: "arrange_pages"; pageId: string; targetPageId: string; position: "before" | "after" | "left" | "right"; baseRevision: number }
  | { kind: "set_row_height"; pageId: string; height: number; baseRevision: number }
  | { kind: "set_row_widths"; pageId: string; fractions: number[]; baseRevision: number }
  | { kind: "set_vertical_align"; pageId: string; align: "top" | "center" | "bottom"; baseRevision: number }
  | { kind: "create_drawing"; afterPageId?: string; height?: number; strokes: AgentStroke[]; baseRevision: number }
  | { kind: "edit_drawing"; pageId: string; strokes: AgentStroke[]; mode: "replace" | "append"; baseRevision: number }
  | { kind: "insert_versions"; afterPageId?: string; variants: { label?: string; html: string }[]; activeIndex?: number; baseRevision: number }
  | { kind: "edit_versions"; pageId: string; variants?: { label?: string; html: string }[]; activeIndex?: number; baseRevision: number }
  | { kind: "convert_versions_to_text"; pageId: string; baseRevision: number }
  | { kind: "insert_media"; afterPageId?: string; filename: string; mimeType: string; alt?: string; bytesBase64: string; baseRevision: number };

export type AgentOpErrorCode = "revision" | "not-found" | "invalid" | "locked";

export interface AgentOpResult {
  /** The app's revision after the operation (or the current one for reads). */
  revision: number;
  document?: AgentDocumentSnapshot;
  pageId?: string;
  assetId?: string;
}

export interface AgentModelOption {
  /** Model identifier passed to the CLI; "" means the provider's own default. */
  id: string;
  label: string;
}

export interface AgentBackendStatus {
  available: boolean;
  detail: string;
  /** Models this provider can run, first entry is the default. */
  models: AgentModelOption[];
}

/** Messages the app sends to the broker. */
export type AppToBrokerMessage =
  | { type: "probe" }
  /** Starts a fresh conversation for this document: clears backend resume state. */
  | { type: "reset"; docId: string }
  | { type: "prompt"; promptId: string; backend: AgentBackendId; model?: string; prompt: string; docId: string; revision: number }
  | { type: "stop" }
  | { type: "tool-result"; callId: string; ok: boolean; result?: AgentOpResult; error?: string; code?: AgentOpErrorCode };

/** Messages the broker sends to the app. */
export type BrokerToAppMessage =
  | { type: "status"; backends: Record<AgentBackendId, AgentBackendStatus> }
  /** documentState tells how the turn was briefed: "first" (no conversation
   * memory — must read), "changed" (user edited since the agent's last turn),
   * or "unchanged" (revision identical — re-reading was waived). */
  | { type: "turn-start"; promptId: string; documentState?: "first" | "changed" | "unchanged" }
  | { type: "narration"; promptId: string; text: string }
  /** The model's live reasoning: ephemeral, shown while the agent works and
   * dropped as soon as it produces a message or the turn ends. Never persisted. */
  | { type: "thinking"; promptId: string; text: string }
  | { type: "op"; callId: string; op: AgentOp }
  | { type: "turn-end"; promptId: string; reason: "done" | "stopped" | "error"; error?: string }
  | { type: "notice"; text: string };

export const parseMessage = <T,>(data: unknown): T | null => {
  if (typeof data !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed && typeof parsed === "object" && "type" in parsed ? (parsed as T) : null;
  } catch {
    return null;
  }
};
