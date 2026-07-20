import type {
  Block,
  DrawingBlock,
  InktileDocument,
  InktilePage,
  PageType,
  TextBlock,
  VariantGroupBlock
} from "./types";

export const uuid = (): string => {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
};

export const createTextBlock = (html = ""): TextBlock => ({
  id: uuid(),
  type: "text",
  html
});

export const MIN_DRAWING_HEIGHT = 240;

/** Smallest a media (image/video) page/row may shrink to; media fills its page. */
export const MIN_MEDIA_HEIGHT = 120;

// The single-column versions rail (.variant-toolbar) renders 6 stacked controls and
// measures ~158px tall (5 buttons @24px + 1 progress label @20px + 5 * 2px gaps + 3px
// top/bottom padding + 1px top/bottom border = 158px, confirmed by live measurement).
// Add the 3px top rail offset (.variant-toolbar { top: 3px }) plus matching 3px of
// bottom breathing room so the card never clips the rail: 3 + 158 + 3 = 164.
/** Smallest a versions page/row may shrink to; keeps the control rail inside the card. */
export const MIN_VERSIONS_HEIGHT = 164;

export const createDrawingBlock = (height = MIN_DRAWING_HEIGHT): DrawingBlock => ({
  id: uuid(),
  type: "drawing",
  height,
  strokes: []
});

export const createVariantBlock = (): VariantGroupBlock => ({
  id: uuid(),
  type: "variants",
  activeVariant: 0,
  variants: [
    { id: uuid(), label: "", html: "" },
    { id: uuid(), label: "", html: "" }
  ]
});

export const createPage = (type: PageType = "standard", block?: Block): InktilePage => {
  const page: InktilePage = {
    id: uuid(),
    type,
    front: { blocks: type === "standard" ? [block ?? createTextBlock()] : [] },
    activeSide: "front",
    verticalAlign: "top"
  };
  if (type === "drawing") page.drawing = createDrawingBlock();
  return page;
};

export const createBlockPage = (block: Block): InktilePage => {
  if (block.type === "drawing") {
    const page = createPage("drawing");
    page.drawing = block;
    return page;
  }
  const page = createPage("standard", block);
  // Media fills its page, so a new image/video page starts at the block's height.
  if (block.type === "image" || block.type === "video") page.layoutHeight = block.height ?? 420;
  return page;
};

export const createDocument = (): InktileDocument => {
  const now = new Date().toISOString();
  return {
    format: "com.inktile.document",
    formatVersion: 1,
    id: uuid(),
    title: "Untitled Inktile",
    createdAt: now,
    modifiedAt: now,
    settings: {
      pageWidth: 760,
      contentPadding: 34
    },
    pageOrder: [],
    pageRows: [],
    pages: {},
    assets: {}
  };
};

/** Splits documents made by older builds into the one-component-per-page model. */
export const normalizeDocumentPages = (source: InktileDocument): InktileDocument => {
  const document = structuredClone(source);
  const pageOrder: string[] = [];

  for (const pageId of document.pageOrder) {
    const page = document.pages[pageId];
    if (!page) continue;
    page.verticalAlign ??= "top";
    // Older media pages sized themselves through the block's `height`. Seed the page's
    // shared `layoutHeight` from it so those documents keep their visual size.
    const mediaBlock = page.front.blocks[0];
    if (
      page.type === "standard" &&
      page.front.blocks.length === 1 &&
      (mediaBlock?.type === "image" || mediaBlock?.type === "video") &&
      page.layoutHeight === undefined &&
      typeof mediaBlock.height === "number" &&
      Number.isFinite(mediaBlock.height) &&
      mediaBlock.height > 0
    ) {
      page.layoutHeight = mediaBlock.height;
    }
    if (page.type === "drawing" || page.front.blocks.length <= 1) {
      pageOrder.push(pageId);
      continue;
    }

    const [first, ...remaining] = page.front.blocks;
    page.front.blocks = [first];
    pageOrder.push(pageId);
    for (const block of remaining) {
      const componentPage = createBlockPage(block);
      document.pages[componentPage.id] = componentPage;
      pageOrder.push(componentPage.id);
    }
  }

  const validPageIds = new Set(pageOrder);
  const seenPageIds = new Set<string>();
  const sourceRows = Array.isArray(document.pageRows) && document.pageRows.length
    ? document.pageRows
    : pageOrder.map((pageId) => [pageId]);
  const pageRows: string[][] = [];

  for (const sourceRow of sourceRows) {
    if (!Array.isArray(sourceRow)) continue;
    const row = sourceRow.filter((pageId) => validPageIds.has(pageId) && !seenPageIds.has(pageId));
    row.forEach((pageId) => seenPageIds.add(pageId));
    for (let index = 0; index < row.length; index += 4) pageRows.push(row.slice(index, index + 4));
  }
  for (const pageId of pageOrder) {
    if (!seenPageIds.has(pageId)) pageRows.push([pageId]);
  }

  document.pageRows = pageRows;
  document.pageOrder = pageRows.flat();

  // Normalize per-row width fractions. Absent means the row divides equally, so a
  // single-page row keeps no meaningful fraction and any invalid or non-normalized
  // multi-page row is reset to the equal-split default by dropping the fields.
  for (const row of pageRows) {
    const rowPages = row.map((pageId) => document.pages[pageId]).filter((page): page is InktilePage => Boolean(page));
    if (rowPages.length <= 1) {
      rowPages.forEach((page) => { delete page.layoutWidthFraction; });
      continue;
    }
    const fractions = rowPages.map((page) => page.layoutWidthFraction);
    const valid = fractions.every((fraction) => typeof fraction === "number" && Number.isFinite(fraction) && fraction > 0);
    const sum = valid ? (fractions as number[]).reduce((total, fraction) => total + fraction, 0) : 0;
    if (!valid || Math.abs(sum - 1) > 0.001) {
      rowPages.forEach((page) => { delete page.layoutWidthFraction; });
    }
  }

  return document;
};

export const cloneBlock = (block: Block): Block => {
  const copy = structuredClone(block);
  copy.id = uuid();
  if (copy.type === "variants") {
    copy.variants = copy.variants.map((variant) => ({ ...variant, id: uuid() }));
  }
  if (copy.type === "drawing") {
    copy.strokes = copy.strokes.map((stroke) => ({ ...stroke, id: uuid() }));
  }
  return copy;
};

/** Deep-copies a page with fresh page/block/stroke ids; asset references stay shared. */
export const clonePage = (source: InktilePage, id = uuid()): InktilePage => {
  const copy = structuredClone(source);
  copy.id = id;
  copy.front.blocks = copy.front.blocks.map(cloneBlock);
  if (copy.back) copy.back.blocks = copy.back.blocks.map(cloneBlock);
  if (copy.drawing) copy.drawing = cloneBlock(copy.drawing) as DrawingBlock;
  // The copy lands in its own row, so it carries no shared-row width split.
  delete copy.layoutWidthFraction;
  return copy;
};
