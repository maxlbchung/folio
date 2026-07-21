import { flushSync } from "react-dom";
import type { DocumentContextValue } from "../document/DocumentContext";
import { MIN_DRAWING_HEIGHT, MIN_MEDIA_HEIGHT, MIN_VERSIONS_HEIGHT, uuid } from "../document/factories";
import { detectMediaPageType } from "../document/mediaTypes";
import type { DrawingBlock, DrawingStroke, InktileDocument, InktilePage, RuntimeAssetMap, VariantGroupBlock } from "../document/types";
import type {
  AgentDocumentSnapshot,
  AgentOp,
  AgentOpErrorCode,
  AgentOpResult,
  AgentPageSnapshot,
  AgentStroke,
  AgentStrokeSummary
} from "./protocol";

const MIN_ROW_HEIGHT = 96;
const MAX_ROW_HEIGHT = 1600;
const MAX_VARIANTS = 20;
const MAX_STROKES = 500;
const MAX_STROKE_POINTS = 20000;

export class AgentOpError extends Error {
  code: AgentOpErrorCode;
  constructor(code: AgentOpErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const notesHtml = (page: InktilePage): string | undefined => {
  const block = page.back?.blocks.find((item) => item.type === "text");
  return block && block.type === "text" ? block.html : undefined;
};

/** Intrinsic media dimensions per asset id, measured once from the asset bytes
 * (asset content is immutable). Only successes are cached so a failed decode
 * can retry when the asset becomes readable again. */
const assetDimensions = new Map<string, { width: number; height: number }>();

const MEASURE_TIMEOUT_MS = 3000;

/** Decodes an image or video just far enough to learn its intrinsic pixel size. */
const measureMediaUrl = (url: string, kind: "image" | "video") =>
  new Promise<{ width: number; height: number } | null>((resolve) => {
    const timer = window.setTimeout(() => resolve(null), MEASURE_TIMEOUT_MS);
    const settle = (width: number, height: number) => {
      window.clearTimeout(timer);
      resolve(width > 0 && height > 0 ? { width, height } : null);
    };
    if (kind === "image") {
      const image = new Image();
      image.onload = () => settle(image.naturalWidth, image.naturalHeight);
      image.onerror = () => settle(0, 0);
      image.src = url;
    } else {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => settle(video.videoWidth, video.videoHeight);
      video.onerror = () => settle(0, 0);
      video.src = url;
    }
  });

const measureAsset = async (assetId: string, assets: RuntimeAssetMap, kind: "image" | "video") => {
  const cached = assetDimensions.get(assetId);
  if (cached) return cached;
  const url = assets[assetId]?.url;
  if (!url) return null;
  const size = await measureMediaUrl(url, kind);
  if (size) assetDimensions.set(assetId, size);
  return size;
};

const round2 = (value: number) => Math.round(value * 100) / 100;
const round3 = (value: number) => Math.round(value * 1000) / 1000;

const strokeSummary = (stroke: DrawingStroke): AgentStrokeSummary => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  stroke.points.forEach((point) => {
    x0 = Math.min(x0, point.x);
    y0 = Math.min(y0, point.y);
    x1 = Math.max(x1, point.x);
    y1 = Math.max(y1, point.y);
  });
  return {
    id: stroke.id,
    tool: stroke.tool,
    width: stroke.width,
    opacity: round3(stroke.opacity),
    pointCount: stroke.points.length,
    bounds: stroke.points.length
      ? { x0: round2(x0), y0: round2(y0), x1: round2(x1), y1: round2(y1) }
      : { x0: 0, y0: 0, x1: 0, y1: 0 }
  };
};

const mediaBlockOf = (page: InktilePage) => {
  const block = page.type === "drawing" ? undefined : page.front.blocks[0];
  return block && (block.type === "image" || block.type === "video") ? block : undefined;
};

const pageSnapshot = (document: InktileDocument, page: InktilePage, widthPx: number): AgentPageSnapshot => {
  const shared = {
    height: page.layoutHeight,
    widthFraction: page.layoutWidthFraction,
    widthPx,
    align: page.verticalAlign,
    notesHtml: notesHtml(page)
  } satisfies Partial<AgentPageSnapshot>;
  if (page.type === "drawing") {
    const strokes = page.drawing?.strokes ?? [];
    return {
      id: page.id,
      component: "drawing",
      ...shared,
      drawing: {
        height: page.drawing?.height ?? MIN_DRAWING_HEIGHT,
        strokeCount: strokes.length,
        strokes: strokes.map(strokeSummary)
      }
    };
  }
  const block = page.front.blocks[0];
  if (!block) return { id: page.id, component: "empty", ...shared };
  if (block.type === "text") return { id: page.id, component: "text", html: block.html, ...shared };
  if (block.type === "variants") {
    return {
      id: page.id,
      component: "versions",
      ...shared,
      variants: block.variants.map((variant) => ({ label: variant.label, html: variant.html })),
      activeVariant: block.activeVariant
    };
  }
  if (block.type === "image" || block.type === "video" || block.type === "audio") {
    const metadata = document.assets[block.assetId];
    const size = assetDimensions.get(block.assetId);
    return {
      id: page.id,
      component: block.type,
      ...shared,
      alt: block.type === "image" ? block.alt : undefined,
      asset: metadata
        ? { id: metadata.id, filename: metadata.filename, mimeType: metadata.mimeType, byteLength: metadata.byteLength, ...size }
        : undefined
    };
  }
  return { id: page.id, component: "empty", ...shared };
};

const documentSnapshot = async (document: InktileDocument, assets: RuntimeAssetMap): Promise<AgentDocumentSnapshot> => {
  const pages = document.pageOrder
    .map((pageId) => document.pages[pageId])
    .filter((page): page is InktilePage => Boolean(page));
  // Measure intrinsic media dimensions up front (cached across reads) so every
  // media snapshot reports them alongside the tile's rendered size.
  await Promise.all(pages.map(async (page) => {
    const block = mediaBlockOf(page);
    if (block) await measureAsset(block.assetId, assets, block.type);
  }));
  const rowShare = new Map<string, number>();
  document.pageRows.forEach((row) => row.forEach((pageId) => {
    rowShare.set(pageId, document.pages[pageId]?.layoutWidthFraction ?? 1 / row.length);
  }));
  return {
    id: document.id,
    title: document.title,
    pageWidth: document.settings.pageWidth,
    pageRows: document.pageRows.map((row) => [...row]),
    pages: pages.map((page) => pageSnapshot(document, page, Math.round(document.settings.pageWidth * (rowShare.get(page.id) ?? 1))))
  };
};

const requireRevision = (baseRevision: number, context: DocumentContextValue) => {
  if (baseRevision !== context.getRevision()) {
    throw new AgentOpError("revision", `The document changed (expected revision ${baseRevision}, current ${context.getRevision()}). Call read_document and retry from current state.`);
  }
};

const requirePage = (context: DocumentContextValue, pageId: string): InktilePage => {
  const page = context.getDocumentSnapshot().pages[pageId];
  if (!page) throw new AgentOpError("not-found", `No page with id ${pageId}.`);
  return page;
};

const requireTextPage = (context: DocumentContextValue, pageId: string) => {
  const page = requirePage(context, pageId);
  const block = page.type === "standard" ? page.front.blocks[0] : undefined;
  if (!block || block.type !== "text") {
    throw new AgentOpError("invalid", `Page ${pageId} is not a text page; every page owns exactly one component.`);
  }
  return block;
};

const requireVersionsBlock = (context: DocumentContextValue, pageId: string): VariantGroupBlock => {
  const page = requirePage(context, pageId);
  const block = page.type === "standard" ? page.front.blocks[0] : undefined;
  if (!block || block.type !== "variants") {
    throw new AgentOpError("invalid", `Page ${pageId} is not a versions page.`);
  }
  return block;
};

const requireDrawing = (context: DocumentContextValue, pageId: string): { page: InktilePage; drawing: DrawingBlock } => {
  const page = requirePage(context, pageId);
  if (page.type !== "drawing" || !page.drawing) throw new AgentOpError("invalid", `Page ${pageId} is not a drawing page.`);
  return { page, drawing: page.drawing };
};

const requireStrokeIds = (input: string[], drawing: DrawingBlock): Set<string> => {
  if (!Array.isArray(input) || input.length === 0) throw new AgentOpError("invalid", "Provide at least one stroke id.");
  const ids = new Set(input.map(String));
  const existing = new Set(drawing.strokes.map((stroke) => stroke.id));
  const missing = [...ids].filter((id) => !existing.has(id));
  if (missing.length) {
    throw new AgentOpError("not-found", `No stroke(s) ${missing.join(", ")} on this page; call read_drawing for current stroke ids.`);
  }
  return ids;
};

const requireRow = (context: DocumentContextValue, pageId: string): string[] => {
  requirePage(context, pageId);
  const row = context.getDocumentSnapshot().pageRows.find((candidate) => candidate.includes(pageId));
  if (!row) throw new AgentOpError("not-found", `Page ${pageId} is not placed in any row.`);
  return [...row];
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Mirrors PageStack's minimumRowHeight: the same content floor the user's
 * drag gesture enforces, derived from page types. (The UI additionally raises
 * text/versions floors to their measured DOM content height, which has no
 * model-space equivalent — those rows can still store less than they render.) */
const rowMinHeight = (context: DocumentContextValue, row: string[]): number => {
  const document = context.getDocumentSnapshot();
  return Math.max(MIN_ROW_HEIGHT, ...row.map((pageId) => {
    const page = document.pages[pageId];
    if (!page) return MIN_ROW_HEIGHT;
    if (page.type === "drawing") return MIN_DRAWING_HEIGHT;
    const block = page.front.blocks[0];
    if (block?.type === "image" || block?.type === "video") return MIN_MEDIA_HEIGHT;
    if (block?.type === "variants") return MIN_VERSIONS_HEIGHT;
    return MIN_ROW_HEIGHT;
  }));
};

const sanitizeStrokes = (input: AgentStroke[]): DrawingStroke[] => {
  if (!Array.isArray(input) || input.length === 0) throw new AgentOpError("invalid", "Provide at least one stroke.");
  if (input.length > MAX_STROKES) throw new AgentOpError("invalid", `Too many strokes (limit ${MAX_STROKES}).`);
  let totalPoints = 0;
  return input.map((stroke) => {
    const points = Array.isArray(stroke.points) ? stroke.points : [];
    if (points.length < 2) throw new AgentOpError("invalid", "Each stroke needs at least two points.");
    totalPoints += points.length;
    if (totalPoints > MAX_STROKE_POINTS) throw new AgentOpError("invalid", `Too many points in total (limit ${MAX_STROKE_POINTS}).`);
    const tool = stroke.tool === "highlighter" || stroke.tool === "eraser" ? stroke.tool : "pen";
    return {
      id: uuid(),
      tool,
      width: clamp(Number(stroke.width) || 3, 1, 24),
      opacity: clamp(Number(stroke.opacity) || (tool === "highlighter" ? 0.45 : 1), 0.05, 1),
      points: points.map((point) => ({
        x: clamp(Number(point.x) || 0, 0, 1),
        y: clamp(Number(point.y) || 0, 0, 1),
        ...(point.pressure !== undefined ? { pressure: clamp(Number(point.pressure) || 0, 0, 1) } : {})
      }))
    };
  });
};

const sanitizeVariants = (input: { label?: string; html: string }[]) => {
  if (!Array.isArray(input) || input.length === 0) throw new AgentOpError("invalid", "Provide at least one version.");
  if (input.length > MAX_VARIANTS) throw new AgentOpError("invalid", `Too many versions (limit ${MAX_VARIANTS}).`);
  return input.map((variant) => ({
    id: uuid(),
    label: String(variant.label ?? "").slice(0, 80),
    html: String(variant.html ?? "")
  }));
};

const decodeBase64 = (data: string): Uint8Array => {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    throw new AgentOpError("invalid", "Media payload is not valid base64.");
  }
};

/** Applies one broker-issued operation through the existing context mutations.
 * Callers wrap this in `runAgentEdit`, so mutations pass the turn lock and are
 * uniformly history-free; `flushSync` renders each op before the next arrives
 * (live typing) and keeps `getDocumentSnapshot()` current for follow-up reads. */
export async function applyAgentOp(op: AgentOp, context: DocumentContextValue): Promise<AgentOpResult> {
  switch (op.kind) {
    case "read_document": {
      return { revision: context.getRevision(), document: await documentSnapshot(context.getDocumentSnapshot(), context.assets) };
    }

    case "set_title": {
      requireRevision(op.baseRevision, context);
      const title = String(op.title).trim().slice(0, 200);
      if (!title) throw new AgentOpError("invalid", "The title cannot be empty.");
      flushSync(() => context.updateTitle(title));
      return { revision: context.getRevision() };
    }

    case "append_text": {
      requireRevision(op.baseRevision, context);
      const block = requireTextPage(context, op.pageId);
      flushSync(() => context.updateBlock(op.pageId, "front", block.id, { html: block.html + op.html }));
      return { revision: context.getRevision() };
    }

    case "edit_text": {
      requireRevision(op.baseRevision, context);
      const block = requireTextPage(context, op.pageId);
      flushSync(() => context.updateBlock(op.pageId, "front", block.id, { html: op.html }));
      return { revision: context.getRevision() };
    }

    case "edit_notes": {
      requireRevision(op.baseRevision, context);
      requirePage(context, op.pageId);
      flushSync(() => context.setPageNotes(op.pageId, op.html));
      return { revision: context.getRevision() };
    }

    case "insert_page": {
      requireRevision(op.baseRevision, context);
      if (op.afterPageId) requirePage(context, op.afterPageId);
      let pageId = "";
      flushSync(() => { pageId = context.addPage(op.afterPageId); });
      if (op.html) {
        const block = requireTextPage(context, pageId);
        flushSync(() => context.updateBlock(pageId, "front", block.id, { html: op.html }));
      }
      return { revision: context.getRevision(), pageId };
    }

    case "delete_pages": {
      requireRevision(op.baseRevision, context);
      if (!Array.isArray(op.pageIds) || op.pageIds.length === 0) throw new AgentOpError("invalid", "Provide the ids of the pages to delete.");
      op.pageIds.forEach((pageId) => requirePage(context, pageId));
      flushSync(() => context.deletePages(op.pageIds));
      return { revision: context.getRevision() };
    }

    case "arrange_pages": {
      requireRevision(op.baseRevision, context);
      const document = context.getDocumentSnapshot();
      requirePage(context, op.pageId);
      requirePage(context, op.targetPageId);
      if (op.pageId === op.targetPageId) throw new AgentOpError("invalid", "A page cannot be arranged relative to itself.");
      if (op.position === "left" || op.position === "right") {
        const targetRow = document.pageRows.find((row) => row.includes(op.targetPageId));
        const staying = targetRow?.filter((id) => id !== op.pageId).length ?? 0;
        if (staying + 1 > 4) throw new AgentOpError("invalid", "A row holds at most four pages.");
      }
      flushSync(() => context.movePage(op.pageId, op.targetPageId, op.position));
      return { revision: context.getRevision() };
    }

    case "set_row_height": {
      requireRevision(op.baseRevision, context);
      const row = requireRow(context, op.pageId);
      const height = clamp(Math.round(Number(op.height) || 0), rowMinHeight(context, row), MAX_ROW_HEIGHT);
      flushSync(() => context.setPageRowHeight(row, height));
      return { revision: context.getRevision(), height };
    }

    case "set_row_widths": {
      requireRevision(op.baseRevision, context);
      const row = requireRow(context, op.pageId);
      if (row.length < 2) throw new AgentOpError("invalid", "The page is alone in its row; widths only apply to rows with two or more pages.");
      if (!Array.isArray(op.fractions) || op.fractions.length !== row.length) {
        throw new AgentOpError("invalid", `Provide exactly ${row.length} fractions for this row.`);
      }
      const raw = op.fractions.map((fraction) => Number(fraction));
      if (raw.some((fraction) => !Number.isFinite(fraction) || fraction <= 0)) {
        throw new AgentOpError("invalid", "Every fraction must be a positive number.");
      }
      const sum = raw.reduce((total, fraction) => total + fraction, 0);
      const normalized = raw.map((fraction) => fraction / sum);
      // The same column floor the user's drag gesture enforces: at least 120px
      // (or 12% of the row when that is larger), capped at an even two-way split.
      const pageWidth = context.getDocumentSnapshot().settings.pageWidth;
      const minFraction = Math.min(0.5, Math.max(120, pageWidth * 0.12) / pageWidth);
      if (normalized.some((fraction) => fraction < minFraction)) {
        throw new AgentOpError("invalid", `Each page needs at least ${(minFraction * 100).toFixed(1)}% of this row's width (the app's ${Math.round(Math.max(120, pageWidth * 0.12))}px column minimum).`);
      }
      flushSync(() => context.setRowWidthFractions(row, normalized));
      return { revision: context.getRevision() };
    }

    case "set_vertical_align": {
      requireRevision(op.baseRevision, context);
      requirePage(context, op.pageId);
      flushSync(() => context.setPageVerticalAlign(op.pageId, op.align));
      return { revision: context.getRevision() };
    }

    case "create_drawing": {
      requireRevision(op.baseRevision, context);
      if (op.afterPageId) requirePage(context, op.afterPageId);
      const strokes = sanitizeStrokes(op.strokes);
      let pageId = "";
      flushSync(() => { pageId = context.addPage(op.afterPageId, "drawing"); });
      const page = requirePage(context, pageId);
      const height = op.height !== undefined
        ? clamp(Math.round(Number(op.height) || 0), MIN_DRAWING_HEIGHT, MAX_ROW_HEIGHT)
        : page.drawing?.height ?? MIN_DRAWING_HEIGHT;
      flushSync(() => {
        context.updatePageDrawing(pageId, { id: page.drawing?.id ?? uuid(), type: "drawing", height, strokes });
        context.setPageRowHeight([pageId], height);
      });
      return { revision: context.getRevision(), pageId };
    }

    case "edit_drawing": {
      requireRevision(op.baseRevision, context);
      const { drawing } = requireDrawing(context, op.pageId);
      const strokes = sanitizeStrokes(op.strokes);
      const combined = op.mode === "append" ? [...drawing.strokes, ...strokes] : strokes;
      flushSync(() => context.updatePageDrawing(op.pageId, { ...drawing, strokes: combined }));
      return { revision: context.getRevision() };
    }

    case "read_drawing": {
      const { page, drawing } = requireDrawing(context, op.pageId);
      const document = context.getDocumentSnapshot();
      const row = document.pageRows.find((candidate) => candidate.includes(op.pageId));
      const share = page.layoutWidthFraction ?? 1 / (row?.length ?? 1);
      return {
        revision: context.getRevision(),
        drawing: {
          height: drawing.height,
          widthPx: Math.round(document.settings.pageWidth * share),
          strokes: drawing.strokes.map((stroke) => ({
            id: stroke.id,
            tool: stroke.tool,
            width: stroke.width,
            opacity: round3(stroke.opacity),
            points: stroke.points.map((point) => ({ x: round3(point.x), y: round3(point.y) }))
          }))
        }
      };
    }

    case "delete_strokes": {
      requireRevision(op.baseRevision, context);
      const { drawing } = requireDrawing(context, op.pageId);
      const ids = requireStrokeIds(op.strokeIds, drawing);
      flushSync(() => context.updatePageDrawing(op.pageId, { ...drawing, strokes: drawing.strokes.filter((stroke) => !ids.has(stroke.id)) }));
      return { revision: context.getRevision() };
    }

    case "modify_strokes": {
      requireRevision(op.baseRevision, context);
      const { drawing } = requireDrawing(context, op.pageId);
      const ids = requireStrokeIds(op.strokeIds, drawing);
      if (op.tool !== undefined && !["pen", "highlighter", "eraser"].includes(op.tool)) {
        throw new AgentOpError("invalid", `Unknown tool "${op.tool}".`);
      }
      const dx = Number(op.dx) || 0;
      const dy = Number(op.dy) || 0;
      const scale = op.scale === undefined ? 1 : Number(op.scale);
      if (!Number.isFinite(scale) || scale <= 0) throw new AgentOpError("invalid", "scale must be a positive number.");
      // Scale about the given origin, defaulting to the selection's bounding-box
      // center so "make it bigger" grows in place.
      let originX = Number(op.originX);
      let originY = Number(op.originY);
      if (!Number.isFinite(originX) || !Number.isFinite(originY)) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        drawing.strokes.forEach((stroke) => {
          if (!ids.has(stroke.id)) return;
          stroke.points.forEach((point) => {
            x0 = Math.min(x0, point.x);
            y0 = Math.min(y0, point.y);
            x1 = Math.max(x1, point.x);
            y1 = Math.max(y1, point.y);
          });
        });
        originX = Number.isFinite(x0) ? (x0 + x1) / 2 : 0.5;
        originY = Number.isFinite(y0) ? (y0 + y1) / 2 : 0.5;
      }
      const moved = dx !== 0 || dy !== 0 || scale !== 1;
      // Transformed ink may leave the visible canvas (clamped to a sane [-1, 2]
      // band); it is hidden there, not deleted, mirroring how manual moves work.
      const strokes = drawing.strokes.map((stroke) => {
        if (!ids.has(stroke.id)) return stroke;
        return {
          ...stroke,
          tool: op.tool ?? stroke.tool,
          width: op.width !== undefined ? clamp(Number(op.width) || stroke.width, 1, 24) : stroke.width,
          opacity: op.opacity !== undefined ? clamp(Number(op.opacity) || stroke.opacity, 0.05, 1) : stroke.opacity,
          points: moved
            ? stroke.points.map((point) => ({
                ...point,
                x: clamp(originX + (point.x - originX) * scale + dx, -1, 2),
                y: clamp(originY + (point.y - originY) * scale + dy, -1, 2)
              }))
            : stroke.points
        };
      });
      flushSync(() => context.updatePageDrawing(op.pageId, { ...drawing, strokes }));
      return { revision: context.getRevision() };
    }

    case "insert_versions": {
      requireRevision(op.baseRevision, context);
      if (op.afterPageId) requirePage(context, op.afterPageId);
      const variants = sanitizeVariants(op.variants);
      const block: VariantGroupBlock = {
        id: uuid(),
        type: "variants",
        activeVariant: clamp(Math.round(Number(op.activeIndex) || 0), 0, variants.length - 1),
        variants
      };
      let pageId = "";
      flushSync(() => { pageId = context.addBlockPage(block, op.afterPageId); });
      return { revision: context.getRevision(), pageId };
    }

    case "edit_versions": {
      requireRevision(op.baseRevision, context);
      const block = requireVersionsBlock(context, op.pageId);
      const variants = op.variants !== undefined ? sanitizeVariants(op.variants) : block.variants;
      const activeVariant = op.activeIndex !== undefined
        ? clamp(Math.round(Number(op.activeIndex) || 0), 0, variants.length - 1)
        : clamp(block.activeVariant, 0, variants.length - 1);
      flushSync(() => context.updateBlock(op.pageId, "front", block.id, { variants, activeVariant }));
      return { revision: context.getRevision() };
    }

    case "convert_versions_to_text": {
      requireRevision(op.baseRevision, context);
      const block = requireVersionsBlock(context, op.pageId);
      flushSync(() => context.convertVariantToText(op.pageId, "front", block.id));
      return { revision: context.getRevision() };
    }

    case "insert_media": {
      requireRevision(op.baseRevision, context);
      if (op.afterPageId) requirePage(context, op.afterPageId);
      const type = detectMediaPageType(op.mimeType, op.filename);
      if (!type) throw new AgentOpError("invalid", `Unsupported media type ${op.mimeType}.`);
      const bytes = decodeBase64(op.bytesBase64);
      const file = new File([bytes as BlobPart], op.filename, { type: op.mimeType });
      // Size the new row to the media's aspect ratio at full document width so
      // "contain" fills the tile instead of letterboxing (420 px only when the
      // bytes cannot be decoded).
      let size: { width: number; height: number } | null = null;
      let mediaHeight = 420;
      if (type === "image" || type === "video") {
        const url = URL.createObjectURL(file);
        try {
          size = await measureMediaUrl(url, type);
        } finally {
          URL.revokeObjectURL(url);
        }
        if (size) {
          const pageWidth = context.getDocumentSnapshot().settings.pageWidth;
          mediaHeight = clamp(Math.round((pageWidth * size.height) / size.width), MIN_MEDIA_HEIGHT, MAX_ROW_HEIGHT);
        }
      }
      const assetId = await context.addAsset(file);
      if (size) assetDimensions.set(assetId, size);
      let pageId = "";
      flushSync(() => {
        if (type === "image") pageId = context.addBlockPage({ id: uuid(), type, assetId, height: mediaHeight, fit: "contain", alt: op.alt ?? op.filename }, op.afterPageId);
        if (type === "video") pageId = context.addBlockPage({ id: uuid(), type, assetId, height: mediaHeight, fit: "contain", controls: true }, op.afterPageId);
        if (type === "audio") pageId = context.addBlockPage({ id: uuid(), type, assetId, size: "compact" }, op.afterPageId);
      });
      return { revision: context.getRevision(), pageId, assetId };
    }
  }
}
