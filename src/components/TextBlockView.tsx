import { useLayoutEffect, useRef, useState } from "react";
import { useDocument } from "../document/DocumentContext";
import type { TextBlock } from "../document/types";
import { stripCaretArtifacts } from "../utils/editorHtml";

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
  // Spellcheck only while the tile is being edited: flipping the attribute off on blur makes
  // Chromium drop its red squiggle markers, so idle tiles render clean.
  const [focused, setFocused] = useState(false);

  useLayoutEffect(() => {
    if (ref.current && ref.current.innerHTML !== block.html && document.activeElement !== ref.current) {
      ref.current.innerHTML = block.html;
    }
  }, [block.html]);

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
        if (!changeStarted.current) { onStartChange(); changeStarted.current = true; }
        // Stored HTML is cleaned of caret anchors; the live DOM keeps them so the trick
        // holds while focused (the layout effect above skips the focused element).
        onChange(stripCaretArtifacts(event.currentTarget.innerHTML), false);
      }}
      onBlur={(event) => {
        setFocused(false);
        const value = stripCaretArtifacts(event.currentTarget.innerHTML);
        // Caret anchors are only needed while editing; with focus gone, scrub them from
        // the live DOM too (the stored HTML alone won't trigger a rewrite when equal).
        if (event.currentTarget.innerHTML !== value) event.currentTarget.innerHTML = value;
        if (value !== startValue.current) onChange(value, false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Tab") {
          event.preventDefault();
          document.execCommand("insertText", false, "    ");
        }
      }}
    />
  );
}
