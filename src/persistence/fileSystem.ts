import { decodeInktile, encodeInktile, type LoadedInktile } from "./inktileArchive";
import type { InktileDocument, RuntimeAssetMap } from "../document/types";

export interface SaveResult {
  path: string | null;
  cancelled: boolean;
  wroteFile: boolean;
}

export interface OpenResult extends LoadedInktile {
  path: string | null;
}

const isTauri = () => Boolean(window.__TAURI_INTERNALS__);

export type SaveAction = "download" | "library" | "overwrite" | "save-as";

/**
 * Normal Save never creates a file: it overwrites the known native path or confirms the
 * local-library snapshot (the browser cannot retain a writable path at all). Only the
 * explicit export/Save As gesture (forceDialog) produces a new file — a destination
 * dialog natively, a download in the browser.
 */
export function resolveSaveAction(
  native: boolean,
  existingPath: string | null,
  forceDialog = false
): SaveAction {
  if (forceDialog) return native ? "save-as" : "download";
  if (!native) return "library";
  return existingPath ? "overwrite" : "library";
}

/** Title reduced to a legal filename stem; shared by the .inktile and .txt exports. */
export function safeBaseName(title: string): string {
  const cleaned = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").trim();
  return cleaned || "Untitled Inktile";
}

function safeFilename(title: string): string {
  return `${safeBaseName(title)}.inktile`;
}

/**
 * Write bytes to a temp sibling and rename it over the target so a crash mid-write can
 * never leave a truncated archive at `path` (std rename replaces existing files on both
 * Windows and Unix).
 */
async function writeNativeFileAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const { writeFile, rename } = await import("@tauri-apps/plugin-fs");
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, bytes, { append: false, create: true, createNew: false });
  await rename(tmpPath, path);
}

/** Overwrite a known native path with the current document. Native (Tauri) shells only. */
export async function overwriteDocumentPath(
  document: InktileDocument,
  assets: RuntimeAssetMap,
  path: string
): Promise<void> {
  const blob = await encodeInktile(document, assets);
  await writeNativeFileAtomic(path, new Uint8Array(await blob.arrayBuffer()));
}

export async function saveDocumentFile(
  document: InktileDocument,
  assets: RuntimeAssetMap,
  existingPath: string | null,
  forceDialog = false
): Promise<SaveResult> {
  const native = isTauri();
  const action = resolveSaveAction(native, existingPath, forceDialog);
  if (action === "library") {
    return { path: existingPath, cancelled: false, wroteFile: false };
  }

  const blob = await encodeInktile(document, assets);

  if (native) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = action === "overwrite" ? existingPath : await save({
      defaultPath: safeFilename(document.title),
      filters: [{ name: "Inktile document", extensions: ["inktile"] }]
    });
    if (!path) return { path: existingPath, cancelled: true, wroteFile: false };
    await writeNativeFileAtomic(path, new Uint8Array(await blob.arrayBuffer()));
    return { path, cancelled: false, wroteFile: true };
  }

  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = safeFilename(document.title);
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { path: null, cancelled: false, wroteFile: true };
}

/** Open a browser File (e.g. dropped via HTML5 drag and drop); no writable path is retained. */
export async function openDocumentBlob(file: Blob): Promise<OpenResult> {
  return { ...(await decodeInktile(file)), path: null };
}

/** Open an absolute path (e.g. dropped onto the native window). Native (Tauri) shells only. */
export async function openDocumentPath(path: string): Promise<OpenResult> {
  const { readFile } = await import("@tauri-apps/plugin-fs");
  return { ...(await decodeInktile(await readFile(path))), path };
}

export async function openDocumentFile(): Promise<OpenResult | null> {
  if (isTauri()) {
    const [{ open }, { readFile }] = await Promise.all([
      import("@tauri-apps/plugin-dialog"),
      import("@tauri-apps/plugin-fs")
    ]);
    const path = await open({ multiple: false, filters: [{ name: "Inktile document", extensions: ["inktile"] }] });
    if (!path || Array.isArray(path)) return null;
    const bytes = await readFile(path);
    return { ...(await decodeInktile(bytes)), path };
  }

  return new Promise((resolve, reject) => {
    const input = window.document.createElement("input");
    input.type = "file";
    input.accept = ".inktile,application/zip";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        resolve({ ...(await decodeInktile(file)), path: null });
      } catch (error) {
        reject(error);
      }
    };
    input.click();
  });
}
