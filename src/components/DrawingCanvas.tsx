import { useEffect, useRef, useState } from "react";
import type { DrawingBlock, DrawingPoint, DrawingStroke } from "../document/types";
import { MIN_DRAWING_HEIGHT, uuid } from "../document/factories";
import { EraserIcon, HighlighterIcon, PenIcon, TrashIcon, UndoIcon } from "./icons";

interface Props {
  block: DrawingBlock;
  onChange: (block: DrawingBlock, record?: boolean) => void;
}

export function DrawingCanvas({ block, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workingStroke = useRef<DrawingStroke | null>(null);
  const [tool, setTool] = useState<DrawingStroke["tool"]>("pen");
  const [width, setWidth] = useState(3);

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    // getBoundingClientRect is post CSS-zoom (`.page-stack { zoom: var(--editor-zoom) }`),
    // while offsetWidth is pre-zoom layout px. Their ratio is the current zoom factor, used
    // below to keep rendered stroke thickness in sync with the zoomed geometry. Persisted
    // stroke.width stays in layout px; only the rasterized lineWidth is scaled.
    const zoom = rect.width / (canvas.offsetWidth || rect.width);
    const expectedWidth = Math.max(1, Math.round(rect.width * scale));
    const expectedHeight = Math.max(1, Math.round(rect.height * scale));
    if (canvas.width !== expectedWidth || canvas.height !== expectedHeight) {
      canvas.width = expectedWidth;
      canvas.height = expectedHeight;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    [...block.strokes, ...(workingStroke.current ? [workingStroke.current] : [])].forEach((stroke) => {
      if (stroke.points.length < 2) return;
      context.save();
      context.globalAlpha = stroke.opacity;
      context.lineWidth = stroke.width * zoom;
      context.lineCap = "round";
      context.lineJoin = "round";
      if (stroke.tool === "eraser") {
        context.globalCompositeOperation = "destination-out";
        context.strokeStyle = "rgba(0,0,0,1)";
      } else {
        context.globalCompositeOperation = "source-over";
        context.strokeStyle = stroke.tool === "highlighter" ? "#e9c84a" : getComputedStyle(canvas).color;
      }
      context.beginPath();
      stroke.points.forEach((point, index) => {
        const x = point.x * rect.width;
        const y = point.y * rect.height;
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      });
      context.stroke();
      context.restore();
    });
  };

  useEffect(draw, [block.height, block.strokes]);
  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [block.height, block.strokes]);
  useEffect(() => {
    // Theme changes toggle data-theme; workspace zoom sets the --editor-zoom custom
    // property as an inline style on the same element (Toolbar.tsx). Watch both so a
    // zoom change re-rasterizes strokes immediately instead of waiting for a redraw
    // triggered by something else.
    const observer = new MutationObserver(() => draw());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    return () => observer.disconnect();
  }, [block.height, block.strokes]);

  const pointFromEvent = (event: React.PointerEvent<HTMLCanvasElement>): DrawingPoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
      pressure: event.pressure || 0.5
    };
  };

  return (
    <div className="drawing-shell" style={{ minHeight: MIN_DRAWING_HEIGHT }}>
      <div className="page-tool-rail drawing-toolbar" aria-label="Drawing tools">
        <button title="Pen" aria-label="Pen" className={tool === "pen" ? "is-active" : ""} onClick={() => setTool("pen")}><PenIcon size={15}/></button>
        <button title="Highlighter" aria-label="Highlighter" className={tool === "highlighter" ? "is-active" : ""} onClick={() => setTool("highlighter")}><HighlighterIcon size={15}/></button>
        <button title="Eraser" aria-label="Eraser" className={tool === "eraser" ? "is-active" : ""} onClick={() => setTool("eraser")}><EraserIcon size={15}/></button>
        <label className="drawing-width" title={`Stroke width: ${width}`}><span className="sr-only">Stroke width</span><input aria-label="Stroke width" type="range" min="1" max="24" value={width} onChange={(event) => setWidth(Number(event.target.value))}/></label>
        <span className="drawing-toolbar__rule" />
        <button title="Undo stroke" aria-label="Undo stroke" disabled={!block.strokes.length} onClick={() => onChange({ ...block, strokes: block.strokes.slice(0, -1) }, true)}><UndoIcon size={15}/></button>
        <button title="Clear drawing" aria-label="Clear drawing" disabled={!block.strokes.length} onClick={() => onChange({ ...block, strokes: [] }, true)}><TrashIcon size={15}/></button>
      </div>
      <canvas
        ref={canvasRef}
        className="drawing-canvas"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          workingStroke.current = {
            id: uuid(), tool, width: tool === "eraser" ? width * 2 : width,
            opacity: tool === "highlighter" ? 0.4 : 1,
            points: [pointFromEvent(event)]
          };
          draw();
        }}
        onPointerMove={(event) => {
          if (!workingStroke.current) return;
          workingStroke.current.points.push(pointFromEvent(event));
          draw();
        }}
        onPointerUp={(event) => {
          if (!workingStroke.current) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          const stroke = workingStroke.current;
          workingStroke.current = null;
          onChange({ ...block, strokes: [...block.strokes, stroke] }, true);
        }}
      />
    </div>
  );
}
