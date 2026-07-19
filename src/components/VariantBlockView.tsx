import { useLayoutEffect, useRef } from "react";
import { uuid } from "../document/factories";
import type { VariantGroupBlock } from "../document/types";
import { ChevronUp, ChevronDown, PlusIcon, TextIcon, TrashIcon } from "./icons";

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
          <button title="Use selected version as text page" aria-label="Use selected version as text page" onClick={onConvertToText}><TextIcon size={15} /></button>
          <button title="Add version" aria-label="Add version" onClick={() => {
            const variants = [...block.variants, { id: uuid(), label: "", html: "" }];
            onChange({ ...block, variants, activeVariant: variants.length - 1 }, true);
          }}><PlusIcon size={14} /></button>
          <button title="Delete version" aria-label="Delete version" disabled={block.variants.length === 1} onClick={() => {
            if (block.variants.length === 1) return;
            const variants = block.variants.filter((_, index) => index !== block.activeVariant);
            onChange({ ...block, variants, activeVariant: Math.min(block.activeVariant, variants.length - 1) }, true);
          }}><TrashIcon size={14} /></button>
      </aside>
        <div
          ref={editorRef}
          className="variant-editor"
          contentEditable
          suppressContentEditableWarning
          data-placeholder={`Write version ${block.activeVariant + 1}…`}
          onFocus={() => { editStarted.current = false; }}
          onInput={(event) => {
            if (!editStarted.current) { onStartChange(); editStarted.current = true; }
            const variants = block.variants.map((variant, index) => index === block.activeVariant ? { ...variant, html: event.currentTarget.innerHTML } : variant);
            onChange({ ...block, variants }, false);
          }}
        />
    </section>
  );
}
