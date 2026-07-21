import type { InktileDocument, RuntimeAssetMap } from "../document/types";
import { uuid } from "../document/factories";
import { decodeInktile, encodeInktile, type LoadedInktile } from "./inktileArchive";
import { getStorage } from "./storage";
import type { LibraryEntry, LibraryRecordData, StoredLibrarySnapshot } from "./storage/types";
import { deleteAutosave, readAutosave } from "./autosave";

export type { LibraryEntry } from "./storage/types";

export type LibrarySort = "lastOpenedAt" | "createdAt" | "modifiedAt" | "title";
export type SortDirection = "ascending" | "descending";

export interface LibrarySearchResults {
  titleMatches: LibraryEntry[];
  textMatches: Array<LibraryEntry & { frequency: number }>;
}

export interface LoadedLibraryInktile extends LoadedInktile {
  path: string | null;
}

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

const rememberRecord = (record: LibraryRecordData) => {
  const cached = libraryCache.get(record.entry.id);
  rememberEntry(record.entry);
  if (record.snapshot && (!cached || cached.entry.modifiedAt <= record.entry.modifiedAt)) {
    libraryCache.get(record.entry.id)!.snapshot = record.snapshot;
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
    pinned: cached?.entry.pinned ?? false,
    tags: cached?.entry.tags ?? []
  };
  const snapshot = createStoredSnapshot(document, assets);
  if (!cached || cached.entry.modifiedAt <= entry.modifiedAt) libraryCache.set(document.id, { entry, snapshot });
  return { entry, snapshot };
};

export async function listLibraryInktiles(): Promise<LibraryEntry[]> {
  if (!libraryIndexLoaded) {
    libraryIndexLoad ??= (async () => {
      const storage = await getStorage();
      (await storage.listEntries()).forEach(rememberEntry);
      libraryIndexLoaded = true;
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
  const storage = await getStorage();
  const existing = await storage.getEntry(document.id);
  if (existing && existing.modifiedAt > document.modifiedAt) {
    // The stored inktile is newer than this save (e.g. a stale editor flush): keep it,
    // at most stamping the open time and a learned path.
    if (options.touchOpened) {
      const patch: Partial<LibraryEntry> = { lastOpenedAt: new Date().toISOString() };
      if (path) patch.path = path;
      const updated = await storage.patchEntry(document.id, patch);
      if (updated) {
        rememberEntry(updated);
        return updated;
      }
    }
    rememberEntry(existing);
    return existing;
  }
  // A save staged before the library index warmed the cache must not drop an existing pin or tags.
  if (existing?.pinned && !staged.entry.pinned) staged.entry.pinned = true;
  if (existing?.tags?.length && !staged.entry.tags?.length) staged.entry.tags = existing.tags;
  const entry: LibraryEntry = {
    ...staged.entry,
    path: path ?? existing?.path ?? staged.entry.path
  };
  await storage.putRecord({ entry, blob, snapshot: staged.snapshot });
  rememberRecord({ entry, blob, snapshot: staged.snapshot });
  return entry;
}

export function getCachedLibraryInktile(id: string): LoadedLibraryInktile | null {
  const cached = libraryCache.get(id);
  if (!cached?.snapshot) return null;
  return { ...loadStoredSnapshot(cached.snapshot), path: cached.entry.path };
}

export async function touchLibraryInktile(id: string): Promise<void> {
  const storage = await getStorage();
  const updated = await storage.patchEntry(id, { lastOpenedAt: new Date().toISOString() });
  if (updated) rememberEntry(updated);
}

export async function setLibraryInktilePinned(id: string, pinned: boolean): Promise<void> {
  const cached = libraryCache.get(id);
  if (cached) cached.entry.pinned = pinned;
  const storage = await getStorage();
  await storage.patchEntry(id, { pinned });
}

export async function setLibraryInktileTags(id: string, tags: string[]): Promise<void> {
  const cached = libraryCache.get(id);
  if (cached) cached.entry.tags = tags;
  const storage = await getStorage();
  await storage.patchEntry(id, { tags });
}

/** Strip a deleted tag's id from every stored record and the in-memory cache. */
export async function removeTagFromAllLibraryInktiles(tagId: string): Promise<void> {
  for (const cached of libraryCache.values()) {
    if (cached.entry.tags?.includes(tagId)) cached.entry.tags = cached.entry.tags.filter((id) => id !== tagId);
  }
  const storage = await getStorage();
  for (const entry of await storage.listEntries()) {
    if (entry.tags?.includes(tagId)) {
      await storage.patchEntry(entry.id, { tags: entry.tags.filter((id) => id !== tagId) });
    }
  }
}

export async function openLibraryInktile(id: string): Promise<LoadedLibraryInktile | null> {
  const cached = getCachedLibraryInktile(id);
  if (cached) return cached;
  const storage = await getStorage();
  const record = await storage.getRecord(id);
  if (!record) return null;
  rememberRecord(record);
  if (record.snapshot) return { ...loadStoredSnapshot(record.snapshot), path: record.entry.path };

  const loaded = await decodeInktile(record.blob);
  const snapshot = createStoredSnapshot(loaded.document, loaded.assets);
  libraryCache.set(id, { entry: record.entry, snapshot });
  void storage.putSnapshot(id, record.entry.modifiedAt, snapshot).catch(() => undefined);
  return { ...loaded, path: record.entry.path };
}

export async function deleteLibraryInktile(id: string): Promise<void> {
  libraryCache.delete(id);
  const storage = await getStorage();
  await storage.deleteRecord(id);

  const autosave = await readAutosave().catch(() => null);
  if (!autosave) return;
  try {
    if (autosave.document.id === id) await deleteAutosave();
  } finally {
    Object.values(autosave.assets).forEach((asset) => URL.revokeObjectURL(asset.url));
  }
}

/** Load a record's document for derived edits (rename, duplicate), snapshot-first. */
async function loadRecordDocument(record: LibraryRecordData): Promise<LoadedLibraryInktile> {
  return getCachedLibraryInktile(record.entry.id)
    ?? (record.snapshot ? { ...loadStoredSnapshot(record.snapshot), path: record.entry.path } : null)
    ?? { ...(await decodeInktile(record.blob)), path: record.entry.path };
}

export async function renameLibraryInktile(id: string, title: string): Promise<LibraryEntry | null> {
  const nextTitle = title.trim() || "Untitled Inktile";
  const storage = await getStorage();
  const record = await storage.getRecord(id);
  if (!record) return null;

  const loaded = await loadRecordDocument(record);
  loaded.document.title = nextTitle;
  loaded.document.modifiedAt = new Date().toISOString();
  try {
    return await saveLibraryInktile(loaded.document, loaded.assets, record.entry.path);
  } finally {
    Object.values(loaded.assets).forEach((asset) => URL.revokeObjectURL(asset.url));
  }
}

export async function duplicateLibraryInktile(id: string): Promise<LibraryEntry | null> {
  const storage = await getStorage();
  const record = await storage.getRecord(id);
  if (!record) return null;

  const loaded = await loadRecordDocument(record);
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
