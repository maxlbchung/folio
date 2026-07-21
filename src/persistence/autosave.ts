import { decodeInktile, encodeInktile, type LoadedInktile } from "./inktileArchive";
import type { InktileDocument, RuntimeAssetMap } from "../document/types";
import { getStorage } from "./storage";

export interface LoadedAutosave extends LoadedInktile {
  path: string | null;
  recovery: boolean;
}

export async function writeAutosave(
  document: InktileDocument,
  assets: RuntimeAssetMap,
  path: string | null = null,
  recovery = true
): Promise<void> {
  const storage = await getStorage();
  const blob = await encodeInktile(document, assets);
  await storage.writeAutosave({ blob, path, recovery });
}

export async function readAutosave(): Promise<LoadedAutosave | null> {
  const storage = await getStorage();
  const stored = await storage.readAutosave();
  if (!stored) return null;
  const loaded = await decodeInktile(stored.blob);
  return { ...loaded, path: stored.path, recovery: stored.recovery };
}

export async function deleteAutosave(): Promise<void> {
  const storage = await getStorage();
  await storage.deleteAutosave();
}
