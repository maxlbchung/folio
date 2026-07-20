import { useCallback, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useDocument } from "../document/DocumentContext";
import { useTileSelection } from "./TileSelectionContext";
import type { InktilePage } from "../document/types";
import { MIN_DRAWING_HEIGHT, MIN_MEDIA_HEIGHT, MIN_VERSIONS_HEIGHT } from "../document/factories";
import { PageView } from "./PageView";
import { PageInsertControl } from "./PageInsertControl";

type DropPosition = "before" | "after" | "left" | "right";

const rightRailWidth = (page: InktilePage): number => {
  if (page.type === "drawing" && page.activeSide === "front") return 32;
  const face = page.activeSide === "front" ? page.front : page.back;
  return face?.blocks[0]?.type === "variants" ? 32 : 0;
};

/** Fraction of the row width for each page. Absent/invalid fractions mean an equal split. */
const rowWidthFractions = (row: string[], pages: Record<string, InktilePage>): number[] => {
  if (row.length <= 1) return row.map(() => 1);
  const raw = row.map((pageId) => pages[pageId]?.layoutWidthFraction);
  const valid = raw.every((fraction) => typeof fraction === "number" && Number.isFinite(fraction) && fraction > 0)
    && Math.abs((raw as number[]).reduce((total, fraction) => total + fraction, 0) - 1) <= 0.001;
  return valid ? (raw as number[]) : row.map(() => 1 / row.length);
};

export function PageStack() {
  const { document, movePage, movePages, setPageRowHeight, setRowWidthFractions, checkpoint, agentTurn } = useDocument();
  const { selectedIds, selectedEdge, isSelected, selectOnly, selectEdge, clearSelection } = useTileSelection();
  const [draggedPageIds, setDraggedPageIds] = useState<string[]>([]);
  const [dropTarget, setDropTarget] = useState<{ pageId: string; position: DropPosition } | null>(null);
  const draggedRef = useRef<{ ids: string[]; set: Set<string> } | null>(null);
  const dropTargetRef = useRef<typeof dropTarget>(null);
  const rowResizeRef = useRef<{
    pageIds: string[];
    rowElement: HTMLElement;
    rowIndex: number;
    startY: number;
    startHeight: number;
    minHeight: number;
    scale: number;
    lastHeight: number;
    /** Set on first pointer travel past the jitter threshold; a still press is an edge click. */
    moved: boolean;
  } | null>(null);
  const [resizingRow, setResizingRow] = useState<string | null>(null);
  const columnResizeRef = useRef<{
    pageIds: string[];
    rowIndex: number;
    leftIndex: number;
    cells: HTMLElement[];
    rowWidth: number;
    scale: number;
    startX: number;
    startFractions: number[];
    minFraction: number;
    lastFractions: number[];
    handleElement: HTMLElement | null;
    /** Set on first pointer travel past the jitter threshold; a still press is an edge click. */
    moved: boolean;
  } | null>(null);
  const [columnResize, setColumnResize] = useState<{ rowKey: string; index: number } | null>(null);

  const minimumRowHeight = (rowElement: HTMLElement): number => {
    const cards = Array.from(rowElement.querySelectorAll<HTMLElement>(".page-card"));
    return Math.max(96, ...cards.map((card) => {
      if (card.classList.contains("page-card--drawing")) return MIN_DRAWING_HEIGHT;
      // Media fills the card, so its scrollHeight tracks the current height and could never
      // shrink; clamp to a fixed media minimum instead (audio keeps the content minimum).
      if (card.classList.contains("page-card--media")) return MIN_MEDIA_HEIGHT;
      // Both faces (page front + notes back) are stacked in the card; the fixed size must fit
      // whichever is taller, so measure each face's own content plus its own padding.
      const faces = Array.from(card.querySelectorAll<HTMLElement>(".page-face"));
      const contentMinHeight = Math.ceil(Math.max(0, ...faces.map((face) => {
        const blocks = face.querySelector<HTMLElement>(".page-blocks");
        const style = getComputedStyle(face);
        const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        return (blocks?.scrollHeight ?? 0) + padding;
      })));
      // The versions rail (~158px) can exceed the compact text minimum, but long version
      // text can still exceed the rail height too, so clamp to whichever is taller.
      if (card.classList.contains("page-card--variants")) return Math.max(MIN_VERSIONS_HEIGHT, contentMinHeight);
      return contentMinHeight;
    }));
  };

  const resizeRow = (clientY: number, persist = false) => {
    const resize = rowResizeRef.current;
    if (!resize) return;
    const height = Math.max(resize.minHeight, Math.min(1600, Math.round(resize.startHeight + (clientY - resize.startY) / resize.scale)));
    resize.lastHeight = height;
    resize.rowElement.style.minHeight = `${height}px`;
    if (persist) setPageRowHeight(resize.pageIds, height);
  };

  const resizeColumn = (clientX: number, persist = false) => {
    const resize = columnResizeRef.current;
    if (!resize) return;
    const { leftIndex, startFractions, rowWidth, scale, minFraction } = resize;
    const pairSum = startFractions[leftIndex] + startFractions[leftIndex + 1];
    // Recompute from the gesture's start state each move so the clamp stays symmetric.
    const deltaFraction = ((clientX - resize.startX) / scale) / rowWidth;
    const minLeft = minFraction;
    const maxLeft = pairSum - minFraction;
    let newLeft = startFractions[leftIndex] + deltaFraction;
    newLeft = minLeft <= maxLeft ? Math.min(maxLeft, Math.max(minLeft, newLeft)) : pairSum / 2;
    const newRight = pairSum - newLeft;
    const next = [...startFractions];
    next[leftIndex] = newLeft;
    next[leftIndex + 1] = newRight;
    resize.lastFractions = next;
    // Grow-proportional flex (not a fixed basis) so the 1px inter-cell border does not
    // skew an equal split, and the two cells always exactly refill the row width.
    resize.cells[leftIndex].style.flex = `${newLeft} ${newLeft} 0`;
    resize.cells[leftIndex + 1].style.flex = `${newRight} ${newRight} 0`;
    // Rails/handles read `--inktile-cell-start` (the cell's left offset in the row). Only the
    // right cell's start moves with the boundary; keep it in sync so that cell's handle and
    // rails stay pinned to the row's constant outer edges during the DOM-only drag.
    const rightBoundary = next.slice(0, leftIndex + 1).reduce((total, fraction) => total + fraction, 0);
    const rightWrapper = resize.cells[leftIndex + 1].querySelector<HTMLElement>("[data-page-id]");
    rightWrapper?.style.setProperty("--inktile-cell-start", `calc(var(--inktile-row-width) * ${rightBoundary})`);
    // Update the resize handle position to follow the moving boundary.
    if (resize.handleElement) {
      resize.handleElement.style.left = `${rightBoundary * 100}%`;
    }
    if (persist) setRowWidthFractions(resize.pageIds, next);
  };

  // Dragging a selected handle moves the whole selection together; dragging an
  // unselected handle makes that tile the selection first, so a drag always moves
  // exactly the highlighted tiles.
  const startDrag = useCallback((pageId: string) => {
    const ids = isSelected(pageId) && selectedIds.length ? selectedIds : [pageId];
    if (!isSelected(pageId)) selectOnly(pageId);
    draggedRef.current = { ids, set: new Set(ids) };
    dropTargetRef.current = null;
    setDraggedPageIds(ids);
    setDropTarget(null);
    window.document.body.classList.add("is-page-dragging");
  }, [isSelected, selectedIds, selectOnly]);

  const updateDrag = useCallback((clientX: number, clientY: number) => {
    const dragged = draggedRef.current;
    if (!dragged) return;
    if (clientY < 70) window.scrollBy({ top: -18 });
    if (clientY > window.innerHeight - 48) window.scrollBy({ top: 18 });

    const targetElement = window.document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-page-id]");
    const targetId = targetElement?.dataset.pageId;
    if (!targetElement || !targetId || dragged.set.has(targetId)) {
      dropTargetRef.current = null;
      setDropTarget(null);
      return;
    }
    const rect = targetElement.getBoundingClientRect();
    const edgeSize = Math.min(80, rect.width * .3);
    let position: DropPosition;
    if (clientX <= rect.left + edgeSize) position = "left";
    else if (clientX >= rect.right - edgeSize) position = "right";
    else position = clientY < rect.top + rect.height / 2 ? "before" : "after";

    // A side drop must leave at most four pages in the target row: the row's members
    // that are not being moved plus every dragged tile.
    const targetRow = document.pageRows.find((row) => row.includes(targetId));
    const staying = targetRow?.filter((id) => !dragged.set.has(id)).length ?? 4;
    if ((position === "left" || position === "right") && staying + dragged.ids.length > 4) {
      dropTargetRef.current = null;
      setDropTarget(null);
      return;
    }
    const next = { pageId: targetId, position };
    dropTargetRef.current = next;
    setDropTarget(next);
  }, [document.pageRows]);

  const finishDrag = useCallback(() => {
    const dragged = draggedRef.current;
    const target = dropTargetRef.current;
    if (dragged && target) movePages(dragged.ids, target.pageId, target.position);
    draggedRef.current = null;
    dropTargetRef.current = null;
    setDraggedPageIds([]);
    setDropTarget(null);
    window.document.body.classList.remove("is-page-dragging");
  }, [movePages]);

  const cancelDrag = useCallback(() => {
    draggedRef.current = null;
    dropTargetRef.current = null;
    setDraggedPageIds([]);
    setDropTarget(null);
    window.document.body.classList.remove("is-page-dragging");
  }, []);

  const moveByKeyboard = (pageId: string, delta: -1 | 1) => {
    const index = document.pageOrder.indexOf(pageId);
    const targetId = document.pageOrder[index + delta];
    if (targetId) movePage(pageId, targetId, delta < 0 ? "before" : "after");
  };

  const rows = document.pageRows.length ? document.pageRows : document.pageOrder.map((pageId) => [pageId]);
  const rightRailOffsets = new Map<string, number>();
  rows.forEach((row) => {
    let offset = 0;
    row.forEach((pageId) => {
      rightRailOffsets.set(pageId, offset);
      const width = rightRailWidth(document.pages[pageId]);
      if (width) offset += width + 8;
    });
  });

  return (
    <main
      className={`workspace ${agentTurn ? "workspace--agent-locked" : ""}`}
      // A plain left click anywhere but a tile handle (typing into a tile, resizing,
      // clicking empty margin) drops the multi-selection, like a file manager.
      onPointerDownCapture={(event) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey) return;
        if (event.target instanceof Element && event.target.closest(".page-handle")) return;
        clearSelection();
      }}
    >
      <div className="page-stack">
        {rows.map((row, rowIndex) => {
          const rowKey = row.join(":");
          const verticalDropPosition = dropTarget && row.includes(dropTarget.pageId) && (dropTarget.position === "before" || dropTarget.position === "after")
            ? dropTarget.position
            : null;
          const storedHeight = Math.max(0, ...row.map((pageId) => {
            const page = document.pages[pageId];
            return page.layoutHeight ?? (page.type === "drawing" ? page.drawing?.height ?? 0 : 0);
          }));
          const fractions = rowWidthFractions(row, document.pages);
          const boundaries = fractions.slice(0, -1).map((_, index) => fractions.slice(0, index + 1).reduce((total, fraction) => total + fraction, 0));
          const bottomEdgeSelected = selectedEdge?.kind === "row" && selectedEdge.index === rowIndex + 1;
          const topEdgeSelected = rowIndex === 0 && selectedEdge?.kind === "row" && selectedEdge.index === 0;
          // Column-edge positions 0..row.length: the row's left edge, each boundary
          // between grouped tiles, and the row's right edge.
          const columnEdgeSelected = selectedEdge?.kind === "column" && selectedEdge.rowIndex === rowIndex
            ? [0, ...boundaries, 1][selectedEdge.index]
            : undefined;
          return (
          <div key={row.join(":")} className="page-sequence-item">
            {rowIndex > 0 && <div className="page-boundary" />}
            <div
              className={`page-row ${row.length > 1 ? "page-row--multi" : ""} ${verticalDropPosition ? `drop-${verticalDropPosition}` : ""} ${resizingRow === rowKey ? "is-resizing" : ""} ${columnResize?.rowKey === rowKey ? "is-column-resizing" : ""}`}
              data-row-size={row.length}
              data-row-index={rowIndex}
              style={{
                width: `min(${document.settings.pageWidth}px, calc(100vw - 180px))`,
                minHeight: storedHeight || undefined,
                // Constant row width; descendant handles/rails position from the row's edges.
                "--inktile-row-width": `min(${document.settings.pageWidth}px, calc(100vw - 180px))`
              } as CSSProperties}
            >
              {row.map((pageId, columnIndex) => (
                <div key={pageId} className="page-row__cell" style={{ flex: `${fractions[columnIndex]} ${fractions[columnIndex]} 0` }}>
                  <PageView
                    page={document.pages[pageId]}
                    index={document.pageOrder.indexOf(pageId)}
                    columnIndex={columnIndex}
                    rowSize={row.length}
                    widthBefore={boundaries[columnIndex - 1] ?? 0}
                    rightRailOffset={rightRailOffsets.get(pageId) ?? 0}
                    dragged={draggedPageIds.includes(pageId)}
                    dropPosition={dropTarget?.pageId === pageId && (dropTarget.position === "left" || dropTarget.position === "right") ? dropTarget.position : null}
                    onDragStart={startDrag}
                    onDragMove={updateDrag}
                    onDragEnd={finishDrag}
                    onDragCancel={cancelDrag}
                    onMoveBy={(delta) => moveByKeyboard(pageId, delta)}
                  />
                </div>
              ))}
              {row.length > 1 && boundaries.map((boundary, boundaryIndex) => (
                <div
                  key={`column-resize-${row[boundaryIndex]}`}
                  className={`page-column-resize-handle ${columnResize?.rowKey === rowKey && columnResize.index === boundaryIndex ? "is-active" : ""}`}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize the boundary between tiles ${boundaryIndex + 1} and ${boundaryIndex + 2} of row ${rowIndex + 1}; click to select this edge as an insertion point`}
                  data-boundary-index={boundaryIndex}
                  style={{ left: `${boundary * 100}%` }}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    const rowElement = event.currentTarget.closest<HTMLElement>(".page-row");
                    if (!rowElement) return;
                    const cells = Array.from(rowElement.querySelectorAll<HTMLElement>(".page-row__cell"));
                    if (cells.length !== row.length) return;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    const rect = rowElement.getBoundingClientRect();
                    const rowWidth = rowElement.offsetWidth;
                    const startFractions = rowWidthFractions(row, document.pages);
                    columnResizeRef.current = {
                      pageIds: [...row],
                      rowIndex,
                      leftIndex: boundaryIndex,
                      cells,
                      rowWidth,
                      scale: Math.max(.1, rect.width / rowWidth),
                      startX: event.clientX,
                      startFractions,
                      minFraction: Math.min(.5, Math.max(120, rowWidth * .12) / rowWidth),
                      lastFractions: startFractions,
                      handleElement: event.currentTarget as HTMLElement,
                      moved: false
                    };
                    setColumnResize({ rowKey, index: boundaryIndex });
                  }}
                  onPointerMove={(event) => {
                    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                    const resize = columnResizeRef.current;
                    if (!resize) return;
                    // The gesture only becomes a resize once the pointer really travels;
                    // checkpointing here (not at pointer-down) keeps a plain edge click
                    // from polluting the undo history.
                    if (!resize.moved) {
                      if (Math.abs(event.clientX - resize.startX) <= 3) return;
                      resize.moved = true;
                      checkpoint();
                    }
                    resizeColumn(event.clientX);
                  }}
                  onPointerUp={(event) => {
                    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                    const resize = columnResizeRef.current;
                    if (resize?.moved) resizeColumn(event.clientX, true);
                    // A stationary press-and-release selects this vertical boundary as
                    // the insertion point for paste and the edge menu.
                    else if (resize) selectEdge({ kind: "column", rowIndex: resize.rowIndex, index: resize.leftIndex + 1 });
                    event.currentTarget.releasePointerCapture(event.pointerId);
                    columnResizeRef.current = null;
                    setColumnResize(null);
                  }}
                  onPointerCancel={() => {
                    const resize = columnResizeRef.current;
                    if (resize?.moved) setRowWidthFractions(resize.pageIds, resize.lastFractions);
                    columnResizeRef.current = null;
                    setColumnResize(null);
                  }}
                ><span /></div>
              ))}
              <div
                className="page-row-resize-handle"
                role="separator"
                aria-orientation="horizontal"
                aria-label={`Resize row ${rowIndex + 1}; click to select this edge as an insertion point`}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  const rowElement = event.currentTarget.closest<HTMLElement>(".page-row");
                  if (!rowElement) return;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  const rect = rowElement.getBoundingClientRect();
                  rowResizeRef.current = {
                    pageIds: [...row],
                    rowElement,
                    rowIndex,
                    startY: event.clientY,
                    startHeight: rowElement.offsetHeight,
                    minHeight: minimumRowHeight(rowElement),
                    scale: Math.max(.1, rect.width / rowElement.offsetWidth),
                    lastHeight: rowElement.offsetHeight,
                    moved: false
                  };
                  setResizingRow(rowKey);
                }}
                onPointerMove={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                  const resize = rowResizeRef.current;
                  if (!resize) return;
                  // The gesture only becomes a resize once the pointer really travels;
                  // checkpointing here (not at pointer-down) keeps a plain edge click
                  // from polluting the undo history.
                  if (!resize.moved) {
                    if (Math.abs(event.clientY - resize.startY) <= 3) return;
                    resize.moved = true;
                    checkpoint();
                  }
                  resizeRow(event.clientY);
                }}
                onPointerUp={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                  const resize = rowResizeRef.current;
                  if (resize?.moved) resizeRow(event.clientY, true);
                  // A stationary press-and-release selects this row's bottom edge as
                  // the insertion point for paste and the edge menu.
                  else if (resize) selectEdge({ kind: "row", index: resize.rowIndex + 1 });
                  event.currentTarget.releasePointerCapture(event.pointerId);
                  rowResizeRef.current = null;
                  setResizingRow(null);
                }}
                onPointerCancel={() => {
                  const resize = rowResizeRef.current;
                  if (resize?.moved) setPageRowHeight(resize.pageIds, resize.lastHeight);
                  rowResizeRef.current = null;
                  setResizingRow(null);
                }}
              ><span /></div>
              {rowIndex === 0 && (
                <div
                  className="page-row-top-edge"
                  role="button"
                  tabIndex={-1}
                  aria-label="Select the top edge of the document as an insertion point"
                  onClick={() => selectEdge({ kind: "row", index: 0 })}
                ><span /></div>
              )}
              <div
                className="page-row-side-edge page-row-side-edge--left"
                role="button"
                tabIndex={-1}
                aria-label={`Select the left edge of row ${rowIndex + 1} as an insertion point`}
                data-column-index={0}
                onClick={() => selectEdge({ kind: "column", rowIndex, index: 0 })}
              ><span /></div>
              <div
                className="page-row-side-edge page-row-side-edge--right"
                role="button"
                tabIndex={-1}
                aria-label={`Select the right edge of row ${rowIndex + 1} as an insertion point`}
                data-column-index={row.length}
                onClick={() => selectEdge({ kind: "column", rowIndex, index: row.length })}
              ><span /></div>
              {bottomEdgeSelected && <div className="page-edge-selection" />}
              {topEdgeSelected && <div className="page-edge-selection page-edge-selection--top" />}
              {columnEdgeSelected !== undefined && (
                <div className="page-edge-selection page-edge-selection--column" style={{ left: `${columnEdgeSelected * 100}%` }} />
              )}
            </div>
          </div>
          );
        })}

        <PageInsertControl afterPageId={document.pageOrder.at(-1)} />
      </div>
    </main>
  );
}
