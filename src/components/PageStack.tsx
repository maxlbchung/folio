import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { reportAgentFocus } from "../agent/animations";
import { useDocument, type InsertPosition } from "../document/DocumentContext";
import { useTileSelection } from "./TileSelectionContext";
import type { InktilePage } from "../document/types";
import { MIN_DRAWING_HEIGHT, MIN_MEDIA_HEIGHT, MIN_VERSIONS_HEIGHT, createMediaBlock } from "../document/factories";
import { detectMediaPageType, mimeForMediaFilename, type MediaPageType } from "../document/mediaTypes";
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
  const {
    document, movePage, movePages, setPageRowHeight, setRowWidthFractions, checkpoint, agentTurn,
    addAsset, addBlockPageAt, getDocumentSnapshot
  } = useDocument();
  const { selectedIds, selectedEdge, isSelected, selectOnly, selectEdge, clearSelection } = useTileSelection();
  // Pages present when the stack mounted: tiles created afterwards — user
  // inserts, paste, redo, or agent ops — carry a born class and fade in once.
  const initialPageIdsRef = useRef<Set<string> | null>(null);
  if (initialPageIdsRef.current === null) initialPageIdsRef.current = new Set(Object.keys(document.pages));
  const seenPageIdsRef = useRef<Set<string>>(new Set(initialPageIdsRef.current));
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
      // Only the FRONT face sizes the card (the notes back overlays it and scrolls
      // internally), so the minimum is the front's content plus its own padding.
      const faces = Array.from(card.querySelectorAll<HTMLElement>(".page-face--front"));
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

  // ---- OS file drops: dragging media over the workspace previews an insertion edge at the
  // cursor (the same drop-before/after/left/right indicators a tile drag paints) and dropping
  // creates a media tile there. Browser drags carry Files; the Tauri shell intercepts OS drops,
  // so there the native drag-drop stream drives the same hit-test with window coordinates.
  const [fileDrop, setFileDrop] = useState<{ pageId: string; position: DropPosition } | null>(null);
  const fileDropRef = useRef<typeof fileDrop>(null);
  const [dropError, setDropError] = useState<string | null>(null);

  const setFileDropTarget = (target: { pageId: string; position: DropPosition } | null) => {
    const current = fileDropRef.current;
    if (target?.pageId === current?.pageId && target?.position === current?.position) return;
    fileDropRef.current = target;
    setFileDrop(target);
  };

  /** Where a file at (x, y) would land: over a tile, the same edge zones as a tile drag
   * (outer thirds join the row side by side, the middle lands above/below); in gaps and
   * margins, the nearest row boundary. Null only when the document has no tiles yet. */
  const fileDropTargetAt = (clientX: number, clientY: number): { pageId: string; position: DropPosition } | null => {
    const wrapper = window.document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-page-id]");
    if (wrapper?.dataset.pageId) {
      const pageId = wrapper.dataset.pageId;
      const rect = wrapper.getBoundingClientRect();
      const edgeSize = Math.min(80, rect.width * .3);
      const vertical: DropPosition = clientY < rect.top + rect.height / 2 ? "before" : "after";
      let position: DropPosition = clientX <= rect.left + edgeSize ? "left" : clientX >= rect.right - edgeSize ? "right" : vertical;
      // A side landing must fit in the target row (max four tiles); fall back to above/below.
      const row = getDocumentSnapshot().pageRows.find((candidate) => candidate.includes(pageId));
      if ((position === "left" || position === "right") && (row?.length ?? 4) >= 4) position = vertical;
      return { pageId, position };
    }
    let best: { pageId: string; position: DropPosition } | null = null;
    let bestDistance = Infinity;
    window.document.querySelectorAll<HTMLElement>(".page-row").forEach((rowElement) => {
      const pageId = rowElement.querySelector<HTMLElement>("[data-page-id]")?.dataset.pageId;
      if (!pageId) return;
      const rect = rowElement.getBoundingClientRect();
      const position: DropPosition = clientY < rect.top + rect.height / 2 ? "before" : "after";
      const distance = position === "before" ? Math.abs(clientY - rect.top) : Math.abs(clientY - rect.bottom);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { pageId, position };
      }
    });
    return best;
  };

  const insertPositionFor = (target: { pageId: string; position: DropPosition } | null): InsertPosition => {
    const rows = getDocumentSnapshot().pageRows;
    if (!target) return { rowIndex: rows.length };
    const rowIndex = Math.max(0, rows.findIndex((row) => row.includes(target.pageId)));
    const columnIndex = rows[rowIndex]?.indexOf(target.pageId) ?? 0;
    if (target.position === "before") return { rowIndex };
    if (target.position === "after") return { rowIndex: rowIndex + 1 };
    return { rowIndex, columnIndex: target.position === "left" ? columnIndex : columnIndex + 1 };
  };

  const insertDroppedFiles = async (files: File[], target: { pageId: string; position: DropPosition } | null) => {
    if (agentTurn) return;
    const supported = files
      .map((file) => ({ file, type: detectMediaPageType(file.type, file.name) }))
      .filter((entry): entry is { file: File; type: MediaPageType } => entry.type !== null);
    if (!supported.length) {
      setDropError("Only media can land on the page. Drop an image, video, or audio file.");
      return;
    }
    let position = insertPositionFor(target);
    for (const { file, type } of supported) {
      try {
        const assetId = await addAsset(file);
        const block = createMediaBlock(type, assetId, file.name);
        // A side landing can be refused if the row filled up meanwhile; retry as a new row below.
        if (!addBlockPageAt(block, position)) {
          position = { rowIndex: position.rowIndex + 1 };
          addBlockPageAt(block, position);
        }
        // Each further file of the same drop lands after the previous one: along the row
        // while it has room, otherwise (and for row landings) as the next full-width row.
        if (position.columnIndex !== undefined) {
          const row = getDocumentSnapshot().pageRows[position.rowIndex];
          position = row && row.length < 4
            ? { rowIndex: position.rowIndex, columnIndex: position.columnIndex + 1 }
            : { rowIndex: position.rowIndex + 1 };
        } else {
          position = { rowIndex: position.rowIndex + 1 };
        }
      } catch (error) {
        setDropError(error instanceof Error ? error.message : "The media file could not be added.");
        return;
      }
    }
  };

  // Event handlers close over fresh state each render; the mount-once listeners below call
  // through this ref so they always see the current document and agent-lock state.
  const dropApiRef = useRef({ fileDropTargetAt, insertDroppedFiles, agentTurn });
  useEffect(() => { dropApiRef.current = { fileDropTargetAt, insertDroppedFiles, agentTurn }; });

  // During a turn, a freshly inserted tile is the agent's focus the moment it
  // mounts (media/versions pages have no reveal task to report it themselves).
  useEffect(() => {
    const seen = seenPageIdsRef.current;
    const fresh = Object.keys(document.pages).filter((pageId) => !seen.has(pageId));
    fresh.forEach((pageId) => seen.add(pageId));
    if (!agentTurn || !fresh.length) return;
    const cell = window.document.querySelector<HTMLElement>(`.page-row__cell[data-page-id="${fresh[0]}"]`);
    if (cell) reportAgentFocus(cell);
  }, [document.pages, agentTurn]);

  useEffect(() => {
    if (window.__TAURI_INTERNALS__) return;
    let depth = 0;
    const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const clear = () => setFileDropTarget(null);
    const onEnter = (event: DragEvent) => {
      if (carriesFiles(event)) depth += 1;
    };
    const onOver = (event: DragEvent) => {
      if (!carriesFiles(event) || dropApiRef.current.agentTurn) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = "copy";
      if (event.clientY < 70) window.scrollBy({ top: -18 });
      if (event.clientY > window.innerHeight - 48) window.scrollBy({ top: 18 });
      setFileDropTarget(dropApiRef.current.fileDropTargetAt(event.clientX, event.clientY));
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) clear();
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      depth = 0;
      const target = fileDropRef.current;
      clear();
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) void dropApiRef.current.insertDroppedFiles(files, target);
    };
    const onEnd = () => {
      depth = 0;
      clear();
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragend", onEnd);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", onEnd);
    };
  }, []);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const readNativeFiles = async (paths: string[]): Promise<File[]> => {
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const files: File[] = [];
      for (const path of paths) {
        const name = path.split(/[\\/]/).pop() || "file";
        try {
          const bytes = await readFile(path);
          files.push(new File([bytes], name, { type: mimeForMediaFilename(name) }));
        } catch {
          // Skip unreadable paths; the rest of the drop still lands.
        }
      }
      return files;
    };
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          if (dropApiRef.current.agentTurn) return;
          const x = event.payload.position.x / window.devicePixelRatio;
          const y = event.payload.position.y / window.devicePixelRatio;
          setFileDropTarget(dropApiRef.current.fileDropTargetAt(x, y));
        } else if (event.payload.type === "drop") {
          const target = fileDropRef.current;
          setFileDropTarget(null);
          const paths = event.payload.paths;
          if (paths.length) {
            void readNativeFiles(paths).then((files) => {
              if (files.length) return dropApiRef.current.insertDroppedFiles(files, target);
            });
          }
        } else {
          setFileDropTarget(null);
        }
      })
    ).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // One indicator pipeline for both drag kinds: a tile reorder and an OS file drag paint
  // the same insertion edges.
  const indicatorDrop = dropTarget ?? fileDrop;

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
          const verticalDropPosition = indicatorDrop && row.includes(indicatorDrop.pageId) && (indicatorDrop.position === "before" || indicatorDrop.position === "after")
            ? indicatorDrop.position
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
                <div
                  key={pageId}
                  data-page-id={pageId}
                  className={`page-row__cell ${initialPageIdsRef.current?.has(pageId) ? "" : "page-row__cell--born"}`}
                  style={{ flex: `${fractions[columnIndex]} ${fractions[columnIndex]} 0` }}
                >
                  <PageView
                    page={document.pages[pageId]}
                    index={document.pageOrder.indexOf(pageId)}
                    columnIndex={columnIndex}
                    rowSize={row.length}
                    widthBefore={boundaries[columnIndex - 1] ?? 0}
                    rightRailOffset={rightRailOffsets.get(pageId) ?? 0}
                    dragged={draggedPageIds.includes(pageId)}
                    dropPosition={indicatorDrop?.pageId === pageId && (indicatorDrop.position === "left" || indicatorDrop.position === "right") ? indicatorDrop.position : null}
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

      {dropError && (
        <div className="media-error" role="alertdialog" aria-modal="true" aria-labelledby="drop-error-title">
          <div className="media-error__panel">
            <strong id="drop-error-title">Unsupported file</strong>
            <p>{dropError}</p>
            <button autoFocus onClick={() => setDropError(null)}>Close</button>
          </div>
        </div>
      )}
    </main>
  );
}
