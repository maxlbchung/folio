import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDocument } from "../document/DocumentContext";
import { notifyInput } from "../utils/richText";
import { renderMathIn, renderTexInto } from "../utils/mathField";

/**
 * The popover that edits a math field's TeX source, with a live KaTeX preview. One host is
 * mounted per editor view; the toolbar's Math button and the tile views summon it through
 * `openMathEditor`, so no prop plumbing crosses the page tree.
 */

interface MathEditorState {
  element: HTMLElement;
  /** The tile editable owning the field, captured at open time so Remove can still commit
   * after the element has left the DOM. */
  editable: HTMLElement;
  anchor: DOMRect;
  /** Opened straight from insertion: dismissing without saving removes the empty field. */
  fresh: boolean;
}

let openHandler: ((element: HTMLElement) => void) | null = null;

/** Open the math editor for a `.math-field` element (no-op while an agent turn runs). */
export const openMathEditor = (element: HTMLElement) => openHandler?.(element);

/** Collapse the caret to where the field sits (or sat), so focus returns predictably. */
const seatCaretAt = (editable: HTMLElement, parent: Node, offset: number) => {
  const doc = editable.ownerDocument;
  const selection = doc.defaultView?.getSelection();
  if (!selection) return;
  const range = doc.createRange();
  range.setStart(parent, Math.min(offset, parent.childNodes.length));
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
};

export function MathEditorHost() {
  const { agentTurn, checkpoint } = useDocument();
  const [state, setState] = useState<MathEditorState | null>(null);
  const [tex, setTex] = useState("");
  const [display, setDisplay] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const agentTurnRef = useRef(agentTurn);
  agentTurnRef.current = agentTurn;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    openHandler = (element) => {
      if (agentTurnRef.current) return;
      const editable = element.closest<HTMLElement>(".text-block, .variant-editor");
      if (!editable) return;
      // Re-opening while a fresh, never-saved field is pending: drop that placeholder
      // first so cancelled inserts cannot litter the document.
      const previous = stateRef.current;
      if (previous && previous.fresh && previous.element !== element && !(previous.element.getAttribute("data-tex") ?? "").trim() && previous.element.isConnected) {
        previous.element.remove();
        notifyInput(previous.editable);
      }
      const current = element.getAttribute("data-tex") ?? "";
      setTex(current);
      setDisplay(element.getAttribute("data-display") === "true");
      setState({ element, editable, anchor: element.getBoundingClientRect(), fresh: !current.trim() });
    };
    return () => { openHandler = null; };
  }, []);

  // The workspace locks read-only when an agent turn starts; the editor follows suit.
  useEffect(() => {
    if (agentTurn) setState(null);
  }, [agentTurn]);

  // Live preview in the popover's light DOM (the imported KaTeX stylesheet is global).
  useEffect(() => {
    if (previewRef.current) renderTexInto(previewRef.current, tex, display);
  }, [state, tex, display]);

  // Clamp to the viewport once measured; flip above the anchor when the bottom overflows.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || !state) return;
    const left = Math.max(8, Math.min(state.anchor.left, window.innerWidth - panel.offsetWidth - 8));
    let top = state.anchor.bottom + 6;
    if (top + panel.offsetHeight > window.innerHeight - 8) {
      top = Math.max(8, state.anchor.top - panel.offsetHeight - 6);
    }
    setPosition({ left, top });
  }, [state]);

  const close = () => setState(null);

  const cancel = () => {
    if (!state) return;
    if (state.fresh && !(state.element.getAttribute("data-tex") ?? "").trim() && state.element.isConnected) {
      const parent = state.element.parentNode;
      const offset = parent ? Array.prototype.indexOf.call(parent.childNodes, state.element) : 0;
      state.element.remove();
      if (parent) seatCaretAt(state.editable, parent, offset);
      notifyInput(state.editable);
    }
    close();
  };

  const remove = () => {
    if (!state) return;
    // A discrete action gets its own undo step (checkpoint dedupes against the tile's
    // session checkpoint when both fire for this gesture).
    checkpoint();
    const parent = state.element.parentNode;
    const offset = parent ? Array.prototype.indexOf.call(parent.childNodes, state.element) : 0;
    state.element.remove();
    state.editable.focus({ preventScroll: true });
    if (parent) seatCaretAt(state.editable, parent, offset);
    notifyInput(state.editable);
    close();
  };

  const apply = () => {
    if (!state) return;
    if (!tex.trim()) {
      remove();
      return;
    }
    const nextTex = tex.trim();
    const nextDisplay = display ? "true" : "false";
    // Done without an actual change must not mint a no-op undo step.
    const changed = state.element.getAttribute("data-tex") !== nextTex || state.element.getAttribute("data-display") !== nextDisplay;
    if (changed) {
      checkpoint();
      state.element.setAttribute("data-tex", nextTex);
      state.element.setAttribute("data-display", nextDisplay);
      renderMathIn(state.editable);
    }
    const parent = state.element.parentNode;
    state.editable.focus({ preventScroll: true });
    if (parent) seatCaretAt(state.editable, parent, Array.prototype.indexOf.call(parent.childNodes, state.element) + 1);
    if (changed) notifyInput(state.editable);
    close();
  };

  // Dismiss on outside pointer or Escape (both cancel; a fresh empty field is removed).
  useEffect(() => {
    if (!state) return;
    const handlePointer = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) cancel();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("mousedown", handlePointer, true);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handlePointer, true);
      window.removeEventListener("keydown", handleKey);
    };
  });

  if (!state) return null;

  return createPortal(
    <div ref={panelRef} className="math-editor" role="dialog" aria-label="Edit math" style={{ left: position.left, top: position.top }}>
      <textarea
        className="math-editor__source"
        aria-label="LaTeX source"
        placeholder={"LaTeX, e.g. \\frac{a}{b}"}
        autoFocus
        value={tex}
        onChange={(event) => setTex(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            apply();
          }
        }}
      />
      <div ref={previewRef} className="math-editor__preview" aria-label="Preview" />
      <div className="math-editor__actions">
        <label className="math-editor__display">
          <input type="checkbox" checked={display} onChange={(event) => setDisplay(event.target.checked)} />
          Display block
        </label>
        <button className="math-editor__remove" onClick={remove}>Remove</button>
        <button className="math-editor__done" onClick={apply}>Done</button>
      </div>
    </div>,
    window.document.body
  );
}
