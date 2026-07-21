import { useDocument } from "../document/DocumentContext";
import { useTileSelection } from "./TileSelectionContext";
import type { InktilePage } from "../document/types";
import { useRef } from "react";
import type { CSSProperties } from "react";
import { BlockRenderer } from "./BlockRenderer";
import { DrawingCanvas } from "./DrawingCanvas";
import { ElementScrollbar } from "./ElementScrollbar";
import { FlipIcon, GripIcon, TrashIcon } from "./icons";

interface Props {
  page: InktilePage;
  index: number;
  columnIndex: number;
  rowSize: number;
  widthBefore: number;
  rightRailOffset: number;
  dragged: boolean;
  dropPosition: "before" | "after" | "left" | "right" | null;
  onDragStart: (pageId: string) => void;
  onDragMove: (clientX: number, clientY: number) => void;
  onDragEnd: () => void;
  onDragCancel: () => void;
  onMoveBy: (delta: -1 | 1) => void;
}

export function PageView({ page, index, columnIndex, rowSize, widthBefore, rightRailOffset, dragged, dropPosition, onDragStart, onDragMove, onDragEnd, onDragCancel, onMoveBy }: Props) {
  const { document, deletePage, togglePageSide, updatePageDrawing } = useDocument();
  const { isSelected, toggleSelected, selectOnly } = useTileSelection();
  const selectedTile = isSelected(page.id);
  // Distinguishes a plain handle click (collapse the selection to this tile) from a real
  // drag (move the selection): any pointer travel past a small jitter threshold is a drag.
  const dragGestureRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);
  const side = page.activeSide;
  const showNotes = side === "back";
  // The notes scroller: notes never affect the card's height (the front face alone sizes
  // it); overflowing notes scroll inside the card via the shared ElementScrollbar overlay.
  const notesScrollerRef = useRef<HTMLDivElement | null>(null);
  // Both faces are always rendered, but only the FRONT face is in flow: the card is sized
  // by the front side alone and never resizes when flipping between page and notes.
  // Page type is a property of the FRONT face; the back face is always plain notes text.
  const frontPrimary = page.front.blocks[0];
  const drawingFront = page.type === "drawing";
  // A media page owns a single image/video block; it fills the card edge-to-edge with no padding.
  const mediaFront = page.front.blocks.length === 1 && (frontPrimary?.type === "image" || frontPrimary?.type === "video");
  // The versions rail lives on the front face; tag the card so CSS and DOM-based minimum-height
  // measurement (PageStack.tsx) can target versions pages specifically.
  const variantsFront = frontPrimary?.type === "variants";
  const frontCompact = frontPrimary?.type === "text" || frontPrimary?.type === "variants" || frontPrimary?.type === "audio";
  // An audio front is a single short player bar; it centers vertically in the tile.
  const audioFront = frontPrimary?.type === "audio";
  const verticalAlign = page.verticalAlign ?? "top";
  const compactPadding = Math.max(8, Math.round(document.settings.contentPadding / 2));
  const frontFills = drawingFront || mediaFront;
  // Media/drawing fronts fill edge-to-edge (no padding); text-like fronts and the notes back
  // use the compact vertical padding, other block fronts the full content padding.
  const frontPadding = frontFills ? 0 : `${frontCompact ? compactPadding : document.settings.contentPadding}px ${document.settings.contentPadding}px`;
  const backPadding = `${compactPadding}px ${document.settings.contentPadding}px`;
  // Rails and handles are positioned from the ROW's outer edges, not each page's own
  // box. The row width is constant during a column drag, so `--inktile-cell-start` (this
  // cell's left offset = row width * the fraction before it) is the only fraction-dependent
  // term. The pixel terms count cells (the left-handle stack) and the right-rail stack.
  // Both right rails (versions, drawing) anchor to a positioned ancestor that fills the
  // page card edge-to-edge, so both use the same `--inktile-right-rail-full` formula.
  const externalRailStyles = {
    width: "100%",
    "--inktile-cell-start": `calc(var(--inktile-row-width) * ${widthBefore})`,
    "--inktile-left-handle": `calc(-1 * var(--inktile-cell-start) - ${(rowSize - columnIndex) * 35 + 5}px)`,
    "--inktile-right-rail-full": `calc(var(--inktile-row-width) - var(--inktile-cell-start) + ${rightRailOffset + 8}px)`
  } as CSSProperties;

  return (
    <article
      data-page-id={page.id}
      className={`page-wrapper ${dragged ? "is-dragging" : ""} ${selectedTile ? "is-selected" : ""} ${dropPosition ? `drop-${dropPosition}` : ""}`}
      style={externalRailStyles}
    >
      <aside className="page-handle" aria-label={`Tile ${index + 1} controls`}>
        <div
          className="page-handle__drag"
          role="button"
          tabIndex={0}
          aria-pressed={selectedTile}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            // Ctrl/Cmd+Click toggles the tile in and out of the multi-selection
            // instead of starting a drag.
            if (event.ctrlKey || event.metaKey) {
              toggleSelected(page.id);
              return;
            }
            dragGestureRef.current = { startX: event.clientX, startY: event.clientY, moved: false };
            event.currentTarget.setPointerCapture(event.pointerId);
            onDragStart(page.id);
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const gesture = dragGestureRef.current;
            if (gesture && !gesture.moved && Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 3) {
              gesture.moved = true;
            }
            onDragMove(event.clientX, event.clientY);
          }}
          onPointerUp={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            event.currentTarget.releasePointerCapture(event.pointerId);
            const clicked = dragGestureRef.current !== null && !dragGestureRef.current.moved;
            dragGestureRef.current = null;
            onDragEnd();
            // A stationary press-and-release is a click: it selects exactly this tile,
            // releasing any other selected tiles.
            if (clicked) selectOnly(page.id);
          }}
          onPointerCancel={() => {
            dragGestureRef.current = null;
            onDragCancel();
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") { event.preventDefault(); onMoveBy(-1); }
            if (event.key === "ArrowDown") { event.preventDefault(); onMoveBy(1); }
          }}
          title={`Drag tile ${index + 1} above, below, left, or right; Ctrl+Click selects multiple tiles; arrow keys move vertically`}
        >
          <GripIcon />
          <span>{index + 1}</span>
        </div>
        <button className="page-handle__notes" onClick={() => togglePageSide(page.id)} title={showNotes ? "Return to tile" : "Show notes"} aria-label={showNotes ? `Return to tile ${index + 1}` : `Show notes for tile ${index + 1}`}>
          {/* One steady glyph both ways: the action is always "flip", whichever side shows. */}
          <FlipIcon size={14}/>
        </button>
        <button className="page-handle__delete" onClick={() => deletePage(page.id)} title={`Delete tile ${index + 1}`} aria-label={`Delete tile ${index + 1}`}>
          <TrashIcon size={14} />
        </button>
      </aside>

      <div className={`page-card ${drawingFront ? "page-card--drawing" : ""} ${mediaFront ? "page-card--media" : ""} ${variantsFront ? "page-card--variants" : ""} ${showNotes ? "is-flipped" : ""}`} style={{ width: "100%" }}>
        <div
          className={`page-face page-face--front page-face--align-${verticalAlign} ${drawingFront ? "page-face--drawing" : ""} ${mediaFront ? "page-face--media" : ""} ${audioFront ? "page-face--audio" : ""} ${showNotes ? "is-inactive" : "is-active"}`}
          style={{ padding: frontPadding }}
          aria-hidden={showNotes}
          inert={showNotes}
        >
          {drawingFront && page.drawing ? (
            <DrawingCanvas block={page.drawing} onChange={(drawing, record) => updatePageDrawing(page.id, drawing, record)} />
          ) : (
            <div className="page-blocks">
              {page.front.blocks.map((block) => <BlockRenderer key={block.id} pageId={page.id} side="front" block={block} />)}
            </div>
          )}
        </div>

        <div
          className={`page-face page-face--back page-face--align-${verticalAlign} ${showNotes ? "is-active" : "is-inactive"}`}
          style={{ padding: backPadding }}
          aria-hidden={!showNotes}
          inert={!showNotes}
        >
          <div className="page-side-label">Notes</div>
          <div className="page-blocks" ref={notesScrollerRef}>
            {(page.back?.blocks ?? []).map((block) => <BlockRenderer key={block.id} pageId={page.id} side="back" block={block} />)}
          </div>
          <ElementScrollbar
            scrollerRef={notesScrollerRef}
            watch={page.back}
            label={`Scroll notes for tile ${index + 1}`}
            className="notes-scrollbar"
          />
        </div>
      </div>
    </article>
  );
}
