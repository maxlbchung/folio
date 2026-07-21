import {
  AUTOSAVE_STORE,
  LIBRARY_INDEX_STORE,
  LIBRARY_STORE,
  TAGS_STORE,
  completeTransaction,
  openInktileDb,
  requestResult
} from "../database";
import type {
  AutosaveData,
  InktileTag,
  LibraryEntry,
  LibraryRecordData,
  StorageBackend,
  StoredLibrarySnapshot
} from "./types";

/** Stored flat (entry fields + blob + snapshot) for compatibility with pre-backend data. */
interface FlatLibraryRecord extends LibraryEntry {
  blob: Blob;
  snapshot?: StoredLibrarySnapshot;
}

interface FlatAutosaveRecord {
  blob: Blob;
  path: string | null;
  recovery: boolean;
}

const AUTOSAVE_KEY = "current";

const toEntry = ({ blob: _blob, snapshot: _snapshot, ...entry }: FlatLibraryRecord): LibraryEntry => entry;

export const idbStorage: StorageBackend = {
  async listEntries() {
    const database = await openInktileDb();
    try {
      const transaction = database.transaction(LIBRARY_INDEX_STORE, "readonly");
      return await requestResult(transaction.objectStore(LIBRARY_INDEX_STORE).getAll() as IDBRequest<LibraryEntry[]>);
    } finally {
      database.close();
    }
  },

  async getEntry(id) {
    const database = await openInktileDb();
    try {
      const transaction = database.transaction(LIBRARY_INDEX_STORE, "readonly");
      const entry = await requestResult(transaction.objectStore(LIBRARY_INDEX_STORE).get(id) as IDBRequest<LibraryEntry | undefined>);
      return entry ?? null;
    } finally {
      database.close();
    }
  },

  async getRecord(id) {
    const database = await openInktileDb();
    try {
      const transaction = database.transaction(LIBRARY_STORE, "readonly");
      const record = await requestResult(transaction.objectStore(LIBRARY_STORE).get(id) as IDBRequest<FlatLibraryRecord | undefined>);
      if (!record) return null;
      return { entry: toEntry(record), blob: record.blob, snapshot: record.snapshot } satisfies LibraryRecordData;
    } finally {
      database.close();
    }
  },

  async putRecord({ entry, blob, snapshot }) {
    const database = await openInktileDb();
    try {
      const transaction = database.transaction([LIBRARY_STORE, LIBRARY_INDEX_STORE], "readwrite");
      const transactionComplete = completeTransaction(transaction);
      transaction.objectStore(LIBRARY_STORE).put({ ...entry, blob, snapshot } satisfies FlatLibraryRecord);
      transaction.objectStore(LIBRARY_INDEX_STORE).put(entry);
      await transactionComplete;
    } finally {
      database.close();
    }
  },

  async patchEntry(id, patch) {
    const database = await openInktileDb();
    try {
      const transaction = database.transaction([LIBRARY_STORE, LIBRARY_INDEX_STORE], "readwrite");
      const transactionComplete = completeTransaction(transaction);
      const store = transaction.objectStore(LIBRARY_STORE);
      const indexStore = transaction.objectStore(LIBRARY_INDEX_STORE);
      const record = await requestResult(store.get(id) as IDBRequest<FlatLibraryRecord | undefined>);
      if (record) store.put({ ...record, ...patch });
      const entry = await requestResult(indexStore.get(id) as IDBRequest<LibraryEntry | undefined>);
      const next = entry ? { ...entry, ...patch } : record ? { ...toEntry(record), ...patch } : null;
      if (next) indexStore.put(next);
      await transactionComplete;
      return next;
    } finally {
      database.close();
    }
  },

  async putSnapshot(id, modifiedAt, snapshot) {
    const database = await openInktileDb();
    try {
      const transaction = database.transaction(LIBRARY_STORE, "readwrite");
      const transactionComplete = completeTransaction(transaction);
      const store = transaction.objectStore(LIBRARY_STORE);
      const current = await requestResult(store.get(id) as IDBRequest<FlatLibraryRecord | undefined>);
      // Only cache onto the exact revision it was decoded from; a newer save wins.
      if (current?.modifiedAt === modifiedAt) {
        current.snapshot = snapshot;
        store.put(current);
      }
      await transactionComplete;
    } finally {
      database.close();
    }
  },

  async deleteRecord(id) {
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
  },

  async listTags() {
    const database = await openInktileDb();
    try {
      const transaction = database.transaction(TAGS_STORE, "readonly");
      return await requestResult(transaction.objectStore(TAGS_STORE).getAll() as IDBRequest<InktileTag[]>);
    } finally {
      database.close();
    }
  },

  async getTag(id) {
    const database = await openInktileDb();
    try {
      const transaction = database.transaction(TAGS_STORE, "readonly");
      const tag = await requestResult(transaction.objectStore(TAGS_STORE).get(id) as IDBRequest<InktileTag | undefined>);
      return tag ?? null;
    } finally {
      database.close();
    }
  },

  async putTag(tag) {
    const database = await openInktileDb();
    try {
      const transaction = database.transaction(TAGS_STORE, "readwrite");
      const transactionComplete = completeTransaction(transaction);
      transaction.objectStore(TAGS_STORE).put(tag);
      await transactionComplete;
    } finally {
      database.close();
    }
  },

  async deleteTag(id) {
    const database = await openInktileDb();
    try {
      const transaction = database.transaction(TAGS_STORE, "readwrite");
      const transactionComplete = completeTransaction(transaction);
      transaction.objectStore(TAGS_STORE).delete(id);
      await transactionComplete;
    } finally {
      database.close();
    }
  },

  async readAutosave() {
    const database = await openInktileDb();
    try {
      const transaction = database.transaction(AUTOSAVE_STORE, "readonly");
      const stored = await requestResult(
        transaction.objectStore(AUTOSAVE_STORE).get(AUTOSAVE_KEY) as IDBRequest<Blob | FlatAutosaveRecord | undefined>
      );
      if (!stored) return null;
      // Legacy records (pre path/recovery) stored the bare blob.
      if (stored instanceof Blob) return { blob: stored, path: null, recovery: true } satisfies AutosaveData;
      return { blob: stored.blob, path: stored.path, recovery: stored.recovery !== false } satisfies AutosaveData;
    } finally {
      database.close();
    }
  },

  async writeAutosave({ blob, path, recovery }) {
    const database = await openInktileDb();
    try {
      const transaction = database.transaction(AUTOSAVE_STORE, "readwrite");
      const transactionComplete = completeTransaction(transaction);
      transaction.objectStore(AUTOSAVE_STORE).put({ blob, path, recovery } satisfies FlatAutosaveRecord, AUTOSAVE_KEY);
      await transactionComplete;
    } finally {
      database.close();
    }
  },

  async deleteAutosave() {
    const database = await openInktileDb();
    try {
      const transaction = database.transaction(AUTOSAVE_STORE, "readwrite");
      const transactionComplete = completeTransaction(transaction);
      transaction.objectStore(AUTOSAVE_STORE).delete(AUTOSAVE_KEY);
      await transactionComplete;
    } finally {
      database.close();
    }
  }
};
