import { idbStorage } from "./idb";
import type { FileStorage } from "./files";
import type { StorageBackend } from "./types";

export type {
  AutosaveData,
  InktileTag,
  LibraryEntry,
  LibraryRecordData,
  StorageBackend,
  StoredLibrarySnapshot
} from "./types";

const isTauri = () => Boolean(window.__TAURI_INTERNALS__);

let storagePromise: Promise<StorageBackend> | null = null;
let usingEvictableFallback = false;

/** True when the desktop shell had to fall back to evictable browser storage. */
export const storageIsEvictable = (): boolean => usingEvictableFallback;

/**
 * Web: IndexedDB — the only browser store fit for blob archives; eviction risk is
 * mitigated by the persist() request in App. Desktop: real files under app-data,
 * because a webview's IndexedDB is quota-evictable cache from the OS's point of
 * view, and a full C: drive once silently deleted the entire library.
 */
export function getStorage(): Promise<StorageBackend> {
  storagePromise ??= (async () => {
    if (!isTauri()) return idbStorage;
    try {
      const { createFileStorage } = await import("./files");
      const files = await createFileStorage();
      if (!files.initialized) {
        // Best-effort: a migration failure must not block startup on a fresh install.
        await migrateFromIndexedDb(files).catch(() => undefined);
        await files.commitIndex();
      }
      return files;
    } catch (error) {
      // A broken file store must not brick the app: run on IndexedDB and let the
      // shell surface the durability warning (storageIsEvictable → App's banner).
      console.warn("Inktile file storage is unavailable; falling back to IndexedDB.", error);
      usingEvictableFallback = true;
      return idbStorage;
    }
  })();
  return storagePromise;
}

/** One-time port of any desktop data still living in the webview's IndexedDB. */
async function migrateFromIndexedDb(files: FileStorage): Promise<void> {
  for (const entry of await idbStorage.listEntries()) {
    const record = await idbStorage.getRecord(entry.id).catch(() => null);
    if (record) await files.putRecord(record);
  }
  for (const tag of await idbStorage.listTags()) {
    await files.putTag(tag);
  }
  const autosave = await idbStorage.readAutosave().catch(() => null);
  if (autosave) await files.writeAutosave(autosave);
}
