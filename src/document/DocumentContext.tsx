import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState
} from "react";
import { createBlockPage, createDocument, createPage, normalizeDocumentPages, uuid } from "./factories";
import type {
  AssetMetadata,
  Block,
  FolioDocument,
  PageSide,
  PageType,
  RuntimeAssetMap,
  ThemePreference,
  VerticalAlignment
} from "./types";
import { extensionForMime, hashBlob } from "../utils/hash";

interface LoadedDocument {
  document: FolioDocument;
  assets: RuntimeAssetMap;
}

interface DocumentContextValue {
  document: FolioDocument;
  assets: RuntimeAssetMap;
  dirty: boolean;
  currentPath: string | null;
  setCurrentPath: (path: string | null) => void;
  markSaved: () => void;
  newDocument: () => FolioDocument;
  loadDocument: (loaded: LoadedDocument, path?: string | null) => void;
  updateTitle: (title: string) => void;
  setTheme: (theme: ThemePreference) => void;
  setPageVerticalAlign: (pageId: string, alignment: VerticalAlignment) => void;
  addPage: (afterPageId?: string, type?: PageType) => string;
  addBlockPage: (block: Block, afterPageId?: string) => string;
  deletePage: (pageId: string) => void;
  movePage: (pageId: string, targetPageId: string, position?: "before" | "after" | "left" | "right") => void;
  setPageRowHeight: (pageIds: string[], height: number) => void;
  setRowWidthFractions: (pageIds: string[], fractions: number[]) => void;
  togglePageSide: (pageId: string) => void;
  convertVariantToText: (pageId: string, side: PageSide, blockId: string) => void;
  updatePageDrawing: (pageId: string, drawing: import("./types").DrawingBlock, record?: boolean) => void;
  updateBlock: (pageId: string, side: PageSide, blockId: string, patch: Partial<Block>, record?: boolean) => void;
  addAsset: (file: File) => Promise<string>;
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

const DocumentContext = createContext<DocumentContextValue | null>(null);

const revokeAssets = (assets: RuntimeAssetMap) => {
  Object.values(assets).forEach((asset) => URL.revokeObjectURL(asset.url));
};

const syncPageOrder = (document: FolioDocument) => {
  document.pageRows = document.pageRows.filter((row) => row.length > 0);
  document.pageOrder = document.pageRows.flat();
};

export function DocumentProvider({ children }: PropsWithChildren) {
  const [document, setDocument] = useState<FolioDocument>(() => createDocument());
  const [assets, setAssets] = useState<RuntimeAssetMap>({});
  const [past, setPast] = useState<FolioDocument[]>([]);
  const [future, setFuture] = useState<FolioDocument[]>([]);
  const [dirty, setDirty] = useState(false);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const documentRef = useRef(document);
  documentRef.current = document;

  const commit = useCallback((updater: (draft: FolioDocument) => void, record = true) => {
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
    setDocument(nextDocument);
    setPast([]);
    setFuture([]);
    setDirty(false);
    setCurrentPath(null);
    return nextDocument;
  }, [assets]);

  const loadDocument = useCallback((loaded: LoadedDocument, path: string | null = null) => {
    setAssets((existing) => {
      revokeAssets(existing);
      return loaded.assets;
    });
    setDocument(normalizeDocumentPages(loaded.document));
    setPast([]);
    setFuture([]);
    setDirty(false);
    setCurrentPath(path);
  }, []);

  const updateTitle = useCallback((title: string) => {
    commit((draft) => { draft.title = title; }, false);
  }, [commit]);

  const setTheme = useCallback((theme: ThemePreference) => {
    commit((draft) => { draft.settings.theme = theme; });
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

  const deletePage = useCallback((pageId: string) => {
    commit((draft) => {
      draft.pageRows = draft.pageRows.map((row) => {
        if (!row.includes(pageId)) return row;
        const remaining = row.filter((id) => id !== pageId);
        // Removing a member changes the row split, so reset it to the equal default.
        remaining.forEach((id) => { const page = draft.pages[id]; if (page) delete page.layoutWidthFraction; });
        return remaining;
      });
      syncPageOrder(draft);
      delete draft.pages[pageId];
    });
  }, [commit]);

  const movePage = useCallback((pageId: string, targetPageId: string, position: "before" | "after" | "left" | "right" = "before") => {
    if (pageId === targetPageId) return;
    const currentRows = documentRef.current.pageRows;
    const sourceRow = currentRows.find((row) => row.includes(pageId));
    const targetRow = currentRows.find((row) => row.includes(targetPageId));
    const horizontal = position === "left" || position === "right";
    if (!sourceRow || !targetRow || (horizontal && sourceRow !== targetRow && targetRow.length >= 4)) return;

    commit((draft) => {
      const rows = draft.pageRows;
      // Both the row losing a page and the row gaining one change membership, so
      // their width fractions reset to the equal-split default (kept simple).
      const affectedPageIds = new Set<string>([pageId]);
      const sourceRowIndex = rows.findIndex((row) => row.includes(pageId));
      if (sourceRowIndex < 0) return;
      const sourceRowRef = rows[sourceRowIndex];
      sourceRowRef.splice(sourceRowRef.indexOf(pageId), 1);
      sourceRowRef.forEach((id) => affectedPageIds.add(id));
      if (!sourceRowRef.length) rows.splice(rows.indexOf(sourceRowRef), 1);

      const targetRowIndex = rows.findIndex((row) => row.includes(targetPageId));
      if (targetRowIndex < 0) return;
      if (horizontal) {
        const targetColumn = rows[targetRowIndex].indexOf(targetPageId);
        rows[targetRowIndex].splice(targetColumn + (position === "right" ? 1 : 0), 0, pageId);
      } else {
        rows.splice(targetRowIndex + (position === "after" ? 1 : 0), 0, [pageId]);
      }
      rows.find((row) => row.includes(pageId))?.forEach((id) => affectedPageIds.add(id));
      affectedPageIds.forEach((id) => { const page = draft.pages[id]; if (page) delete page.layoutWidthFraction; });
      syncPageOrder(draft);
    });
  }, [commit]);

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

  const togglePageSide = useCallback((pageId: string) => {
    commit((draft) => {
      const page = draft.pages[pageId];
      if (!page.back) page.back = { blocks: [{ id: uuid(), type: "text", html: "" }] };
      page.activeSide = page.activeSide === "front" ? "back" : "front";
    });
  }, [commit]);

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
    setPast((items) => [...items, structuredClone(documentRef.current)].slice(-100));
    setFuture([]);
  }, []);

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
    setTheme,
    setPageVerticalAlign,
    addPage,
    addBlockPage,
    deletePage,
    movePage,
    setPageRowHeight,
    setRowWidthFractions,
    togglePageSide,
    convertVariantToText,
    updatePageDrawing,
    updateBlock,
    addAsset,
    checkpoint,
    undo,
    redo,
    canUndo: past.length > 0,
    canRedo: future.length > 0
  }), [
    document, assets, dirty, currentPath, newDocument, loadDocument, updateTitle, setTheme, setPageVerticalAlign,
    addPage, addBlockPage, deletePage, movePage, setPageRowHeight, setRowWidthFractions, togglePageSide, convertVariantToText, updatePageDrawing, updateBlock,
    addAsset, checkpoint, undo, redo, past.length, future.length
  ]);

  return <DocumentContext.Provider value={value}>{children}</DocumentContext.Provider>;
}

export function useDocument() {
  const context = useContext(DocumentContext);
  if (!context) throw new Error("useDocument must be used inside DocumentProvider");
  return context;
}
