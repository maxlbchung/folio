import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDocument } from "../document/DocumentContext";
import { useTileSelection, type EdgeSelection } from "./TileSelectionContext";
import type { ImageBlock, InktileDocument, InktilePage, VideoBlock, AudioBlock } from "../document/types";
import { CopyIcon, DuplicateIcon, FlipIcon, PasteIcon, PlusIcon, RedoIcon, TrashIcon, UndoIcon } from "./icons";

interface EditorContextMenuProps {
  onStatus: (message: string) => void;
}

/** Where the menu was summoned and, when a tile or an edge was hit, which one. */
interface EditorMenuState {
  x: number;
  y: number;
  pageId: string | null;
  /** Insertion point when a horizontal or vertical edge was hit. */
  edge: EdgeSelection | null;
}

/** Probed media metadata, filled in asynchronously once a media tile's asset loads. */
interface MediaInfo {
  width?: number;
  height?: number;
  duration?: number;
  fps?: number;
}

type StatRow = { label: string; value: string };
type MediaBlock = ImageBlock | VideoBlock | AudioBlock;

/** Keep the menu this many pixels clear of the viewport edges when it would overflow. */
const MENU_MARGIN = 8;

const tileTypeLabel = (page: InktilePage): string => {
  if (page.type === "drawing") return "Drawing";
  const first = page.front.blocks[0];
  if (first?.type === "variants") return "Versions";
  if (first?.type === "image" || first?.type === "video" || first?.type === "audio") return "Media";
  return "Text";
};

const mediaBlockOf = (page: InktilePage): MediaBlock | null => {
  if (page.type === "drawing") return null;
  const first = page.front.blocks[0];
  if (first && (first.type === "image" || first.type === "video" || first.type === "audio")) return first;
  return null;
};

const stripHtml = (html: string): string => {
  const holder = window.document.createElement("div");
  holder.innerHTML = html;
  return holder.textContent ?? "";
};

const countWords = (text: string): number => {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
};

/** Sums a measure over the tile's front text (plain text plus the active version variant). */
const measureText = (page: InktilePage, measure: (text: string) => number): number => {
  let total = 0;
  for (const block of page.front.blocks) {
    if (block.type === "text") total += measure(stripHtml(block.html));
    else if (block.type === "variants") total += measure(stripHtml(block.variants[block.activeVariant]?.html ?? ""));
  }
  return total;
};

const formatBytes = (bytes: number): string => {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exp = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exp;
  return `${exp === 0 || value >= 100 ? Math.round(value) : Number(value.toFixed(1))} ${units[exp]}`;
};

const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const minutes = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${minutes}:${String(s).padStart(2, "0")}`;
};

// Snap a measured rate to the nearest broadcast/standard value so tiny probe jitter reads cleanly.
const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120];
const formatFps = (fps: number): string => {
  const nearest = COMMON_FPS.reduce((best, candidate) => (Math.abs(candidate - fps) < Math.abs(best - fps) ? candidate : best), fps);
  const value = Math.abs(nearest - fps) <= 0.6 ? nearest : fps;
  return `${Number.isInteger(value) ? value : value.toFixed(2)} fps`;
};

const loadImageInfo = (url: string): Promise<MediaInfo> => new Promise((resolve) => {
  const image = new Image();
  image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
  image.onerror = () => resolve({});
  image.src = url;
});

const loadAudioInfo = (url: string): Promise<MediaInfo> => new Promise((resolve) => {
  const audio = window.document.createElement("audio");
  audio.preload = "metadata";
  audio.onloadedmetadata = () => resolve({ duration: audio.duration });
  audio.onerror = () => resolve({});
  audio.src = url;
});

type FrameMeta = { mediaTime: number; presentedFrames: number };
type RvfcVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: FrameMeta) => void) => number;
};

const loadVideoInfo = (url: string): Promise<MediaInfo> => new Promise((resolve) => {
  const video = window.document.createElement("video") as RvfcVideo;
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  // Off-screen but attached so frames actually present for the frame-rate probe.
  video.style.cssText = "position:fixed;left:-10px;top:-10px;width:1px;height:1px;opacity:0;pointer-events:none;";
  const info: MediaInfo = {};
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    try { video.pause(); } catch { /* ignore */ }
    video.removeAttribute("src");
    video.load();
    video.remove();
    resolve(info);
  };
  video.onloadedmetadata = () => {
    info.width = video.videoWidth;
    info.height = video.videoHeight;
    info.duration = video.duration;
    if (typeof video.requestVideoFrameCallback !== "function") { finish(); return; }
    let firstMeta: FrameMeta | null = null;
    const onFrame = (_now: number, meta: FrameMeta) => {
      if (settled) return;
      if (!firstMeta) {
        firstMeta = meta;
      } else {
        const frames = meta.presentedFrames - firstMeta.presentedFrames;
        const elapsed = meta.mediaTime - firstMeta.mediaTime;
        if (elapsed > 0 && frames > 0) info.fps = frames / elapsed;
        if (frames >= 4) { finish(); return; }
      }
      video.requestVideoFrameCallback?.(onFrame);
    };
    video.requestVideoFrameCallback?.(onFrame);
    void video.play().catch(() => finish());
  };
  video.onerror = () => finish();
  window.setTimeout(finish, 1500);
  window.document.body.appendChild(video);
  video.src = url;
});

const loadMediaInfo = (kind: MediaBlock["type"], url: string): Promise<MediaInfo> =>
  kind === "image" ? loadImageInfo(url) : kind === "video" ? loadVideoInfo(url) : loadAudioInfo(url);

/** The detail rows shown for a tile, chosen by its type; media rows fill in as `mediaInfo` loads. */
const tileStats = (page: InktilePage, document: InktileDocument, mediaInfo: Record<string, MediaInfo>): StatRow[] => {
  if (page.type === "drawing") {
    return [{ label: "Strokes", value: (page.drawing?.strokes.length ?? 0).toLocaleString() }];
  }
  const media = mediaBlockOf(page);
  if (media) {
    const info = mediaInfo[media.assetId];
    const size = formatBytes(document.assets[media.assetId]?.byteLength ?? 0);
    const dimensions = info === undefined ? "…" : info.width ? `${info.width} × ${info.height} px` : "—";
    const duration = info === undefined ? "…" : info.duration != null ? formatDuration(info.duration) : "—";
    if (media.type === "image") {
      return [{ label: "Dimensions", value: dimensions }, { label: "File size", value: size }];
    }
    if (media.type === "video") {
      return [
        { label: "Dimensions", value: dimensions },
        { label: "Frame rate", value: info === undefined ? "…" : info.fps ? formatFps(info.fps) : "—" },
        { label: "Duration", value: duration },
        { label: "File size", value: size }
      ];
    }
    return [{ label: "Duration", value: duration }, { label: "File size", value: size }];
  }
  return [
    { label: "Characters", value: measureText(page, (text) => text.length).toLocaleString() },
    { label: "Words", value: measureText(page, countWords).toLocaleString() }
  ];
};

interface EditorMenuViewProps {
  state: EditorMenuState;
  page: InktilePage | null;
  stats: StatRow[];
  pageIndex: number;
  pageCount: number;
  selectionCount: number;
  clipboardCount: number;
  /** Whether the hit edge can take one more tile (false when its row is full). */
  edgeCanAdd: boolean;
  /** Whether the clipboard fits at the hit edge (row capacity for vertical edges). */
  edgeCanPaste: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onClose: () => void;
  onAddAfter: () => void;
  onAddAtEdge: () => void;
  onDuplicate: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onToggleSide: () => void;
  onDelete: () => void;
  onNewTile: () => void;
  onUndo: () => void;
  onRedo: () => void;
}

function EditorMenuView({
  state, page, stats, pageIndex, pageCount, selectionCount, clipboardCount, edgeCanAdd, edgeCanPaste, canUndo, canRedo, onClose,
  onAddAfter, onAddAtEdge, onDuplicate, onCopy, onPaste, onToggleSide, onDelete, onNewTile, onUndo, onRedo
}: EditorMenuViewProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: state.x, top: state.y });

  // Clamp to the viewport once the menu has a measured size, so it never spills off-screen.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const maxLeft = window.innerWidth - menu.offsetWidth - MENU_MARGIN;
    const maxTop = window.innerHeight - menu.offsetHeight - MENU_MARGIN;
    setPos({
      left: Math.max(MENU_MARGIN, Math.min(state.x, maxLeft)),
      top: Math.max(MENU_MARGIN, Math.min(state.y, maxTop))
    });
  }, [state.x, state.y, state.pageId, stats.length]);

  // Dismiss on outside pointer, Escape, scroll, or resize.
  useEffect(() => {
    menuRef.current?.focus();
    const handlePointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", handlePointer, true);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", handlePointer, true);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  // Run an action, then always dismiss the menu.
  const run = (action: () => void) => () => { onClose(); action(); };

  return createPortal(
    <div
      ref={menuRef}
      className="home-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {state.edge !== null ? (
        <>
          <button className="home-menu__item" role="menuitem" onClick={run(onAddAtEdge)} disabled={!edgeCanAdd}>
            <PlusIcon size={15} />Add tile here
          </button>
          <button className="home-menu__item" role="menuitem" onClick={run(onPaste)} disabled={!edgeCanPaste}>
            <PasteIcon size={15} />Paste here
          </button>
        </>
      ) : page && selectionCount > 1 ? (
        <>
          <div className="home-menu__details">
            <p className="home-menu__eyebrow">Selection</p>
            <h3 className="home-menu__title">{selectionCount} tiles selected</h3>
          </div>
          <button className="home-menu__item" role="menuitem" onClick={run(onDuplicate)}>
            <DuplicateIcon size={15} />Duplicate {selectionCount} tiles
          </button>
          <button className="home-menu__item" role="menuitem" onClick={run(onCopy)}>
            <CopyIcon size={15} />Copy {selectionCount} tiles
          </button>
          <button className="home-menu__item" role="menuitem" onClick={run(onPaste)} disabled={!clipboardCount}>
            <PasteIcon size={15} />Paste below selection
          </button>
          <button className="home-menu__item" role="menuitem" onClick={run(onToggleSide)}>
            <FlipIcon size={15} />Flip {selectionCount} tiles
          </button>
          <div className="home-menu__sep" role="separator" />
          <button className="home-menu__item home-menu__item--danger" role="menuitem" onClick={run(onDelete)}>
            <TrashIcon size={15} />Delete {selectionCount} tiles
          </button>
        </>
      ) : page ? (
        <>
          <div className="home-menu__details">
            <p className="home-menu__eyebrow">Tile</p>
            <h3 className="home-menu__title">{tileTypeLabel(page)} tile</h3>
            <dl className="home-menu__meta">
              <dt>Position</dt>
              <dd>{pageIndex + 1} of {pageCount}</dd>
              {stats.map((row) => (
                <Fragment key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </Fragment>
              ))}
            </dl>
          </div>
          <button className="home-menu__item" role="menuitem" onClick={run(onAddAfter)}>
            <PlusIcon size={15} />Add tile below
          </button>
          <button className="home-menu__item" role="menuitem" onClick={run(onDuplicate)}>
            <DuplicateIcon size={15} />Duplicate tile
          </button>
          <button className="home-menu__item" role="menuitem" onClick={run(onCopy)}>
            <CopyIcon size={15} />Copy tile
          </button>
          <button className="home-menu__item" role="menuitem" onClick={run(onPaste)} disabled={!clipboardCount}>
            <PasteIcon size={15} />Paste below
          </button>
          <button className="home-menu__item" role="menuitem" onClick={run(onToggleSide)}>
            <FlipIcon size={15} />{page.activeSide === "front" ? "Flip to notes" : "Show front"}
          </button>
          <div className="home-menu__sep" role="separator" />
          <button className="home-menu__item home-menu__item--danger" role="menuitem" onClick={run(onDelete)}>
            <TrashIcon size={15} />Delete tile
          </button>
        </>
      ) : (
        <>
          <button className="home-menu__item" role="menuitem" onClick={run(onNewTile)}>
            <PlusIcon size={15} />New tile
          </button>
          <button className="home-menu__item" role="menuitem" onClick={run(onPaste)} disabled={!clipboardCount}>
            <PasteIcon size={15} />Paste tiles
          </button>
          <div className="home-menu__sep" role="separator" />
          <button className="home-menu__item" role="menuitem" onClick={run(onUndo)} disabled={!canUndo}>
            <UndoIcon size={15} />Undo
          </button>
          <button className="home-menu__item" role="menuitem" onClick={run(onRedo)} disabled={!canRedo}>
            <RedoIcon size={15} />Redo
          </button>
        </>
      )}
    </div>,
    window.document.body
  );
}

export function EditorContextMenu({ onStatus }: EditorContextMenuProps) {
  const { document, assets, addPage, addPageAt, undo, redo, canUndo, canRedo } = useDocument();
  const {
    selectedIds, isSelected, selectOnly, selectEdge, clipboardCount,
    copySelected, pasteClipboard, duplicateSelected, deleteSelected, flipSelected
  } = useTileSelection();
  const [menu, setMenu] = useState<EditorMenuState | null>(null);
  const [mediaInfo, setMediaInfo] = useState<Record<string, MediaInfo>>({});
  const requestedRef = useRef<Set<string>>(new Set());

  // Listen at the document level so the whole editor — canvas, margins, toolbar — opens
  // our menu instead of the native one, except over editable text where copy/paste matters.
  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      // Right-click on our own menu: suppress the native menu, keep ours open.
      if (target.closest(".home-menu")) {
        event.preventDefault();
        return;
      }
      // Leave the native menu for editable fields (rich text, inputs) so copy/paste works.
      if (target.closest("input, textarea, select, [contenteditable='true'], .text-block, .variant-editor")) return;
      event.preventDefault();
      // Edge strips are insertion points: select the edge and open the edge menu (add
      // here / paste here) instead of a tile or background menu. Three strips exist —
      // the top-of-document strip, the vertical boundary between grouped tiles, and
      // each row's bottom resize strip.
      const openEdgeMenu = (edge: EdgeSelection) => {
        selectEdge(edge);
        setMenu({ x: event.clientX, y: event.clientY, pageId: null, edge });
      };
      const rowIndexOf = (element: HTMLElement | null) =>
        Number(element?.closest<HTMLElement>("[data-row-index]")?.dataset.rowIndex ?? NaN);
      if (target.closest(".page-row-top-edge")) {
        openEdgeMenu({ kind: "row", index: 0 });
        return;
      }
      const sideStrip = target.closest<HTMLElement>(".page-row-side-edge");
      const sideRowIndex = rowIndexOf(sideStrip);
      const sideColumnIndex = Number(sideStrip?.dataset.columnIndex ?? NaN);
      if (sideStrip && Number.isInteger(sideRowIndex) && Number.isInteger(sideColumnIndex)) {
        openEdgeMenu({ kind: "column", rowIndex: sideRowIndex, index: sideColumnIndex });
        return;
      }
      const columnStrip = target.closest<HTMLElement>(".page-column-resize-handle");
      const columnRowIndex = rowIndexOf(columnStrip);
      const boundaryIndex = Number(columnStrip?.dataset.boundaryIndex ?? NaN);
      if (columnStrip && Number.isInteger(columnRowIndex) && Number.isInteger(boundaryIndex)) {
        openEdgeMenu({ kind: "column", rowIndex: columnRowIndex, index: boundaryIndex + 1 });
        return;
      }
      const rowStrip = target.closest<HTMLElement>(".page-row-resize-handle");
      const stripRowIndex = rowIndexOf(rowStrip);
      if (rowStrip && Number.isInteger(stripRowIndex)) {
        openEdgeMenu({ kind: "row", index: stripRowIndex + 1 });
        return;
      }
      const pageEl = target.closest<HTMLElement>("[data-page-id]");
      const pageId = pageEl?.dataset.pageId ?? null;
      // Right-clicking outside the current selection retargets it to the hit tile, so
      // the menu always acts on the highlighted tiles.
      if (pageId && !isSelected(pageId)) selectOnly(pageId);
      setMenu({ x: event.clientX, y: event.clientY, pageId, edge: null });
    };
    window.document.addEventListener("contextmenu", handleContextMenu);
    return () => window.document.removeEventListener("contextmenu", handleContextMenu);
  }, [isSelected, selectOnly, selectEdge]);

  const pageId = menu?.pageId ?? null;
  const page = pageId ? document.pages[pageId] ?? null : null;
  const media = page ? mediaBlockOf(page) : null;
  const mediaAssetId = media?.assetId ?? null;
  const mediaKind = media?.type ?? null;

  // Probe media dimensions/duration/frame-rate once per asset, cached across reopens.
  useEffect(() => {
    if (!mediaAssetId || !mediaKind) return;
    if (requestedRef.current.has(mediaAssetId)) return;
    const asset = assets[mediaAssetId];
    if (!asset) return;
    requestedRef.current.add(mediaAssetId);
    let cancelled = false;
    void loadMediaInfo(mediaKind, asset.url)
      .then((data) => { if (!cancelled) setMediaInfo((current) => ({ ...current, [mediaAssetId]: data })); })
      .catch(() => { requestedRef.current.delete(mediaAssetId); });
    return () => { cancelled = true; };
  }, [mediaAssetId, mediaKind, assets]);

  if (!menu) return null;

  const pageIndex = pageId ? document.pageOrder.indexOf(pageId) : -1;
  const close = () => setMenu(null);
  // Vertical edges insert into an existing row, so their menu items respect the
  // four-per-row maximum; horizontal edges always take new rows.
  const edgeRow = menu.edge?.kind === "column" ? document.pageRows[menu.edge.rowIndex] : null;
  const edgeCanAdd = menu.edge?.kind !== "column" || Boolean(edgeRow && edgeRow.length < 4);
  const edgeCanPaste = clipboardCount > 0 && (menu.edge?.kind !== "column" || Boolean(edgeRow && edgeRow.length + clipboardCount <= 4));

  return (
    <EditorMenuView
      state={menu}
      page={page}
      stats={page ? tileStats(page, document, mediaInfo) : []}
      pageIndex={pageIndex}
      pageCount={document.pageOrder.length}
      selectionCount={selectedIds.length}
      clipboardCount={clipboardCount}
      edgeCanAdd={edgeCanAdd}
      edgeCanPaste={edgeCanPaste}
      canUndo={canUndo}
      canRedo={canRedo}
      onClose={close}
      onAddAfter={() => { if (pageId) { addPage(pageId, "standard"); onStatus("Tile added"); } }}
      onAddAtEdge={() => {
        const edge = menu.edge;
        if (!edge) return;
        // Insert exactly at the edge; the new tile becomes the selection.
        const newId = edge.kind === "column"
          ? addPageAt({ rowIndex: edge.rowIndex, columnIndex: edge.index }, "standard")
          : addPageAt({ rowIndex: edge.index }, "standard");
        if (!newId) { onStatus("A row holds at most four tiles"); return; }
        selectOnly(newId);
        onStatus("Tile added");
      }}
      onDuplicate={duplicateSelected}
      onCopy={copySelected}
      onPaste={pasteClipboard}
      onToggleSide={flipSelected}
      onDelete={deleteSelected}
      onNewTile={() => { addPage(undefined, "standard"); onStatus("Tile added"); }}
      onUndo={undo}
      onRedo={redo}
    />
  );
}
