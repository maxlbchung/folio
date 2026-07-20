import JSZip from "jszip";
import type { InktileDocument, RuntimeAssetMap } from "../document/types";

export interface LoadedInktile {
  document: InktileDocument;
  assets: RuntimeAssetMap;
}

function validateDocument(value: unknown): asserts value is InktileDocument {
  if (!value || typeof value !== "object") throw new Error("Invalid Inktile manifest.");
  const candidate = value as Partial<InktileDocument>;
  if (candidate.format !== "com.inktile.document") throw new Error("This is not an Inktile document.");
  if (candidate.formatVersion !== 1) throw new Error(`Unsupported Inktile version: ${candidate.formatVersion}`);
  if (!Array.isArray(candidate.pageOrder) || !candidate.pages) throw new Error("The Inktile manifest is incomplete.");
}

const encodedArchives = new WeakMap<InktileDocument, { assets: RuntimeAssetMap; archive: Promise<Blob> }>();

async function buildInktileArchive(document: InktileDocument, runtimeAssets: RuntimeAssetMap): Promise<Blob> {
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(document, null, 2));

  for (const metadata of Object.values(document.assets)) {
    const runtime = runtimeAssets[metadata.id];
    if (runtime) zip.file(metadata.internalPath, new Uint8Array(await runtime.blob.arrayBuffer()));
  }

  zip.file("README.txt", "Inktile document container. Document structure is stored in manifest.json; binary media is stored in assets/.\n");
  return zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

export function encodeInktile(document: InktileDocument, runtimeAssets: RuntimeAssetMap): Promise<Blob> {
  const cached = encodedArchives.get(document);
  if (cached?.assets === runtimeAssets) return cached.archive;
  const archive = buildInktileArchive(document, runtimeAssets);
  encodedArchives.set(document, { assets: runtimeAssets, archive });
  return archive;
}

export async function decodeInktile(input: Blob | ArrayBuffer | Uint8Array): Promise<LoadedInktile> {
  const source = input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : input;
  const zip = await JSZip.loadAsync(source);
  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry) throw new Error("Missing manifest.json.");
  const document = JSON.parse(await manifestEntry.async("string")) as unknown;
  validateDocument(document);

  const assets: RuntimeAssetMap = {};
  for (const metadata of Object.values(document.assets)) {
    const entry = zip.file(metadata.internalPath);
    if (!entry) continue;
    const bytes = await entry.async("uint8array");
    const copied = new Uint8Array(bytes.byteLength);
    copied.set(bytes);
    const blob = new Blob([copied.buffer], { type: metadata.mimeType });
    assets[metadata.id] = { metadata, blob, url: URL.createObjectURL(blob) };
  }

  return { document, assets };
}
