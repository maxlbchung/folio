import { useLayoutEffect, useRef, useState } from "react";
import { animateTextTransition, cancelAgentAnimations, queueAgentAnimation, reportAgentFocus } from "../agent/animations";
import { useDocument } from "../document/DocumentContext";
import type { TextBlock } from "../document/types";
import { stripCaretArtifacts } from "../utils/editorHtml";
import {
  applyAutoformat, applyLinkAutoformat, applyRuleAutoformat, checklistCaretItem, checklistHit,
  fixChecklistAfterEnter, handleLinkPaste, handleTableArrow, handleTableTab, normalizeRichContent,
  notifyInput, openLinkExternally, toggleChecklistItem
} from "../utils/richText";
import { renderMathIn } from "../utils/mathField";
import { openMathEditor } from "./MathEditor";
import { openLinkPreview } from "./LinkPreview";

interface TextBlockViewProps {
  block: TextBlock;
  onChange: (html: string, record?: boolean) => void;
  onStartChange: () => void;
}

export function TextBlockView({ block, onChange, onStartChange }: TextBlockViewProps) {
  const { agentTurn } = useDocument();
  const ref = useRef<HTMLDivElement>(null);
  const startValue = useRef(block.html);
  const changeStarted = useRef(false);
  // A pending "Enter split a checklist item" fixup, applied on the input event that
  // follows the split (the browser clones the li's checked state; see fixChecklistAfterEnter).
  const enterInChecklist = useRef<HTMLLIElement | null>(null);
  // Spellcheck only while the tile is being edited: flipping the attribute off on blur makes
  // Chromium drop its red squiggle markers, so idle tiles render clean.
  const [focused, setFocused] = useState(false);

  // Checkpoint immediately (not merely once per focus session): discrete actions inside a
  // typing session — autoformat conversions and checkbox toggles — get their own undo step,
  // so undo restores the literal marker text or the previous checked state.
  const recordNow = () => { onStartChange(); changeStarted.current = true; };

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (agentTurn) {
      // Agent-authored content reveals through the shared turn queue: the
      // document state is already committed (acks, undo, autosave see it), so
      // the tile types toward it instead of repainting instantly. Each queued
      // task re-checks the live DOM when it runs — cumulative appends morph
      // through their intermediate states like continuous typing.
      const target = block.html;
      queueAgentAnimation(async (isStale) => {
        const node = ref.current;
        if (!node || isStale() || node.innerHTML === target) return;
        reportAgentFocus(node);
        await animateTextTransition(node, target, isStale, () => renderMathIn(node));
      });
      return;
    }
    // Outside a turn any queued reveal is obsolete: invalidate it, then snap
    // the DOM to the real state (mid-animation tiles rewrite here on turn end).
    cancelAgentAnimations();
    if (element.innerHTML !== block.html && document.activeElement !== element) {
      element.innerHTML = block.html;
    }
    // Math fields render into shadow roots that stored HTML never contains, so the first
    // mount and every rewrite need a render pass (idempotent when nothing changed).
    renderMathIn(element);
  }, [block.html, agentTurn]);

  return (
    <div
      ref={ref}
      className="text-block"
      // Read-only while an agent turn streams into the document: dropping
      // contentEditable also releases focus, so the incoming agent HTML can
      // render without fighting the caret.
      contentEditable={!agentTurn}
      suppressContentEditableWarning
      spellCheck={focused}
      data-placeholder="Start writing…"
      onFocus={() => { setFocused(true); startValue.current = ref.current?.innerHTML ?? ""; changeStarted.current = false; }}
      onInput={(event) => {
        const element = event.currentTarget;
        if (enterInChecklist.current) {
          fixChecklistAfterEnter(element, enterInChecklist.current);
          enterInChecklist.current = null;
        }
        normalizeRichContent(element);
        renderMathIn(element);
        if (!changeStarted.current) { onStartChange(); changeStarted.current = true; }
        // Stored HTML is cleaned of caret anchors; the live DOM keeps them so the trick
        // holds while focused (the layout effect above skips the focused element).
        onChange(stripCaretArtifacts(element.innerHTML), false);
      }}
      onBlur={(event) => {
        setFocused(false);
        const value = stripCaretArtifacts(event.currentTarget.innerHTML);
        // Caret anchors are only needed while editing; with focus gone, scrub them from
        // the live DOM too (the stored HTML alone won't trigger a rewrite when equal).
        if (event.currentTarget.innerHTML !== value) {
          event.currentTarget.innerHTML = value;
          renderMathIn(event.currentTarget);
        }
        if (value !== startValue.current) onChange(value, false);
      }}
      onMouseDown={(event) => {
        if (agentTurn) return;
        const item = checklistHit(event);
        if (item) {
          // Keep the caret where it is — the click toggles state, it doesn't edit text.
          event.preventDefault();
          recordNow();
          toggleChecklistItem(item);
          notifyInput(event.currentTarget);
        }
      }}
      onClick={(event) => {
        const target = event.target instanceof Element ? event.target : null;
        const link = target?.closest("a");
        if (link && event.currentTarget.contains(link)) {
          // A tile link must never navigate the app's webview: a plain click opens the
          // preview popover, Ctrl/Cmd+Click opens the destination externally right away.
          event.preventDefault();
          if (event.ctrlKey || event.metaKey) openLinkExternally(link.getAttribute("href") ?? "");
          else openLinkPreview(link as HTMLAnchorElement);
          return;
        }
        if (agentTurn) return;
        const field = target?.closest<HTMLElement>(".math-field") ?? null;
        if (field && event.currentTarget.contains(field)) openMathEditor(field);
      }}
      onPaste={(event) => {
        if (handleLinkPaste(event.clipboardData, event.currentTarget, recordNow)) event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (event.key === "Tab") {
          event.preventDefault();
          if (!handleTableTab(event.currentTarget, event.shiftKey)) {
            document.execCommand("insertText", false, "    ");
          }
          return;
        }
        if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          if (handleTableArrow(event.currentTarget, event.key === "ArrowUp")) event.preventDefault();
          return;
        }
        if (event.key === " " && !event.ctrlKey && !event.metaKey) {
          if (applyAutoformat(event.currentTarget, recordNow) || applyLinkAutoformat(event.currentTarget, recordNow)) {
            event.preventDefault();
            return;
          }
        }
        if (event.key === "Enter" && !event.shiftKey) {
          if (applyRuleAutoformat(event.currentTarget, recordNow)) {
            event.preventDefault();
            return;
          }
          enterInChecklist.current = checklistCaretItem(event.currentTarget);
        }
      }}
    />
  );
}
