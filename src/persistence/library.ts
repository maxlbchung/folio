import type { InktileDocument, RuntimeAssetMap } from "../document/types";
import { uuid } from "../document/factories";
import { decodeInktile, encodeInktile, type LoadedInktile } from "./inktileArchive";
import { LIBRARY_INDEX_STORE, LIBRARY_STORE, openInktileDb } from "./database";
import { deleteAutosave, readAutosave } from "./autosave";

interface LibraryRecord {
  id: string;
  title: string;
  createdAt: string;
  modifiedAt: string;
  lastOpenedAt: string;
  pageCount: number;
  plainText: string;
  previewText: string;
  path: string | null;
  pinned?: boolean;
  blob: Blob;
  snapshot?: StoredLibrarySnapshot;
}

interface StoredLibrarySnapshot {
  document: InktileDocument;
  assetBlobs: Record<string, Blob>;
}

export type LibrarySort = "lastOpenedAt" | "createdAt" | "modifiedAt" | "title";
export type SortDirection = "ascending" | "descending";

export interface LibraryEntry extends Omit<LibraryRecord, "blob" | "snapshot"> {}

export interface LibrarySearchResults {
  titleMatches: LibraryEntry[];
  textMatches: Array<LibraryEntry & { frequency: number }>;
}

export interface LoadedLibraryInktile extends LoadedInktile {
  path: string | null;
}

const requestResult = <T,>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const completeTransaction = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error);
});

const BLOCK_BOUNDARY = /<\/(p|div|li|h[1-6]|blockquote|section|article|ul|ol|pre|tr|td|th|figure|figcaption)>/gi;

const htmlToText = (html: string): string => {
  const container = window.document.createElement("div");
  // <br> and block-element boundaries carry no whitespace in textContent, so "a<div>b</div>" would
  // read as "ab" — collapsing separate lines into one run. Insert a space at each boundary first so
  // adjacent lines/blocks stay distinct words; search matching and readable excerpts depend on it.
  container.innerHTML = html.replace(/<br\s*\/?>/gi, " ").replace(BLOCK_BOUNDARY, "$& ");
  return container.textContent ?? "";
};

export function documentPlainText(document: InktileDocument): string {
  const segments: string[] = [];
  for (const pageId of document.pageOrder) {
    const page = document.pages[pageId];
    if (!page) continue;
    const faces = [page.front, page.back].filter(Boolean);
    for (const face of faces) {
      for (const block of face!.blocks) {
        if (block.type === "text") segments.push(htmlToText(block.html));
        if (block.type === "variants") segments.push(...block.variants.map((variant) => htmlToText(variant.html)));
        if (block.type === "image" && block.alt) segments.push(block.alt);
      }
    }
  }
  return segments.join(" ").replace(/\s+/g, " ").trim();
}

const summarize = (text: string): string => text.slice(0, 180).trim();

const toEntry = ({ blob: _blob, snapshot: _snapshot, ...entry }: LibraryRecord): LibraryEntry => entry;

interface CachedLibraryInktile {
  entry: LibraryEntry;
  snapshot?: StoredLibrarySnapshot;
}

const libraryCache = new Map<string, CachedLibraryInktile>();
let libraryIndexLoaded = false;
let libraryIndexLoad: Promise<void> | null = null;

const createStoredSnapshot = (document: InktileDocument, assets: RuntimeAssetMap): StoredLibrarySnapshot => ({
  document: structuredClone(document),
  assetBlobs: Object.fromEntries(Object.entries(assets).map(([id, asset]) => [id, asset.blob]))
});

const loadStoredSnapshot = (snapshot: StoredLibrarySnapshot): LoadedInktile => {
  const document = structuredClone(snapshot.document);
  const assets: RuntimeAssetMap = {};
  Object.values(document.assets).forEach((metadata) => {
    const blob = snapshot.assetBlobs[metadata.id];
    if (blob) assets[metadata.id] = { metadata, blob, url: URL.createObjectURL(blob) };
  });
  return { document, assets };
};

const rememberEntry = (entry: LibraryEntry) => {
  const cached = libraryCache.get(entry.id);
  if (cached && cached.entry.modifiedAt >= entry.modifiedAt) {
    cached.entry.lastOpenedAt = cached.entry.lastOpenedAt > entry.lastOpenedAt ? cached.entry.lastOpenedAt : entry.lastOpenedAt;
    if (!cached.entry.path && entry.path) cached.entry.path = entry.path;
    return;
  }
  libraryCache.set(entry.id, { entry, snapshot: cached?.snapshot });
};

const rememberRecord = (record: LibraryRecord) => {
  const entry = toEntry(record);
  const cached = libraryCache.get(record.id);
  rememberEntry(entry);
  if (record.snapshot && (!cached || cached.entry.modifiedAt <= entry.modifiedAt)) {
    libraryCache.get(record.id)!.snapshot = record.snapshot;
  }
};

const stageLibraryInktile = (
  document: InktileDocument,
  assets: RuntimeAssetMap,
  path: string | null,
  touchOpened: boolean
): { entry: LibraryEntry; snapshot: StoredLibrarySnapshot } => {
  const cached = libraryCache.get(document.id);
  const plainText = documentPlainText(document);
  const entry: LibraryEntry = {
    id: document.id,
    title: document.title.trim() || "Untitled Inktile",
    createdAt: document.createdAt,
    modifiedAt: document.modifiedAt,
    lastOpenedAt: touchOpened ? new Date().toISOString() : cached?.entry.lastOpenedAt ?? document.createdAt,
    pageCount: document.pageOrder.length,
    plainText,
    previewText: summarize(plainText),
    path: path ?? cached?.entry.path ?? null,
    pinned: cached?.entry.pinned ?? false
  };
  const snapshot = createStoredSnapshot(document, assets);
  if (!cached || cached.entry.modifiedAt <= entry.modifiedAt) libraryCache.set(document.id, { entry, snapshot });
  return { entry, snapshot };
};

export async function listLibraryInktiles(): Promise<LibraryEntry[]> {
  if (!libraryIndexLoaded) {
    libraryIndexLoad ??= (async () => {
      const database = await openInktileDb();
      try {
        const transaction = database.transaction(LIBRARY_INDEX_STORE, "readonly");
        const entries = await requestResult(transaction.objectStore(LIBRARY_INDEX_STORE).getAll() as IDBRequest<LibraryEntry[]>);
        entries.forEach(rememberEntry);
        libraryIndexLoaded = true;
      } finally {
        database.close();
      }
    })().finally(() => { libraryIndexLoad = null; });
    await libraryIndexLoad;
  }
  return [...libraryCache.values()].map(({ entry }) => entry);
}

interface SaveLibraryOptions {
  touchOpened?: boolean;
}

export async function saveLibraryInktile(
  document: InktileDocument,
  assets: RuntimeAssetMap,
  path: string | null = null,
  options: SaveLibraryOptions = {}
): Promise<LibraryEntry> {
  const staged = stageLibraryInktile(document, assets, path, options.touchOpened === true);
  const blob = await encodeInktile(document, assets);
  const database = await openInktileDb();
  try {
    const transaction = database.transaction([LIBRARY_STORE, LIBRARY_INDEX_STORE], "readwrite");
    const transactionComplete = completeTransaction(transaction);
    const store = transaction.objectStore(LIBRARY_STORE);
    const indexStore = transaction.objectStore(LIBRARY_INDEX_STORE);
    const existing = await requestResult(store.get(document.id) as IDBRequest<LibraryRecord | undefined>);
    if (existing && existing.modifiedAt > document.modifiedAt) {
      if (options.touchOpened) {
        existing.lastOpenedAt = new Date().toISOString();
        if (path) existing.path = path;
        store.put(existing);
        indexStore.put(toEntry(existing));
      }
      await transactionComplete;
      rememberRecord(existing);
      return toEntry(existing);
    }
    // A save staged before the library index warmed the cache must not drop an existing pin.
    if (existing?.pinned && !staged.entry.pinned) staged.entry.pinned = true;
    const record: LibraryRecord = {
      ...staged.entry,
      lastOpenedAt: staged.entry.lastOpenedAt,
      path: path ?? existing?.path ?? staged.entry.path,
      blob,
      snapshot: staged.snapshot
    };
    store.put(record);
    indexStore.put(toEntry(record));
    await transactionComplete;
    rememberRecord(record);
    return toEntry(record);
  } finally {
    database.close();
  }
}

export function getCachedLibraryInktile(id: string): LoadedLibraryInktile | null {
  const cached = libraryCache.get(id);
  if (!cached?.snapshot) return null;
  return { ...loadStoredSnapshot(cached.snapshot), path: cached.entry.path };
}

export async function touchLibraryInktile(id: string): Promise<void> {
  const database = await openInktileDb();
  try {
    const transaction = database.transaction(LIBRARY_INDEX_STORE, "readwrite");
    const transactionComplete = completeTransaction(transaction);
    const store = transaction.objectStore(LIBRARY_INDEX_STORE);
    const entry = await requestResult(store.get(id) as IDBRequest<LibraryEntry | undefined>);
    if (entry) {
      entry.lastOpenedAt = new Date().toISOString();
      store.put(entry);
      await transactionComplete;
      rememberEntry(entry);
    } else {
      await transactionComplete;
    }
  } finally {
    database.close();
  }
}

export async function setLibraryInktilePinned(id: string, pinned: boolean): Promise<void> {
  const cached = libraryCache.get(id);
  if (cached) cached.entry.pinned = pinned;
  const database = await openInktileDb();
  try {
    const transaction = database.transaction([LIBRARY_STORE, LIBRARY_INDEX_STORE], "readwrite");
    const transactionComplete = completeTransaction(transaction);
    const store = transaction.objectStore(LIBRARY_STORE);
    const indexStore = transaction.objectStore(LIBRARY_INDEX_STORE);
    const record = await requestResult(store.get(id) as IDBRequest<LibraryRecord | undefined>);
    if (record) {
      record.pinned = pinned;
      store.put(record);
    }
    const entry = await requestResult(indexStore.get(id) as IDBRequest<LibraryEntry | undefined>);
    if (entry) {
      entry.pinned = pinned;
      indexStore.put(entry);
    }
    await transactionComplete;
  } finally {
    database.close();
  }
}

const persistStoredSnapshot = async (id: string, modifiedAt: string, snapshot: StoredLibrarySnapshot): Promise<void> => {
  const database = await openInktileDb();
  try {
    const transaction = database.transaction(LIBRARY_STORE, "readwrite");
    const transactionComplete = completeTransaction(transaction);
    const store = transaction.objectStore(LIBRARY_STORE);
    const current = await requestResult(store.get(id) as IDBRequest<LibraryRecord | undefined>);
    if (current?.modifiedAt === modifiedAt) {
      current.snapshot = snapshot;
      store.put(current);
    }
    await transactionComplete;
  } finally {
    database.close();
  }
};

export async function openLibraryInktile(id: string): Promise<LoadedLibraryInktile | null> {
  const cached = getCachedLibraryInktile(id);
  if (cached) return cached;
  const database = await openInktileDb();
  try {
    const transaction = database.transaction(LIBRARY_STORE, "readonly");
    const store = transaction.objectStore(LIBRARY_STORE);
    const record = await requestResult(store.get(id) as IDBRequest<LibraryRecord | undefined>);
    if (!record) return null;
    rememberRecord(record);
    if (record.snapshot) return { ...loadStoredSnapshot(record.snapshot), path: record.path };

    const loaded = await decodeInktile(record.blob);
    const snapshot = createStoredSnapshot(loaded.document, loaded.assets);
    libraryCache.set(id, { entry: toEntry(record), snapshot });
    void persistStoredSnapshot(id, record.modifiedAt, snapshot).catch(() => undefined);
    return { ...loaded, path: record.path };
  } finally {
    database.close();
  }
}

export async function deleteLibraryInktile(id: string): Promise<void> {
  libraryCache.delete(id);
  const database = await openInktileDb();
  try {
    const transaction = database.transaction([LIBRARY_STORE, LIBRARY_INDEX_STORE], "readwrite");
    const transactionComplete = completeTransaction(transaction);
    transaction.objectStore(LIBRARY_STORE).delete(id);
    transaction.objectStore(LIBRARY_INDEX_STORE).delete(id);
    await transactionComplete;
  } finally {
    database.close();
  }

  const autosave = await readAutosave().catch(() => null);
  if (!autosave) return;
  try {
    if (autosave.document.id === id) await deleteAutosave();
  } finally {
    Object.values(autosave.assets).forEach((asset) => URL.revokeObjectURL(asset.url));
  }
}

export async function renameLibraryInktile(id: string, title: string): Promise<LibraryEntry | null> {
  const nextTitle = title.trim() || "Untitled Inktile";
  const database = await openInktileDb();
  let record: LibraryRecord | undefined;
  try {
    const transaction = database.transaction(LIBRARY_STORE, "readonly");
    record = await requestResult(transaction.objectStore(LIBRARY_STORE).get(id) as IDBRequest<LibraryRecord | undefined>);
  } finally {
    database.close();
  }
  if (!record) return null;

  const loaded = getCachedLibraryInktile(id)
    ?? (record.snapshot ? { ...loadStoredSnapshot(record.snapshot), path: record.path } : null)
    ?? { ...(await decodeInktile(record.blob)), path: record.path };
  loaded.document.title = nextTitle;
  loaded.document.modifiedAt = new Date().toISOString();
  try {
    return await saveLibraryInktile(loaded.document, loaded.assets, record.path);
  } finally {
    Object.values(loaded.assets).forEach((asset) => URL.revokeObjectURL(asset.url));
  }
}

export async function duplicateLibraryInktile(id: string): Promise<LibraryEntry | null> {
  const database = await openInktileDb();
  let record: LibraryRecord | undefined;
  try {
    const transaction = database.transaction(LIBRARY_STORE, "readonly");
    record = await requestResult(transaction.objectStore(LIBRARY_STORE).get(id) as IDBRequest<LibraryRecord | undefined>);
  } finally {
    database.close();
  }
  if (!record) return null;

  const loaded = getCachedLibraryInktile(id)
    ?? (record.snapshot ? { ...loadStoredSnapshot(record.snapshot), path: record.path } : null)
    ?? { ...(await decodeInktile(record.blob)), path: record.path };
  const now = new Date().toISOString();
  const duplicate: InktileDocument = {
    ...structuredClone(loaded.document),
    id: uuid(),
    title: `${loaded.document.title.trim() || "Untitled Inktile"} copy`,
    createdAt: now,
    modifiedAt: now
  };
  try {
    // A copy is a fresh library-only inktile, not tied to the source's external file path.
    return await saveLibraryInktile(duplicate, loaded.assets, null, { touchOpened: true });
  } finally {
    Object.values(loaded.assets).forEach((asset) => URL.revokeObjectURL(asset.url));
  }
}

const compareValues = (left: string, right: string): number => left.localeCompare(right, undefined, {
  numeric: true,
  sensitivity: "base"
});

export function sortLibraryInktiles(entries: LibraryEntry[], sort: LibrarySort, direction: SortDirection): LibraryEntry[] {
  const multiplier = direction === "ascending" ? 1 : -1;
  return [...entries].sort((left, right) => {
    const comparison = compareValues(left[sort], right[sort]);
    return comparison === 0 ? compareValues(left.title, right.title) : comparison * multiplier;
  });
}

const escapedRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Count case-insensitive substring occurrences. Matching is deliberately substring-based rather
// than whole-word so body search behaves like the title search (which uses `includes`) and the
// home view's excerpt jump/highlight: typing "note" surfaces "notebook", not just a lone "note".
export function countTextMatches(text: string, query: string): number {
  const normalized = query.trim();
  if (!normalized) return 0;
  return text.match(new RegExp(escapedRegExp(normalized), "giu"))?.length ?? 0;
}

export function searchLibraryInktiles(
  entries: LibraryEntry[],
  query: string,
  sort: LibrarySort,
  direction: SortDirection
): LibrarySearchResults {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return { titleMatches: [], textMatches: [] };

  const titleMatches = sortLibraryInktiles(
    entries.filter((entry) => entry.title.toLocaleLowerCase().includes(normalized)),
    sort,
    direction
  );
  const titleIds = new Set(titleMatches.map((entry) => entry.id));
  const textMatches = entries
    .filter((entry) => !titleIds.has(entry.id))
    .map((entry) => ({ ...entry, frequency: countTextMatches(entry.plainText, query) }))
    .filter((entry) => entry.frequency > 0)
    .sort((left, right) => right.frequency - left.frequency || compareValues(left.title, right.title));
  return { titleMatches, textMatches };
}
