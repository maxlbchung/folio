import { useLayoutEffect, useRef, useState } from "react";
import { uuid } from "../document/factories";
import type { VariantGroupBlock } from "../document/types";
import { stripCaretArtifacts } from "../utils/editorHtml";
import { ChevronUp, ChevronDown, MinusIcon, PlusIcon, TextIcon } from "./icons";

interface Props {
  block: VariantGroupBlock;
  onChange: (block: VariantGroupBlock, record?: boolean) => void;
  onStartChange: () => void;
  onConvertToText: () => void;
}

export function VariantBlockView({ block, onChange, onStartChange, onConvertToText }: Props) {
  const active = block.variants[block.activeVariant];
  const editorRef = useRef<HTMLDivElement>(null);
  const editStarted = useRef(false);
  // Spellcheck only while editing, mirroring TextBlockView: idle tiles show no squiggles.
  const [focused, setFocused] = useState(false);

  useLayoutEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML !== active.html && document.activeElement !== editorRef.current) {
      editorRef.current.innerHTML = active.html;
    }
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
            if (event.currentTarget.innerHTML !== value) event.currentTarget.innerHTML = value;
          }}
          onInput={(event) => {
            if (!editStarted.current) { onStartChange(); editStarted.current = true; }
            const html = stripCaretArtifacts(event.currentTarget.innerHTML);
            const variants = block.variants.map((variant, index) => index === block.activeVariant ? { ...variant, html } : variant);
            onChange({ ...block, variants }, false);
          }}
        />
    </section>
  );
}
