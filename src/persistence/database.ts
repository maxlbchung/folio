export const INKTILE_DB_NAME = "inktile-editor";
export const INKTILE_DB_VERSION = 3;
export const AUTOSAVE_STORE = "autosave";
export const LIBRARY_STORE = "library";
export const LIBRARY_INDEX_STORE = "library-index";

export function openInktileDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(INKTILE_DB_NAME, INKTILE_DB_VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      if (!database.objectStoreNames.contains(AUTOSAVE_STORE)) database.createObjectStore(AUTOSAVE_STORE);
      if (!database.objectStoreNames.contains(LIBRARY_STORE)) database.createObjectStore(LIBRARY_STORE, { keyPath: "id" });
      const indexStore = database.objectStoreNames.contains(LIBRARY_INDEX_STORE)
        ? request.transaction!.objectStore(LIBRARY_INDEX_STORE)
        : database.createObjectStore(LIBRARY_INDEX_STORE, { keyPath: "id" });

      if ((event as IDBVersionChangeEvent).oldVersion < 3) {
        const cursorRequest = request.transaction!.objectStore(LIBRARY_STORE).openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const { blob: _blob, snapshot: _snapshot, ...entry } = cursor.value as Record<string, unknown>;
          indexStore.put(entry);
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
