import type { InktileDocument } from "../../document/types";

/** Metadata for one library inktile; the full record pairs it with the archive blob. */
export interface LibraryEntry {
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
  /** Ids of InktileTag definitions (see persistence/tags.ts) applied to this inktile. */
  tags?: string[];
}

/** Decoded-document cache attached to a record so reopening skips the unzip. */
export interface StoredLibrarySnapshot {
  document: InktileDocument;
  assetBlobs: Record<string, Blob>;
}

export interface LibraryRecordData {
  entry: LibraryEntry;
  blob: Blob;
  snapshot?: StoredLibrarySnapshot;
}

/** A library-wide tag definition; inktiles reference tags by id (LibraryEntry.tags). */
export interface InktileTag {
  id: string;
  name: string;
  color: string;
  createdAt: string;
}

export interface AutosaveData {
  blob: Blob;
  path: string | null;
  recovery: boolean;
}

/**
 * Where the library, tags, and autosave actually live. Web uses IndexedDB (the only
 * browser store fit for blob archives); desktop uses real files under the app-data
 * folder — browser storage is best-effort and quota-evictable (a full disk once
 * silently deleted the whole library), files are not. See storage/index.ts.
 */
export interface StorageBackend {
  listEntries(): Promise<LibraryEntry[]>;
  getEntry(id: string): Promise<LibraryEntry | null>;
  getRecord(id: string): Promise<LibraryRecordData | null>;
  putRecord(record: LibraryRecordData): Promise<void>;
  /** Apply a metadata patch to a stored entry; returns the updated entry, null when absent. */
  patchEntry(id: string, patch: Partial<LibraryEntry>): Promise<LibraryEntry | null>;
  /** Attach a decoded snapshot to an unchanged record. A cache: backends may ignore it. */
  putSnapshot(id: string, modifiedAt: string, snapshot: StoredLibrarySnapshot): Promise<void>;
  deleteRecord(id: string): Promise<void>;
  listTags(): Promise<InktileTag[]>;
  getTag(id: string): Promise<InktileTag | null>;
  putTag(tag: InktileTag): Promise<void>;
  deleteTag(id: string): Promise<void>;
  readAutosave(): Promise<AutosaveData | null>;
  writeAutosave(data: AutosaveData): Promise<void>;
  deleteAutosave(): Promise<void>;
}
