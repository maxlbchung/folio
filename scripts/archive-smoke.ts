import assert from "node:assert/strict";
import { createDocument, createPage, normalizeDocumentPages, uuid } from "../src/document/factories";
import { decodeFolio, encodeFolio } from "../src/persistence/folioArchive";
import { FOLIO_DB_VERSION, LIBRARY_INDEX_STORE } from "../src/persistence/database";
import type { AssetMetadata, RuntimeAssetMap } from "../src/document/types";

const document = createDocument();
assert.equal(FOLIO_DB_VERSION, 3, "library payload/index separation uses database schema version 3");
assert.equal(LIBRARY_INDEX_STORE, "library-index", "library metadata has a dedicated lightweight store");
const firstPage = createPage();
const secondPage = createPage("drawing");
firstPage.layoutHeight = 420;
secondPage.layoutHeight = 420;
firstPage.layoutWidthFraction = 0.62;
secondPage.layoutWidthFraction = 0.38;
document.pages[firstPage.id] = firstPage;
document.pages[secondPage.id] = secondPage;
document.pageOrder.push(firstPage.id, secondPage.id);
document.pageRows.push([firstPage.id, secondPage.id]);
document.title = "Archive smoke test";

const assetId = uuid();
const blob = new Blob(["folio asset payload"], { type: "text/plain" });
const metadata: AssetMetadata = {
  id: assetId,
  filename: "sample.txt",
  mimeType: "text/plain",
  byteLength: blob.size,
  hash: "test-hash",
  internalPath: `assets/${assetId}.txt`
};
document.assets[assetId] = metadata;
const assets: RuntimeAssetMap = {
  [assetId]: { metadata, blob, url: URL.createObjectURL(blob) }
};

const archive = await encodeFolio(document, assets);
assert.ok(archive.size > blob.size, "archive should contain the manifest and asset");
assert.strictEqual(
  await encodeFolio(document, assets),
  archive,
  "unchanged document and asset state reuses one encoded archive across persistence targets"
);
const restored = await decodeFolio(archive);
assert.equal(restored.document.format, "com.folio.document");
assert.equal(restored.document.formatVersion, 1);
assert.equal(restored.document.title, "Archive smoke test");
assert.equal(restored.document.pageOrder.length, 2);
assert.deepEqual(restored.document.pageRows, [[firstPage.id, secondPage.id]]);
assert.equal(restored.document.pages[firstPage.id].layoutHeight, 420);
assert.equal(restored.document.pages[firstPage.id].layoutWidthFraction, 0.62);
assert.equal(restored.document.pages[secondPage.id].layoutWidthFraction, 0.38);
assert.equal(await restored.assets[assetId].blob.text(), "folio asset payload");

// A valid custom split survives normalization unchanged.
const normalizedCustom = normalizeDocumentPages(restored.document);
assert.equal(normalizedCustom.pages[firstPage.id].layoutWidthFraction, 0.62);
assert.equal(normalizedCustom.pages[secondPage.id].layoutWidthFraction, 0.38);

// A legacy-shaped document without width fractions normalizes to an equal split
// (fields stay absent so the row divides equally at render time).
const legacy = createDocument();
const legacyLeft = createPage();
const legacyRight = createPage();
legacy.pages[legacyLeft.id] = legacyLeft;
legacy.pages[legacyRight.id] = legacyRight;
legacy.pageOrder.push(legacyLeft.id, legacyRight.id);
legacy.pageRows.push([legacyLeft.id, legacyRight.id]);
const normalizedLegacy = normalizeDocumentPages(legacy);
assert.equal(normalizedLegacy.pages[legacyLeft.id].layoutWidthFraction, undefined);
assert.equal(normalizedLegacy.pages[legacyRight.id].layoutWidthFraction, undefined);

// A legacy media page carrying only the block `height` (no `layoutHeight`) has its shared
// page height seeded from the block, and the value survives an archive round trip.
const legacyMedia = createDocument();
const legacyMediaPage = createPage("standard", { id: uuid(), type: "image", assetId: uuid(), height: 360, fit: "contain", alt: "legacy" });
delete legacyMediaPage.layoutHeight;
legacyMedia.pages[legacyMediaPage.id] = legacyMediaPage;
legacyMedia.pageOrder.push(legacyMediaPage.id);
legacyMedia.pageRows.push([legacyMediaPage.id]);
const normalizedMedia = normalizeDocumentPages(legacyMedia);
assert.equal(normalizedMedia.pages[legacyMediaPage.id].layoutHeight, 360, "legacy media height seeds layoutHeight");
const mediaArchive = await encodeFolio(normalizedMedia, {});
const restoredMedia = await decodeFolio(mediaArchive);
assert.equal(restoredMedia.document.pages[legacyMediaPage.id].layoutHeight, 360, "round trip preserves the media page height");

// An invalid custom split (does not sum to 1) is reset to the equal-split default.
const broken = createDocument();
const brokenLeft = createPage();
const brokenRight = createPage();
brokenLeft.layoutWidthFraction = 0.9;
brokenRight.layoutWidthFraction = 0.9;
broken.pages[brokenLeft.id] = brokenLeft;
broken.pages[brokenRight.id] = brokenRight;
broken.pageOrder.push(brokenLeft.id, brokenRight.id);
broken.pageRows.push([brokenLeft.id, brokenRight.id]);
const normalizedBroken = normalizeDocumentPages(broken);
assert.equal(normalizedBroken.pages[brokenLeft.id].layoutWidthFraction, undefined);
assert.equal(normalizedBroken.pages[brokenRight.id].layoutWidthFraction, undefined);

URL.revokeObjectURL(assets[assetId].url);
URL.revokeObjectURL(restored.assets[assetId].url);
console.log("Archive round trip passed.");
