import { decodeFolio, encodeFolio, type LoadedFolio } from "./folioArchive";
import type { FolioDocument, RuntimeAssetMap } from "../document/types";
import { AUTOSAVE_STORE, openFolioDb } from "./database";

const KEY = "current";

interface AutosaveRecord {
  blob: Blob;
  path: string | null;
  recovery: boolean;
}

export interface LoadedAutosave extends LoadedFolio {
  path: string | null;
  recovery: boolean;
}

export async function writeAutosave(
  document: FolioDocument,
  assets: RuntimeAssetMap,
  path: string | null = null,
  recovery = true
): Promise<void> {
  const db = await openFolioDb();
  const blob = await encodeFolio(document, assets);
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(AUTOSAVE_STORE, "readwrite");
    transaction.objectStore(AUTOSAVE_STORE).put({ blob, path, recovery } satisfies AutosaveRecord, KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function readAutosave(): Promise<LoadedAutosave | null> {
  const db = await openFolioDb();
  const stored = await new Promise<Blob | AutosaveRecord | undefined>((resolve, reject) => {
    const transaction = db.transaction(AUTOSAVE_STORE, "readonly");
    const request = transaction.objectStore(AUTOSAVE_STORE).get(KEY);
    request.onsuccess = () => resolve(request.result as Blob | AutosaveRecord | undefined);
    request.onerror = () => reject(request.error);
  });
  db.close();
  if (!stored) return null;
  const legacy = stored instanceof Blob;
  const loaded = await decodeFolio(legacy ? stored : stored.blob);
  return {
    ...loaded,
    path: legacy ? null : stored.path,
    recovery: legacy || stored.recovery !== false
  };
}

export async function deleteAutosave(): Promise<void> {
  const db = await openFolioDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(AUTOSAVE_STORE, "readwrite");
    transaction.objectStore(AUTOSAVE_STORE).delete(KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}
