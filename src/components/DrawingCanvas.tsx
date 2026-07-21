import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { animateFrames, animationPause, cancelAgentAnimations, queueAgentAnimation, reportAgentFocus } from "../agent/animations";
import { useDocument } from "../document/DocumentContext";
import type { DrawingBlock, DrawingPoint, DrawingStroke } from "../document/types";
import { MIN_DRAWING_HEIGHT, uuid } from "../document/factories";
import { EraserIcon, HighlighterIcon, PenIcon, TrashIcon, UndoIcon } from "./icons";

interface Props {
  block: DrawingBlock;
  onChange: (block: DrawingBlock, record?: boolean) => void;
}

/** Value equality — commits structuredClone the document, so identity never holds. */
const strokesEqual = (a: DrawingStroke, b: DrawingStroke): boolean =>
  a.tool === b.tool && a.width === b.width && a.opacity === b.opacity &&
  a.points.length === b.points.length &&
  a.points.every((point, index) => point.x === b.points[index].x && point.y === b.points[index].y);

export function DrawingCanvas({ block, onChange }: Props) {
  const { agentTurn } = useDocument();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const cursorPoint = useRef<{ x: number; y: number } | null>(null);
  const workingStroke = useRef<DrawingStroke | null>(null);
  // What the canvas currently shows. Outside agent turns it tracks block.strokes
  // exactly; during a turn it lags behind while queued animations catch it up.
  const displayedStrokes = useRef<DrawingStroke[]>(block.strokes);
  const [tool, setTool] = useState<DrawingStroke["tool"]>("pen");
  const [width, setWidth] = useState(3);

  const syncDrawingCursor = (canvas: HTMLCanvasElement, point = cursorPoint.current) => {
    const cursor = cursorRef.current;
    if (!cursor || !point) return;
    const rect = canvas.getBoundingClientRect();
    // Stroke widths are stored in layout px. The canvas painter multiplies them by
    // this same rendered/layout ratio, which includes both workspace zoom and the
    // app's UI scale. The circle diameter therefore stays identical to the pixels
    // the active tool will affect; the fixed-length prongs are deliberately excluded.
    const renderedScale = rect.width / (canvas.offsetWidth || rect.width);
    const strokeWidth = tool === "eraser" ? width * 2 : width;
    cursor.style.setProperty("--drawing-cursor-diameter", `${strokeWidth * renderedScale}px`);
    cursor.style.left = `${point.x}px`;
    cursor.style.top = `${point.y}px`;
    cursor.dataset.visible = "true";
  };

  const moveDrawingCursor = (canvas: HTMLCanvasElement, x: number, y: number) => {
    cursorPoint.current = { x, y };
    syncDrawingCursor(canvas, cursorPoint.current);
  };

  const paint = (strokes: DrawingStroke[]) => {
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
    [...strokes, ...(workingStroke.current ? [workingStroke.current] : [])].forEach((stroke) => {
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

  const draw = () => paint(displayedStrokes.current);

  /** Catches the canvas up to target: vanished strokes erase one by one, moved or
   * restyled strokes lerp into place, and new strokes draw out point by point in
   * paint order — quick individually, sequential as a whole. */
  const animateToward = async (target: DrawingStroke[], isStale: () => boolean) => {
    const targetById = new Map(target.map((stroke) => [stroke.id, stroke]));
    for (const stroke of [...displayedStrokes.current]) {
      if (targetById.has(stroke.id)) continue;
      if (isStale()) return;
      displayedStrokes.current = displayedStrokes.current.filter((existing) => existing.id !== stroke.id);
      draw();
      await animationPause(120, isStale);
    }
    const startById = new Map(displayedStrokes.current.map((stroke) => [stroke.id, stroke]));
    const morphs = target.filter((stroke) => {
      const start = startById.get(stroke.id);
      return start && !strokesEqual(start, stroke);
    });
    if (morphs.length) {
      await animateFrames(360, isStale, (t) => {
        displayedStrokes.current = displayedStrokes.current.map((stroke) => {
          const to = targetById.get(stroke.id);
          const start = startById.get(stroke.id);
          if (!to || !start || strokesEqual(start, to)) return stroke;
          if (start.points.length !== to.points.length) return to;
          return {
            ...to,
            width: start.width + (to.width - start.width) * t,
            opacity: start.opacity + (to.opacity - start.opacity) * t,
            points: to.points.map((point, index) => ({
              ...point,
              x: start.points[index].x + (point.x - start.points[index].x) * t,
              y: start.points[index].y + (point.y - start.points[index].y) * t
            }))
          };
        });
        draw();
      });
      if (isStale()) return;
    }
    const done = new Set(displayedStrokes.current.map((stroke) => stroke.id));
    for (const stroke of target) {
      if (done.has(stroke.id)) continue;
      if (isStale()) return;
      const pointCount = stroke.points.length;
      await animateFrames(Math.min(700, Math.max(170, pointCount * 9)), isStale, (t) => {
        const visible = Math.max(2, Math.ceil(pointCount * t));
        const partial = { ...stroke, points: stroke.points.slice(0, visible) };
        // Rebuild in target paint order so erasers only affect ink painted before them.
        displayedStrokes.current = target
          .filter((candidate) => done.has(candidate.id) || candidate.id === stroke.id)
          .map((candidate) => (candidate.id === stroke.id ? partial : candidate));
        draw();
      });
      if (isStale()) return;
      done.add(stroke.id);
      await animationPause(80, isStale);
    }
    displayedStrokes.current = target;
    draw();
  };

  useEffect(() => {
    if (agentTurn) {
      const target = block.strokes;
      queueAgentAnimation(async (isStale) => {
        const canvas = canvasRef.current;
        if (!canvas || isStale()) return;
        const current = displayedStrokes.current;
        const changed = current.length !== target.length
          || target.some((stroke, index) => current[index]?.id !== stroke.id || !strokesEqual(current[index], stroke));
        if (changed) reportAgentFocus(canvas);
        await animateToward(target, isStale);
      });
      return;
    }
    cancelAgentAnimations();
    displayedStrokes.current = block.strokes;
    draw();
  }, [block.height, block.strokes, agentTurn]);
  useEffect(() => {
    const onResize = () => {
      draw();
      if (canvasRef.current) syncDrawingCursor(canvasRef.current);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [tool, width]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => {
      draw();
      syncDrawingCursor(canvas);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [block.height, block.strokes, tool, width]);
  useEffect(() => {
    // Theme changes toggle data-theme; workspace zoom sets the --editor-zoom custom
    // property as an inline style on the same element (Toolbar.tsx). Watch both so a
    // zoom change re-rasterizes strokes immediately instead of waiting for a redraw
    // triggered by something else.
    const canvas = canvasRef.current;
    if (!canvas) return;
    syncDrawingCursor(canvas);
    const observer = new MutationObserver(() => {
      draw();
      syncDrawingCursor(canvas);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    return () => observer.disconnect();
  }, [block.height, block.strokes, tool, width]);

  const pointFromEvent = (event: React.PointerEvent<HTMLCanvasElement>): DrawingPoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
      pressure: event.pressure || 0.5
    };
  };

  return (<>
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
        onPointerEnter={(event) => moveDrawingCursor(event.currentTarget, event.clientX, event.clientY)}
        onPointerLeave={() => {
          if (!workingStroke.current && cursorRef.current) cursorRef.current.dataset.visible = "false";
        }}
        onPointerDown={(event) => {
          moveDrawingCursor(event.currentTarget, event.clientX, event.clientY);
          event.currentTarget.setPointerCapture(event.pointerId);
          workingStroke.current = {
            id: uuid(), tool, width: tool === "eraser" ? width * 2 : width,
            opacity: tool === "highlighter" ? 0.4 : 1,
            points: [pointFromEvent(event)]
          };
          draw();
        }}
        onPointerMove={(event) => {
          moveDrawingCursor(event.currentTarget, event.clientX, event.clientY);
          if (!workingStroke.current) return;
          workingStroke.current.points.push(pointFromEvent(event));
          draw();
        }}
        onPointerUp={(event) => {
          if (!workingStroke.current) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          const stroke = workingStroke.current;
          workingStroke.current = null;
          const rect = event.currentTarget.getBoundingClientRect();
          if ((event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) && cursorRef.current) {
            cursorRef.current.dataset.visible = "false";
          }
          onChange({ ...block, strokes: [...block.strokes, stroke] }, true);
        }}
      />
    </div>
    {createPortal(
      <div ref={cursorRef} className="drawing-brush-cursor" data-visible="false" aria-hidden="true">
        <span className="drawing-brush-cursor__circle" />
        <span className="drawing-brush-cursor__prong drawing-brush-cursor__prong--top" />
        <span className="drawing-brush-cursor__prong drawing-brush-cursor__prong--right" />
        <span className="drawing-brush-cursor__prong drawing-brush-cursor__prong--bottom" />
        <span className="drawing-brush-cursor__prong drawing-brush-cursor__prong--left" />
      </div>,
      document.body
    )}
  </>);
}
