import { useLayoutEffect, useRef, useState } from "react";
import { useDocument } from "../document/DocumentContext";
import { uuid } from "../document/factories";
import type { VariantGroupBlock } from "../document/types";
import { stripCaretArtifacts } from "../utils/editorHtml";
import {
  applyAutoformat, applyLinkAutoformat, applyRuleAutoformat, checklistCaretItem, checklistHit,
  fixChecklistAfterEnter, handleLinkPaste, handleTableArrow, handleTableTab, normalizeRichContent,
  notifyInput, openLinkExternally, toggleChecklistItem
} from "../utils/richText";
import { renderMathIn } from "../utils/mathField";
import { openMathEditor } from "./MathEditor";
import { openLinkPreview } from "./LinkPreview";
import { ChevronUp, ChevronDown, MinusIcon, PlusIcon, TextIcon } from "./icons";

interface Props {
  block: VariantGroupBlock;
  onChange: (block: VariantGroupBlock, record?: boolean) => void;
  onStartChange: () => void;
  onConvertToText: () => void;
}

export function VariantBlockView({ block, onChange, onStartChange, onConvertToText }: Props) {
  const { agentTurn } = useDocument();
  const active = block.variants[block.activeVariant];
  const editorRef = useRef<HTMLDivElement>(null);
  const editStarted = useRef(false);
  // Same pending Enter-in-checklist fixup as TextBlockView (see fixChecklistAfterEnter).
  const enterInChecklist = useRef<HTMLLIElement | null>(null);
  // Spellcheck only while editing, mirroring TextBlockView: idle tiles show no squiggles.
  const [focused, setFocused] = useState(false);

  // Immediate checkpoint for discrete in-session actions (autoformat, checkbox toggles),
  // mirroring TextBlockView's recordNow.
  const recordNow = () => { onStartChange(); editStarted.current = true; };

  useLayoutEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML !== active.html && document.activeElement !== editorRef.current) {
      editorRef.current.innerHTML = active.html;
    }
    // Math fields live in shadow roots stored HTML never contains; render after any rewrite.
    if (editorRef.current) renderMathIn(editorRef.current);
  }, [active.id, active.html]);

  const changeIndex = (delta: number) => {
    const count = block.variants.length;
    onChange({ ...block, activeVariant: (block.activeVariant + delta + count) % count }, true);
  };

  return (
    <section className="variant-block">
      <aside className="page-tool-rail variant-toolbar" aria-label="Version controls">
          <button title="Previous version" onClick={() => changeIndex(-1)} aria-label="Previous version"><ChevronUp size={15} /></button>
          <span className="variant-progress" aria-label={`Version ${block.activeVariant + 1} of ${block.variants.length}`}>{block.activeVariant + 1}/{block.variants.length}</span>
          <button title="Next version" onClick={() => changeIndex(1)} aria-label="Next version"><ChevronDown size={15} /></button>
          <button title="Use selected version as text tile" aria-label="Use selected version as text tile" onClick={onConvertToText}><TextIcon size={15} /></button>
          <button title="Add version" aria-label="Add version" onClick={() => {
            const variants = [...block.variants, { id: uuid(), label: "", html: "" }];
            onChange({ ...block, variants, activeVariant: variants.length - 1 }, true);
          }}><PlusIcon size={14} /></button>
          <button title="Delete version" aria-label="Delete version" disabled={block.variants.length === 1} onClick={() => {
            if (block.variants.length === 1) return;
            const variants = block.variants.filter((_, index) => index !== block.activeVariant);
            onChange({ ...block, variants, activeVariant: Math.min(block.activeVariant, variants.length - 1) }, true);
          }}><MinusIcon size={16} /></button>
      </aside>
        <div
          ref={editorRef}
          className="variant-editor"
          contentEditable
          suppressContentEditableWarning
          spellCheck={focused}
          data-placeholder={`Write version ${block.activeVariant + 1}…`}
          onFocus={() => { setFocused(true); editStarted.current = false; }}
          onBlur={(event) => {
            setFocused(false);
            // Scrub caret anchors from the live DOM once editing ends (stored HTML is
            // already stripped on every input, so no rewrite would happen otherwise).
            const value = stripCaretArtifacts(event.currentTarget.innerHTML);
            if (event.currentTarget.innerHTML !== value) {
              event.currentTarget.innerHTML = value;
              renderMathIn(event.currentTarget);
            }
          }}
          onMouseDown={(event) => {
            if (agentTurn) return;
            const item = checklistHit(event);
            if (item) {
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
              // Same contract as TextBlockView: plain click previews, Ctrl/Cmd+Click opens.
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
              // Only tables consume Tab here: outside one, versions keep native focus travel.
              if (handleTableTab(event.currentTarget, event.shiftKey)) event.preventDefault();
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
          onInput={(event) => {
            const element = event.currentTarget;
            if (enterInChecklist.current) {
              fixChecklistAfterEnter(element, enterInChecklist.current);
              enterInChecklist.current = null;
            }
            normalizeRichContent(element);
            renderMathIn(element);
            if (!editStarted.current) { onStartChange(); editStarted.current = true; }
            const html = stripCaretArtifacts(element.innerHTML);
            const variants = block.variants.map((variant, index) => index === block.activeVariant ? { ...variant, html } : variant);
            onChange({ ...block, variants }, false);
          }}
        />
    </section>
  );
}
