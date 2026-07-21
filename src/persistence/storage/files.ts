import { saveNativeFileAtomic } from "../fileSystem";
import type {
  AutosaveData,
  InktileTag,
  LibraryEntry,
  StorageBackend,
  StoredLibrarySnapshot
} from "./types";

/**
 * Desktop storage: the library lives as plain files under the app-data folder —
 *
 *   library/index.json     entry metadata (the browsable/searchable index)
 *   library/tags.json      tag definitions
 *   library/<id>.inktile   one complete archive per inktile
 *   autosave/current.*     crash-recovery archive + its {path, recovery} sidecar
 *
 * Files, unlike the webview's IndexedDB, survive quota eviction, profile wipes, and
 * identifier changes — and users can see and back them up. All writes are atomic
 * (save_file_atomic: temp sibling + rename). Blob writes land before the index that
 * references them, so a crash can orphan an archive file but never dangle an index row.
 */
export interface FileStorage extends StorageBackend {
  /** False until index.json exists — i.e. the file store has never been (re)initialized. */
  readonly initialized: boolean;
  /** Write the current (possibly empty) index and tags, marking the store initialized. */
  commitIndex(): Promise<void>;
}

const encoder = new TextEncoder();

/** Entry ids should be uuids, but archives are imported files: never trust one as a filename. */
const idToFilename = (id: string): string => `${encodeURIComponent(id).replace(/\*/g, "%2A")}.inktile`;

const cloneEntry = (entry: LibraryEntry): LibraryEntry => ({ ...entry, tags: entry.tags ? [...entry.tags] : entry.tags });

export async function createFileStorage(): Promise<FileStorage> {
  const { appDataDir, join } = await import("@tauri-apps/api/path");
  const fs = await import("@tauri-apps/plugin-fs");
  const base = await appDataDir();
  const libraryDir = await join(base, "library");
  const indexPath = await join(libraryDir, "index.json");
  const tagsPath = await join(libraryDir, "tags.json");
  const autosaveDir = await join(base, "autosave");
  const autosavePath = await join(autosaveDir, "current.inktile");
  const autosaveMetaPath = await join(autosaveDir, "current.json");

  const entries = new Map<string, LibraryEntry>();
  const tags = new Map<string, InktileTag>();

  const readJsonList = async <T extends { id: string }>(path: string, into: Map<string, T>) => {
    try {
      if (!(await fs.exists(path))) return;
      const parsed = JSON.parse(await fs.readTextFile(path)) as T[];
      if (Array.isArray(parsed)) parsed.forEach((item) => item?.id && into.set(item.id, item));
    } catch {
      // Unreadable metadata never blocks startup; archives on disk stay untouched.
    }
  };

  const initialized = await fs.exists(indexPath);
  if (initialized) {
    await readJsonList(indexPath, entries);
    await readJsonList(tagsPath, tags);
  }

  // Single mutation chain: IndexedDB transactions used to keep read-modify-write cycles
  // from interleaving; here the in-memory maps plus this queue provide the same guarantee.
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T,>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };

  const writeIndex = () => saveNativeFileAtomic(indexPath, encoder.encode(JSON.stringify([...entries.values()])));
  const writeTags = () => saveNativeFileAtomic(tagsPath, encoder.encode(JSON.stringify([...tags.values()])));
  const entryPath = (id: string) => join(libraryDir, idToFilename(id));

  return {
    initialized,

    commitIndex: () => serialize(async () => {
      await writeIndex();
      await writeTags();
    }),

    async listEntries() {
      return [...entries.values()].map(cloneEntry);
    },

    async getEntry(id) {
      const entry = entries.get(id);
      return entry ? cloneEntry(entry) : null;
    },

    async getRecord(id) {
      const entry = entries.get(id);
      if (!entry) return null;
      const path = await entryPath(id);
      if (!(await fs.exists(path))) return null;
      const bytes = await fs.readFile(path);
      return { entry: cloneEntry(entry), blob: new Blob([bytes]) };
    },

    putRecord: ({ entry, blob }) => serialize(async () => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await saveNativeFileAtomic(await entryPath(entry.id), bytes);
      entries.set(entry.id, cloneEntry(entry));
      await writeIndex();
    }),

    patchEntry: (id, patch) => serialize(async () => {
      const current = entries.get(id);
      if (!current) return null;
      const next = { ...current, ...patch };
      entries.set(id, next);
      await writeIndex();
      return cloneEntry(next);
    }),

    // Snapshots are an IndexedDB-era decode cache; local archives reopen fast without one.
    async putSnapshot(_id: string, _modifiedAt: string, _snapshot: StoredLibrarySnapshot) {},

    deleteRecord: (id) => serialize(async () => {
      if (entries.delete(id)) await writeIndex();
      await fs.remove(await entryPath(id)).catch(() => undefined);
    }),

    async listTags() {
      return [...tags.values()].map((tag) => ({ ...tag }));
    },

    async getTag(id) {
      const tag = tags.get(id);
      return tag ? { ...tag } : null;
    },

    putTag: (tag) => serialize(async () => {
      tags.set(tag.id, { ...tag });
      await writeTags();
    }),

    deleteTag: (id) => serialize(async () => {
      if (tags.delete(id)) await writeTags();
    }),

    async readAutosave() {
      if (!(await fs.exists(autosavePath))) return null;
      const bytes = await fs.readFile(autosavePath);
      let meta: Pick<AutosaveData, "path" | "recovery"> = { path: null, recovery: true };
      try {
        if (await fs.exists(autosaveMetaPath)) {
          meta = { ...meta, ...(JSON.parse(await fs.readTextFile(autosaveMetaPath)) as Partial<typeof meta>) };
        }
      } catch {
        // A lost sidecar downgrades gracefully: the archive still recovers, path-less.
      }
      return { blob: new Blob([bytes]), path: meta.path, recovery: meta.recovery !== false };
    },

    writeAutosave: ({ blob, path, recovery }) => serialize(async () => {
      await saveNativeFileAtomic(autosavePath, new Uint8Array(await blob.arrayBuffer()));
      await saveNativeFileAtomic(autosaveMetaPath, encoder.encode(JSON.stringify({ path, recovery })));
    }),

    deleteAutosave: () => serialize(async () => {
      await fs.remove(autosavePath).catch(() => undefined);
      await fs.remove(autosaveMetaPath).catch(() => undefined);
    })
  };
}
