import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useDocument } from "../document/DocumentContext";
import type { InktilePage } from "../document/types";

/**
 * A selected insertion point. A "row" edge sits between rows: the next insert goes
 * before row `index` (0 = above the first row, rowCount = below the last). A "column"
 * edge sits between two grouped tiles: the insert goes into row `rowIndex` before
 * column `index`, subject to the four-per-row maximum.
 */
export type EdgeSelection =
  | { kind: "row"; index: number }
  | { kind: "column"; rowIndex: number; index: number };

interface TileSelectionValue {
  /** Selected tile ids in document order. */
  selectedIds: string[];
  selectedEdge: EdgeSelection | null;
  isSelected: (pageId: string) => boolean;
  toggleSelected: (pageId: string) => void;
  selectOnly: (pageId: string) => void;
  selectAll: () => void;
  selectEdge: (edge: EdgeSelection | null) => void;
  clearSelection: () => void;
  clipboardCount: number;
  copySelected: () => void;
  cutSelected: () => void;
  pasteClipboard: () => void;
  duplicateSelected: () => void;
  deleteSelected: () => void;
  flipSelected: () => void;
}

const TileSelectionContext = createContext<TileSelectionValue | null>(null);

const tileCountLabel = (count: number) => (count === 1 ? "Tile" : `${count} tiles`);

interface TileSelectionProviderProps {
  onStatus: (message: string) => void;
}

/**
 * Editor-only multi-tile selection plus the in-app tile clipboard, and the keyboard
 * shortcuts that act on them: Ctrl+A select all, Ctrl+C/X/V copy-cut-paste, Ctrl+D
 * duplicate, Delete/Backspace delete, F flip, Escape clear. Shortcuts never fire while
 * an editable field owns the key, so text editing keeps its native behavior.
 */
export function TileSelectionProvider({ onStatus, children }: PropsWithChildren<TileSelectionProviderProps>) {
  const { document, deletePages, duplicatePages, togglePagesSide, pastePages, pastePagesAt } = useDocument();
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  // A selected edge is an insertion point between rows or between grouped tiles; it
  // and the tile selection are mutually exclusive, so picking one clears the other.
  const [selectedEdge, setSelectedEdge] = useState<EdgeSelection | null>(null);
  // Clipboard entries are deep snapshots referencing this document's assets, so they
  // cannot cross documents; both stores reset when a different inktile opens.
  const clipboardRef = useRef<InktilePage[]>([]);
  const [clipboardCount, setClipboardCount] = useState(0);

  useEffect(() => {
    setSelected(new Set());
    setSelectedEdge(null);
    clipboardRef.current = [];
    setClipboardCount(0);
  }, [document.id]);

  // Drop ids whose pages no longer exist (deletion, cut, undo) so counts stay honest.
  useEffect(() => {
    setSelected((current) => {
      const alive = [...current].filter((id) => document.pages[id]);
      return alive.length === current.size ? current : new Set(alive);
    });
  }, [document.pages]);

  // An edge pointing past the current rows/columns (rows deleted or merged since it
  // was picked) is stale; keep the same object while it stays valid so React bails.
  useEffect(() => {
    setSelectedEdge((current) => {
      if (!current) return current;
      if (current.kind === "row") return current.index > document.pageRows.length ? null : current;
      const row = document.pageRows[current.rowIndex];
      return row && current.index <= row.length ? current : null;
    });
  }, [document.pageRows]);

  const selectedIds = useMemo(
    () => document.pageOrder.filter((id) => selected.has(id)),
    [document.pageOrder, selected]
  );

  const isSelected = useCallback((pageId: string) => selected.has(pageId), [selected]);
  const toggleSelected = useCallback((pageId: string) => {
    setSelectedEdge(null);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });
  }, []);
  const selectOnly = useCallback((pageId: string) => {
    setSelectedEdge(null);
    setSelected(new Set([pageId]));
  }, []);
  const selectAll = useCallback(() => {
    setSelectedEdge(null);
    setSelected(new Set(document.pageOrder));
  }, [document.pageOrder]);
  const selectEdge = useCallback((edge: EdgeSelection | null) => {
    setSelected(new Set());
    setSelectedEdge(edge);
  }, []);
  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setSelectedEdge(null);
  }, []);

  const snapshotSelection = () => {
    clipboardRef.current = selectedIds.map((id) => structuredClone(document.pages[id]));
    setClipboardCount(selectedIds.length);
  };

  const copySelected = () => {
    if (!selectedIds.length) return;
    snapshotSelection();
    onStatus(`${tileCountLabel(selectedIds.length)} copied`);
  };

  const cutSelected = () => {
    if (!selectedIds.length) return;
    snapshotSelection();
    deletePages(selectedIds);
    setSelected(new Set());
    onStatus(`${tileCountLabel(selectedIds.length)} cut`);
  };

  const pasteClipboard = () => {
    const clipboard = clipboardRef.current;
    if (!clipboard.length) return;
    // A selected edge wins as the paste destination; otherwise pasting lands after the
    // last selected tile, or at the document end.
    let pastedIds: string[];
    if (selectedEdge?.kind === "column") {
      const row = document.pageRows[selectedEdge.rowIndex];
      if (!row || row.length + clipboard.length > 4) {
        onStatus("A row holds at most four tiles");
        return;
      }
      pastedIds = pastePagesAt(clipboard, { rowIndex: selectedEdge.rowIndex, columnIndex: selectedEdge.index });
    } else if (selectedEdge) {
      pastedIds = pastePagesAt(clipboard, { rowIndex: selectedEdge.index });
    } else {
      pastedIds = pastePages(clipboard, selectedIds.at(-1) ?? document.pageOrder.at(-1));
    }
    if (!pastedIds.length) return;
    setSelectedEdge(null);
    setSelected(new Set(pastedIds));
    onStatus(`${tileCountLabel(pastedIds.length)} pasted`);
  };

  const duplicateSelected = () => {
    if (!selectedIds.length) return;
    const newIds = duplicatePages(selectedIds);
    if (!newIds.length) return;
    setSelected(new Set(newIds));
    onStatus(`${tileCountLabel(newIds.length)} duplicated`);
  };

  const deleteSelected = () => {
    if (!selectedIds.length) return;
    deletePages(selectedIds);
    setSelected(new Set());
    onStatus(`${tileCountLabel(selectedIds.length)} deleted`);
  };

  const flipSelected = () => {
    if (selectedIds.length) togglePagesSide(selectedIds);
  };

  // The listener is registered once; the ref always points at a handler closing over the
  // current render's state, so shortcuts never act on stale selection or document data.
  const keydownRef = useRef<(event: KeyboardEvent) => void>(() => {});
  keydownRef.current = (event: KeyboardEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const inEditable = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
    const command = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (command && key === "a") {
      // Inside editable text, Ctrl+A keeps its native select-all-text meaning.
      if (inEditable || !document.pageOrder.length) return;
      event.preventDefault();
      selectAll();
      return;
    }
    if (inEditable) return;
    if (command && key === "c" && selectedIds.length) { event.preventDefault(); copySelected(); return; }
    if (command && key === "x" && selectedIds.length) { event.preventDefault(); cutSelected(); return; }
    if (command && key === "v" && clipboardRef.current.length) { event.preventDefault(); pasteClipboard(); return; }
    if (command && key === "d" && selectedIds.length) { event.preventDefault(); duplicateSelected(); return; }
    if (command || event.altKey) return;
    if ((event.key === "Delete" || event.key === "Backspace") && selectedIds.length) {
      event.preventDefault();
      deleteSelected();
      return;
    }
    if (key === "f" && selectedIds.length) { event.preventDefault(); flipSelected(); return; }
    // Escape first dismisses an open context menu (its own listener); only a second
    // press with no menu up clears the tile or edge selection.
    if (event.key === "Escape" && (selectedIds.length || selectedEdge !== null) && !window.document.querySelector(".home-menu")) {
      clearSelection();
    }
  };

  useEffect(() => {
    const listener = (event: KeyboardEvent) => keydownRef.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const value = useMemo<TileSelectionValue>(() => ({
    selectedIds,
    selectedEdge,
    isSelected,
    toggleSelected,
    selectOnly,
    selectAll,
    selectEdge,
    clearSelection,
    clipboardCount,
    copySelected,
    cutSelected,
    pasteClipboard,
    duplicateSelected,
    deleteSelected,
    flipSelected
  }), [selectedIds, selectedEdge, isSelected, toggleSelected, selectOnly, selectAll, selectEdge, clearSelection, clipboardCount, document, deletePages, duplicatePages, togglePagesSide, pastePages, pastePagesAt, onStatus]);

  return <TileSelectionContext.Provider value={value}>{children}</TileSelectionContext.Provider>;
}

export function useTileSelection() {
  const context = useContext(TileSelectionContext);
  if (!context) throw new Error("useTileSelection must be used inside TileSelectionProvider");
  return context;
}
