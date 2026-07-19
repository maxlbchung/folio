import { decodeFolio, encodeFolio, type LoadedFolio } from "./folioArchive";
import type { FolioDocument, RuntimeAssetMap } from "../document/types";

export interface SaveResult {
  path: string | null;
  cancelled: boolean;
}

export interface OpenResult extends LoadedFolio {
  path: string | null;
}

const isTauri = () => Boolean(window.__TAURI_INTERNALS__);

function safeFilename(title: string): string {
  const cleaned = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").trim();
  return `${cleaned || "Untitled Folio"}.folio`;
}

export async function saveDocumentFile(
  document: FolioDocument,
  assets: RuntimeAssetMap,
  existingPath: string | null,
  forceDialog = false
): Promise<SaveResult> {
  const blob = await encodeFolio(document, assets);

  if (isTauri()) {
    const [{ save }, { writeFile }] = await Promise.all([
      import("@tauri-apps/plugin-dialog"),
      import("@tauri-apps/plugin-fs")
    ]);
    const path = !forceDialog && existingPath ? existingPath : await save({
      defaultPath: safeFilename(document.title),
      filters: [{ name: "Folio document", extensions: ["folio"] }]
    });
    if (!path) return { path: existingPath, cancelled: true };
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()), {
      append: false,
      create: true,
      createNew: false
    });
    return { path, cancelled: false };
  }

  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = safeFilename(document.title);
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { path: null, cancelled: false };
}

export async function openDocumentFile(): Promise<OpenResult | null> {
  if (isTauri()) {
    const [{ open }, { readFile }] = await Promise.all([
      import("@tauri-apps/plugin-dialog"),
      import("@tauri-apps/plugin-fs")
    ]);
    const path = await open({ multiple: false, filters: [{ name: "Folio document", extensions: ["folio"] }] });
    if (!path || Array.isArray(path)) return null;
    const bytes = await readFile(path);
    return { ...(await decodeFolio(bytes)), path };
  }

  return new Promise((resolve, reject) => {
    const input = window.document.createElement("input");
    input.type = "file";
    input.accept = ".folio,application/zip";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        resolve({ ...(await decodeFolio(file)), path: null });
      } catch (error) {
        reject(error);
      }
    };
    input.click();
  });
}
