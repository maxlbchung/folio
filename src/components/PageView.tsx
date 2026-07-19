import { useDocument } from "../document/DocumentContext";
import type { FolioPage, PageSide } from "../document/types";
import type { CSSProperties } from "react";
import { BlockRenderer } from "./BlockRenderer";
import { DrawingCanvas } from "./DrawingCanvas";
import { FlipIcon, GripIcon, NoteIcon, TrashIcon } from "./icons";

interface Props {
  page: FolioPage;
  index: number;
  columnIndex: number;
  rowSize: number;
  widthBefore: number;
  rightRailOffset: number;
  draggedPageId: string | null;
  dropPosition: "before" | "after" | "left" | "right" | null;
  onDragStart: (pageId: string) => void;
  onDragMove: (clientX: number, clientY: number) => void;
  onDragEnd: () => void;
  onDragCancel: () => void;
  onMoveBy: (delta: -1 | 1) => void;
}

export function PageView({ page, index, columnIndex, rowSize, widthBefore, rightRailOffset, draggedPageId, dropPosition, onDragStart, onDragMove, onDragEnd, onDragCancel, onMoveBy }: Props) {
  const { document, deletePage, togglePageSide, updatePageDrawing } = useDocument();
  const side = page.activeSide;
  const face = side === "front" ? page.front : page.back;
  const primaryBlock = face?.blocks[0];
  const drawingFront = page.type === "drawing" && side === "front";
  // A media page owns a single image/video block; it fills the card edge-to-edge with no padding.
  const mediaFront = side === "front" && face?.blocks.length === 1 && (primaryBlock?.type === "image" || primaryBlock?.type === "video");
  // The versions rail only renders on the active face when its primary block is a variants
  // block (the back/notes face is always plain text). Tag the card so CSS and DOM-based
  // minimum-height measurement (PageStack.tsx) can target versions pages specifically.
  const variantsFront = side === "front" && primaryBlock?.type === "variants";
  const compactTextPage = side === "back" || primaryBlock?.type === "text" || primaryBlock?.type === "variants" || primaryBlock?.type === "audio";
  const verticalAlign = page.verticalAlign ?? "center";
  const verticalPadding = compactTextPage ? Math.max(8, Math.round(document.settings.contentPadding / 2)) : document.settings.contentPadding;
  // Rails and handles are positioned from the ROW's outer edges, not each page's own
  // box. The row width is constant during a column drag, so `--folio-cell-start` (this
  // cell's left offset = row width * the fraction before it) is the only fraction-dependent
  // term. The pixel terms count cells (the left-handle stack) and the right-rail stack.
  // Both right rails (versions, drawing) anchor to a positioned ancestor that fills the
  // page card edge-to-edge, so both use the same `--folio-right-rail-full` formula.
  const externalRailStyles = {
    width: "100%",
    "--folio-cell-start": `calc(var(--folio-row-width) * ${widthBefore})`,
    "--folio-left-handle": `calc(-1 * var(--folio-cell-start) - ${(rowSize - columnIndex) * 30 + 8}px)`,
    "--folio-right-rail-full": `calc(var(--folio-row-width) - var(--folio-cell-start) + ${rightRailOffset + 8}px)`
  } as CSSProperties;

  return (
    <article
      data-page-id={page.id}
      className={`page-wrapper ${draggedPageId === page.id ? "is-dragging" : ""} ${dropPosition ? `drop-${dropPosition}` : ""}`}
      style={externalRailStyles}
    >
      <aside className="page-handle" aria-label={`Page ${index + 1} controls`}>
        <div
          className="page-handle__drag"
          role="button"
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onDragStart(page.id);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) onDragMove(event.clientX, event.clientY);
          }}
          onPointerUp={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            event.currentTarget.releasePointerCapture(event.pointerId);
            onDragEnd();
          }}
          onPointerCancel={onDragCancel}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") { event.preventDefault(); onMoveBy(-1); }
            if (event.key === "ArrowDown") { event.preventDefault(); onMoveBy(1); }
          }}
          title={`Drag page ${index + 1} above, below, left, or right; use arrow keys for vertical moves`}
        >
          <GripIcon />
          <span>{index + 1}</span>
        </div>
        <button className="page-handle__notes" onClick={() => togglePageSide(page.id)} title={side === "front" ? "Show notes" : "Return to page"} aria-label={side === "front" ? `Show notes for page ${index + 1}` : `Return to page ${index + 1}`}>
          {side === "front" ? <NoteIcon size={14}/> : <FlipIcon size={14}/>} 
        </button>
        <button className="page-handle__delete" onClick={() => deletePage(page.id)} title={`Delete page ${index + 1}`} aria-label={`Delete page ${index + 1}`}>
          <TrashIcon size={14} />
        </button>
      </aside>

      <div className={`page-card ${drawingFront ? "page-card--drawing" : ""} ${mediaFront ? "page-card--media" : ""} ${variantsFront ? "page-card--variants" : ""} ${compactTextPage ? `page-card--text page-card--align-${verticalAlign}` : ""} ${side === "back" ? "is-flipped" : ""}`} style={{
        width: "100%",
        padding: drawingFront || mediaFront ? 0 : `${verticalPadding}px ${document.settings.contentPadding}px`
      }}>
        {side === "back" && <div className="page-side-label">Notes</div>}

        {drawingFront && page.drawing ? (
          <DrawingCanvas block={page.drawing} onChange={(drawing, record) => updatePageDrawing(page.id, drawing, record)} />
        ) : (
          <div className="page-blocks">
            {(face?.blocks ?? []).map((block) => <BlockRenderer key={block.id} pageId={page.id} side={side as PageSide} block={block} />)}
          </div>
        )}
      </div>
    </article>
  );
}
