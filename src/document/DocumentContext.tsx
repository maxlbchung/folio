import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState
} from "react";
import { clonePage, createBlockPage, createDocument, createPage, normalizeDocumentPages, uuid } from "./factories";
import type {
  AssetMetadata,
  Block,
  InktileDocument,
  InktilePage,
  PageSide,
  PageType,
  RuntimeAssetMap,
  VerticalAlignment
} from "./types";
import { extensionForMime, hashBlob } from "../utils/hash";

interface LoadedDocument {
  document: InktileDocument;
  assets: RuntimeAssetMap;
  path?: string | null;
}

/** An exact insertion spot: before row `rowIndex`, or — when `columnIndex` is given —
 * inside that row before column `columnIndex` (subject to the four-per-row maximum). */
export interface InsertPosition {
  rowIndex: number;
  columnIndex?: number;
}

export interface DocumentContextValue {
  document: InktileDocument;
  assets: RuntimeAssetMap;
  dirty: boolean;
  currentPath: string | null;
  setCurrentPath: (path: string | null) => void;
  markSaved: () => void;
  newDocument: () => InktileDocument;
  loadDocument: (loaded: LoadedDocument) => void;
  updateTitle: (title: string) => void;
  setPageVerticalAlign: (pageId: string, alignment: VerticalAlignment) => void;
  addPage: (afterPageId?: string, type?: PageType) => string;
  /** Inserts a new page at an exact spot: before row `rowIndex`, or into that row
   * before column `columnIndex` (null when the row is full). */
  addPageAt: (position: InsertPosition, type?: PageType) => string | null;
  addBlockPage: (block: Block, afterPageId?: string) => string;
  duplicatePage: (pageId: string) => string | null;
  duplicatePages: (pageIds: string[]) => string[];
  pastePages: (sources: InktilePage[], afterPageId?: string) => string[];
  /** Pastes snapshots at an exact spot: as rows before row `rowIndex`, or into that
   * row before column `columnIndex` (empty when they would not fit). */
  pastePagesAt: (sources: InktilePage[], position: InsertPosition) => string[];
  deletePage: (pageId: string) => void;
  deletePages: (pageIds: string[]) => void;
  movePage: (pageId: string, targetPageId: string, position?: "before" | "after" | "left" | "right") => void;
  movePages: (pageIds: string[], targetPageId: string, position?: "before" | "after" | "left" | "right") => void;
  setPageRowHeight: (pageIds: string[], height: number) => void;
  setRowWidthFractions: (pageIds: string[], fractions: number[]) => void;
  togglePageSide: (pageId: string) => void;
  togglePagesSide: (pageIds: string[]) => void;
  convertVariantToText: (pageId: string, side: PageSide, blockId: string) => void;
  /** Sets the back-face ("notes") text, creating the face when missing. */
  setPageNotes: (pageId: string, html: string) => void;
  updatePageDrawing: (pageId: string, drawing: import("./types").DrawingBlock, record?: boolean) => void;
  updateBlock: (pageId: string, side: PageSide, blockId: string, patch: Partial<Block>, record?: boolean) => void;
  addAsset: (file: File) => Promise<string>;
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** True while an agent turn holds the document lock; user editing is suspended. */
  agentTurn: boolean;
  /** Locks the document for an agent turn and records one undo checkpoint.
   * Returns false when a turn is already active. */
  beginAgentTurn: () => boolean;
  endAgentTurn: () => void;
  /** Runs agent-issued mutations: they pass the turn lock and never record
   * per-op history, so the whole turn reverts with the begin checkpoint. */
  runAgentEdit: <T>(fn: () => T | Promise<T>) => Promise<T>;
  /** Monotonic revision, bumped by every mutation (user or agent). */
  getRevision: () => number;
  getDocumentSnapshot: () => InktileDocument;
}

const DocumentContext = createContext<DocumentContextValue | null>(null);

const revokeAssets = (assets: RuntimeAssetMap) => {
  Object.values(assets).forEach((asset) => URL.revokeObjectURL(asset.url));
};

const syncPageOrder = (document: InktileDocument) => {
  document.pageRows = document.pageRows.filter((row) => row.length > 0);
  document.pageOrder = document.pageRows.flat();
};

export function DocumentProvider({ children }: PropsWithChildren) {
  const [document, setDocument] = useState<InktileDocument>(() => createDocument());
  const [assets, setAssets] = useState<RuntimeAssetMap>({});
  const [past, setPast] = useState<InktileDocument[]>([]);
  const [future, setFuture] = useState<InktileDocument[]>([]);
  const [dirty, setDirty] = useState(false);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [agentTurn, setAgentTurn] = useState(false);
  const agentTurnRef = useRef(false);
  const agentWritingRef = useRef(false);
  const revisionRef = useRef(0);
  const documentRef = useRef(document);
  documentRef.current = document;

  const commit = useCallback((updater: (draft: InktileDocument) => void, record = true) => {
    // Turn-based lock: while an agent turn runs, only agent-issued mutations
    // (wrapped in runAgentEdit) may change the document. Agent ops never record
    // per-op history — the turn's begin checkpoint keeps the whole turn one undo.
    if (agentTurnRef.current && !agentWritingRef.current) return;
    if (agentWritingRef.current) record = false;
    revisionRef.current += 1;
    setDocument((previous) => {
      const next = structuredClone(previous);
      updater(next);
      next.modifiedAt = new Date().toISOString();
      if (record) {
        setPast((items) => [...items, previous].slice(-100));
        setFuture([]);
      }
      return next;
    });
    setDirty(true);
  }, []);

  const newDocument = useCallback(() => {
    const nextDocument = createDocument();
    revokeAssets(assets);
    setAssets({});
    revisionRef.current += 1;
    setDocument(nextDocument);
    setPast([]);
    setFuture([]);
    setDirty(false);
    setCurrentPath(null);
    return nextDocument;
  }, [assets]);

  const loadDocument = useCallback((loaded: LoadedDocument) => {
    setAssets((existing) => {
      revokeAssets(existing);
      return loaded.assets;
    });
    revisionRef.current += 1;
    setDocument(normalizeDocumentPages(loaded.document));
    setPast([]);
    setFuture([]);
    setDirty(false);
    setCurrentPath(loaded.path ?? null);
  }, []);

  const updateTitle = useCallback((title: string) => {
    commit((draft) => { draft.title = title; }, false);
  }, [commit]);

  const setPageVerticalAlign = useCallback((pageId: string, alignment: VerticalAlignment) => {
    commit((draft) => {
      const page = draft.pages[pageId];
      if (page) page.verticalAlign = alignment;
    });
  }, [commit]);

  const addPage = useCallback((afterPageId?: string, type: PageType = "standard") => {
    const page = createPage(type);
    commit((draft) => {
      draft.pages[page.id] = page;
      const rowIndex = afterPageId ? draft.pageRows.findIndex((row) => row.includes(afterPageId)) : -1;
      draft.pageRows.splice(rowIndex >= 0 ? rowIndex + 1 : draft.pageRows.length, 0, [page.id]);
      syncPageOrder(draft);
    });
    return page.id;
  }, [commit]);

  const addPageAt = useCallback((position: InsertPosition, type: PageType = "standard") => {
    const { rowIndex, columnIndex } = position;
    if (columnIndex !== undefined) {
      const row = documentRef.current.pageRows[rowIndex];
      if (!row || row.length >= 4) return null;
    }
    const page = createPage(type);
    commit((draft) => {
      draft.pages[page.id] = page;
      const row = columnIndex !== undefined ? draft.pageRows[rowIndex] : undefined;
      if (row) {
        row.splice(Math.min(columnIndex ?? row.length, row.length), 0, page.id);
        // Membership changed, so the row's width split resets to the equal default.
        row.forEach((id) => { const member = draft.pages[id]; if (member) delete member.layoutWidthFraction; });
      } else {
        draft.pageRows.splice(Math.max(0, Math.min(rowIndex, draft.pageRows.length)), 0, [page.id]);
      }
      syncPageOrder(draft);
    });
    return page.id;
  }, [commit]);

  const addBlockPage = useCallback((block: Block, afterPageId?: string) => {
    const page = createBlockPage(block);
    commit((draft) => {
      draft.pages[page.id] = page;
      const rowIndex = afterPageId ? draft.pageRows.findIndex((row) => row.includes(afterPageId)) : -1;
      draft.pageRows.splice(rowIndex >= 0 ? rowIndex + 1 : draft.pageRows.length, 0, [page.id]);
      syncPageOrder(draft);
    });
    return page.id;
  }, [commit]);

  const duplicatePages = useCallback((pageIds: string[]) => {
    const requested = new Set(pageIds);
    const ordered = documentRef.current.pageOrder.filter((id) => requested.has(id) && documentRef.current.pages[id]);
    if (!ordered.length) return [];
    const newIds = ordered.map(() => uuid());
    commit((draft) => {
      // Reverse document order so each copy lands in its own row directly under its
      // source row, and same-row sources keep their copies in source order.
      for (let index = ordered.length - 1; index >= 0; index -= 1) {
        const source = draft.pages[ordered[index]];
        if (!source) continue;
        const copy = clonePage(source, newIds[index]);
        draft.pages[copy.id] = copy;
        const rowIndex = draft.pageRows.findIndex((row) => row.includes(ordered[index]));
        draft.pageRows.splice(rowIndex >= 0 ? rowIndex + 1 : draft.pageRows.length, 0, [copy.id]);
      }
      syncPageOrder(draft);
    });
    return newIds;
  }, [commit]);

  const duplicatePage = useCallback((pageId: string) => duplicatePages([pageId])[0] ?? null, [duplicatePages]);

  /** Inserts fresh-id copies of page snapshots (the tile clipboard), one row each. */
  const pastePages = useCallback((sources: InktilePage[], afterPageId?: string) => {
    if (!sources.length) return [];
    const newIds = sources.map(() => uuid());
    commit((draft) => {
      const rowIndex = afterPageId ? draft.pageRows.findIndex((row) => row.includes(afterPageId)) : -1;
      const rows = sources.map((source, index) => {
        const copy = clonePage(source, newIds[index]);
        draft.pages[copy.id] = copy;
        return [copy.id];
      });
      draft.pageRows.splice(rowIndex >= 0 ? rowIndex + 1 : draft.pageRows.length, 0, ...rows);
      syncPageOrder(draft);
    });
    return newIds;
  }, [commit]);

  /** Pastes snapshot copies at an exact spot; into-the-row pastes honor the four-per-row cap. */
  const pastePagesAt = useCallback((sources: InktilePage[], position: InsertPosition) => {
    if (!sources.length) return [];
    const { rowIndex, columnIndex } = position;
    if (columnIndex !== undefined) {
      const row = documentRef.current.pageRows[rowIndex];
      if (!row || row.length + sources.length > 4) return [];
    }
    const newIds = sources.map(() => uuid());
    commit((draft) => {
      const copies = sources.map((source, index) => {
        const copy = clonePage(source, newIds[index]);
        draft.pages[copy.id] = copy;
        return copy.id;
      });
      const row = columnIndex !== undefined ? draft.pageRows[rowIndex] : undefined;
      if (row) {
        row.splice(Math.min(columnIndex ?? row.length, row.length), 0, ...copies);
        row.forEach((id) => { const member = draft.pages[id]; if (member) delete member.layoutWidthFraction; });
      } else {
        draft.pageRows.splice(Math.max(0, Math.min(rowIndex, draft.pageRows.length)), 0, ...copies.map((id) => [id]));
      }
      syncPageOrder(draft);
    });
    return newIds;
  }, [commit]);

  const deletePages = useCallback((pageIds: string[]) => {
    const removed = new Set(pageIds);
    if (!removed.size) return;
    commit((draft) => {
      draft.pageRows = draft.pageRows.map((row) => {
        const remaining = row.filter((id) => !removed.has(id));
        // Removing a member changes the row split, so reset it to the equal default.
        if (remaining.length !== row.length) remaining.forEach((id) => { const page = draft.pages[id]; if (page) delete page.layoutWidthFraction; });
        return remaining;
      });
      syncPageOrder(draft);
      removed.forEach((id) => { delete draft.pages[id]; });
    });
  }, [commit]);

  const deletePage = useCallback((pageId: string) => deletePages([pageId]), [deletePages]);

  const movePages = useCallback((pageIds: string[], targetPageId: string, position: "before" | "after" | "left" | "right" = "before") => {
    const moving = new Set(pageIds);
    if (!moving.size || moving.has(targetPageId)) return;
    const current = documentRef.current;
    const ordered = current.pageOrder.filter((id) => moving.has(id));
    const targetRow = current.pageRows.find((row) => row.includes(targetPageId));
    if (!ordered.length || !targetRow) return;
    const horizontal = position === "left" || position === "right";
    if (horizontal && targetRow.filter((id) => !moving.has(id)).length + ordered.length > 4) return;

    commit((draft) => {
      // Rows whose membership changes reset their width split to the equal default; a
      // fully-moved row travels as one segment and keeps its internal split.
      const affectedPageIds = new Set<string>();
      const segments: string[][] = [];
      for (const row of draft.pageRows) {
        const members = row.filter((id) => moving.has(id));
        if (!members.length) continue;
        segments.push(members);
        if (members.length < row.length) row.forEach((id) => affectedPageIds.add(id));
      }
      draft.pageRows = draft.pageRows
        .map((row) => row.filter((id) => !moving.has(id)))
        .filter((row) => row.length > 0);
      const targetRowIndex = draft.pageRows.findIndex((row) => row.includes(targetPageId));
      if (targetRowIndex < 0) return;
      if (horizontal) {
        const row = draft.pageRows[targetRowIndex];
        row.splice(row.indexOf(targetPageId) + (position === "right" ? 1 : 0), 0, ...ordered);
        row.forEach((id) => affectedPageIds.add(id));
      } else {
        draft.pageRows.splice(targetRowIndex + (position === "after" ? 1 : 0), 0, ...segments);
      }
      affectedPageIds.forEach((id) => { const page = draft.pages[id]; if (page) delete page.layoutWidthFraction; });
      syncPageOrder(draft);
    });
  }, [commit]);

  const movePage = useCallback((pageId: string, targetPageId: string, position: "before" | "after" | "left" | "right" = "before") => {
    movePages([pageId], targetPageId, position);
  }, [movePages]);

  const setPageRowHeight = useCallback((pageIds: string[], height: number) => {
    commit((draft) => {
      pageIds.forEach((pageId) => {
        const page = draft.pages[pageId];
        if (!page) return;
        page.layoutHeight = height;
        if (page.type === "drawing" && page.drawing) page.drawing.height = height;
      });
    }, false);
  }, [commit]);

  const setRowWidthFractions = useCallback((pageIds: string[], fractions: number[]) => {
    commit((draft) => {
      pageIds.forEach((pageId, index) => {
        const page = draft.pages[pageId];
        const fraction = fractions[index];
        if (!page || typeof fraction !== "number" || !Number.isFinite(fraction) || fraction <= 0) return;
        page.layoutWidthFraction = fraction;
      });
    }, false);
  }, [commit]);

  const togglePagesSide = useCallback((pageIds: string[]) => {
    if (!pageIds.length) return;
    commit((draft) => {
      pageIds.forEach((pageId) => {
        const page = draft.pages[pageId];
        if (!page) return;
        if (!page.back) page.back = { blocks: [{ id: uuid(), type: "text", html: "" }] };
        page.activeSide = page.activeSide === "front" ? "back" : "front";
      });
    });
  }, [commit]);

  const togglePageSide = useCallback((pageId: string) => togglePagesSide([pageId]), [togglePagesSide]);

  const convertVariantToText = useCallback((pageId: string, side: PageSide, blockId: string) => {
    commit((draft) => {
      const page = draft.pages[pageId];
      const face = side === "front" ? page.front : page.back;
      const index = face?.blocks.findIndex((block) => block.id === blockId) ?? -1;
      if (!face || index < 0) return;
      const block = face.blocks[index];
      if (block.type !== "variants") return;
      const active = block.variants[block.activeVariant];
      face.blocks[index] = { id: uuid(), type: "text", html: active?.html ?? "" };
    });
  }, [commit]);

  const setPageNotes = useCallback((pageId: string, html: string) => {
    commit((draft) => {
      const page = draft.pages[pageId];
      if (!page) return;
      if (!page.back) page.back = { blocks: [{ id: uuid(), type: "text", html: "" }] };
      const block = page.back.blocks.find((item) => item.type === "text");
      if (block && block.type === "text") block.html = html;
    });
  }, [commit]);

  const updatePageDrawing = useCallback((pageId: string, drawing: import("./types").DrawingBlock, record = false) => {
    commit((draft) => {
      const page = draft.pages[pageId];
      if (page) page.drawing = drawing;
    }, record);
  }, [commit]);

  const updateBlock = useCallback((pageId: string, side: PageSide, blockId: string, patch: Partial<Block>, record = false) => {
    commit((draft) => {
      const page = draft.pages[pageId];
      const face = side === "front" ? page.front : page.back;
      const block = face?.blocks.find((item) => item.id === blockId);
      if (block) Object.assign(block, patch);
    }, record);
  }, [commit]);

  const checkpoint = useCallback(() => {
    if (agentTurnRef.current && !agentWritingRef.current) return;
    setPast((items) => [...items, structuredClone(documentRef.current)].slice(-100));
    setFuture([]);
  }, []);

  const beginAgentTurn = useCallback(() => {
    if (agentTurnRef.current) return false;
    setPast((items) => [...items, structuredClone(documentRef.current)].slice(-100));
    setFuture([]);
    agentTurnRef.current = true;
    setAgentTurn(true);
    return true;
  }, []);

  const endAgentTurn = useCallback(() => {
    agentTurnRef.current = false;
    setAgentTurn(false);
  }, []);

  const runAgentEdit = useCallback(async <T,>(fn: () => T | Promise<T>): Promise<T> => {
    agentWritingRef.current = true;
    try {
      return await fn();
    } finally {
      agentWritingRef.current = false;
    }
  }, []);

  const getRevision = useCallback(() => revisionRef.current, []);
  const getDocumentSnapshot = useCallback(() => documentRef.current, []);

  const addAsset = useCallback(async (file: File) => {
    const hash = await hashBlob(file);
    const existing = Object.values(documentRef.current.assets).find((asset) => asset.hash === hash);
    if (existing) return existing.id;

    const id = uuid();
    const extension = extensionForMime(file.type, file.name);
    const metadata: AssetMetadata = {
      id,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      byteLength: file.size,
      hash,
      internalPath: `assets/${id}.${extension}`
    };
    const blob = file.slice(0, file.size, metadata.mimeType);
    setAssets((items) => ({
      ...items,
      [id]: { metadata, blob, url: URL.createObjectURL(blob) }
    }));
    commit((draft) => { draft.assets[id] = metadata; });
    return id;
  }, [commit]);

  const undo = useCallback(() => {
    if (agentTurnRef.current) return;
    revisionRef.current += 1;
    setPast((items) => {
      if (!items.length) return items;
      const previous = items[items.length - 1];
      setDocument((current) => {
        setFuture((futureItems) => [current, ...futureItems].slice(0, 100));
        return previous;
      });
      setDirty(true);
      return items.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    if (agentTurnRef.current) return;
    revisionRef.current += 1;
    setFuture((items) => {
      if (!items.length) return items;
      const next = items[0];
      setDocument((current) => {
        setPast((pastItems) => [...pastItems, current].slice(-100));
        return next;
      });
      setDirty(true);
      return items.slice(1);
    });
  }, []);

  const value = useMemo<DocumentContextValue>(() => ({
    document,
    assets,
    dirty,
    currentPath,
    setCurrentPath,
    markSaved: () => setDirty(false),
    newDocument,
    loadDocument,
    updateTitle,
    setPageVerticalAlign,
    addPage,
    addPageAt,
    addBlockPage,
    duplicatePage,
    duplicatePages,
    pastePages,
    pastePagesAt,
    deletePage,
    deletePages,
    movePage,
    movePages,
    setPageRowHeight,
    setRowWidthFractions,
    togglePageSide,
    togglePagesSide,
    convertVariantToText,
    setPageNotes,
    updatePageDrawing,
    updateBlock,
    addAsset,
    checkpoint,
    undo,
    redo,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    agentTurn,
    beginAgentTurn,
    endAgentTurn,
    runAgentEdit,
    getRevision,
    getDocumentSnapshot
  }), [
    document, assets, dirty, currentPath, newDocument, loadDocument, updateTitle, setPageVerticalAlign,
    addPage, addPageAt, addBlockPage, duplicatePage, duplicatePages, pastePages, pastePagesAt, deletePage, deletePages, movePage, movePages,
    setPageRowHeight, setRowWidthFractions, togglePageSide, togglePagesSide, convertVariantToText, setPageNotes, updatePageDrawing, updateBlock,
    addAsset, checkpoint, undo, redo, past.length, future.length,
    agentTurn, beginAgentTurn, endAgentTurn, runAgentEdit, getRevision, getDocumentSnapshot
  ]);

  return <DocumentContext.Provider value={value}>{children}</DocumentContext.Provider>;
}

export function useDocument() {
  const context = useContext(DocumentContext);
  if (!context) throw new Error("useDocument must be used inside DocumentProvider");
  return context;
}
