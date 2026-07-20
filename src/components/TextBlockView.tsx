import { useLayoutEffect, useRef } from "react";
import { useDocument } from "../document/DocumentContext";
import type { TextBlock } from "../document/types";

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
      data-placeholder="Start writing…"
      onFocus={() => { startValue.current = ref.current?.innerHTML ?? ""; changeStarted.current = false; }}
      onInput={(event) => {
        if (!changeStarted.current) { onStartChange(); changeStarted.current = true; }
        onChange(event.currentTarget.innerHTML, false);
      }}
      onBlur={(event) => {
        const value = event.currentTarget.innerHTML;
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
