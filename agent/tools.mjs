// Shared document tool logic for the Inktile agent broker. Dependency-free:
// runs on a plain Node install (no node_modules), because zero-setup is the
// whole point — the broker drives the user's already-installed CLIs.

/** Hard cap for downloaded/authored media shipped into the app. */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const MAX_SVG_CHARS = 1_000_000;
const FETCH_TIMEOUT_MS = 30_000;

/** Mirrors src/document/mediaTypes.ts — the app validates again on apply. */
const mediaExtensions = {
  image: new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]),
  video: new Set(["m4v", "mov", "mp4", "ogv", "webm"]),
  audio: new Set(["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav"])
};

const mediaMimeTypes = {
  image: new Set(["image/avif", "image/bmp", "image/gif", "image/jpeg", "image/png", "image/svg+xml", "image/webp"]),
  video: new Set(["video/mp4", "video/ogg", "video/quicktime", "video/webm"]),
  audio: new Set(["audio/aac", "audio/flac", "audio/m4a", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/opus", "audio/wav", "audio/webm", "audio/x-m4a", "audio/x-wav"])
};

const detectMediaPageType = (mimeType, filename = "") => {
  const mime = mimeType.toLowerCase();
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  return Object.keys(mediaExtensions).find((type) => mediaMimeTypes[type].has(mime))
    ?? Object.keys(mediaExtensions).find((type) => mediaExtensions[type].has(extension))
    ?? null;
};

/** An op the app rejected (revision mismatch, unknown page, …). */
export class OpRejectedError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * One document's op channel for the duration of a turn. Tracks the revision
 * returned by every result and stamps it onto writes, so optimistic
 * concurrency stays a transport concern the model never sees: a mismatch
 * surfaces as a tool error telling the model to re-read.
 */
export class DocumentSession {
  /** @param {(op: object) => Promise<{revision: number} & Record<string, unknown>>} sendOp */
  constructor(sendOp) {
    this.sendOp = sendOp;
    this.revision = 0;
  }

  seedRevision(revision) {
    this.revision = revision;
  }

  async run(op) {
    const result = await this.sendOp(op);
    this.revision = result.revision;
    return result;
  }

  readDocument() {
    return this.run({ kind: "read_document" });
  }

  appendText(pageId, html) {
    return this.run({ kind: "append_text", pageId, html, baseRevision: this.revision });
  }

  editText(pageId, html) {
    return this.run({ kind: "edit_text", pageId, html, baseRevision: this.revision });
  }

  insertPage(afterPageId, html) {
    return this.run({ kind: "insert_page", afterPageId, html, baseRevision: this.revision });
  }

  arrangePages(pageId, targetPageId, position) {
    return this.run({ kind: "arrange_pages", pageId, targetPageId, position, baseRevision: this.revision });
  }

  insertMedia({ afterPageId, filename, mimeType, alt, bytes }) {
    return this.run({
      kind: "insert_media",
      afterPageId,
      filename,
      mimeType,
      alt,
      bytesBase64: Buffer.from(bytes).toString("base64"),
      baseRevision: this.revision
    });
  }

  setTitle(title) {
    return this.run({ kind: "set_title", title, baseRevision: this.revision });
  }

  editNotes(pageId, html) {
    return this.run({ kind: "edit_notes", pageId, html, baseRevision: this.revision });
  }

  deletePages(pageIds) {
    return this.run({ kind: "delete_pages", pageIds, baseRevision: this.revision });
  }

  setRowHeight(pageId, height) {
    return this.run({ kind: "set_row_height", pageId, height, baseRevision: this.revision });
  }

  setRowWidths(pageId, fractions) {
    return this.run({ kind: "set_row_widths", pageId, fractions, baseRevision: this.revision });
  }

  setVerticalAlign(pageId, align) {
    return this.run({ kind: "set_vertical_align", pageId, align, baseRevision: this.revision });
  }

  createDrawing(afterPageId, height, strokes) {
    return this.run({ kind: "create_drawing", afterPageId, height, strokes, baseRevision: this.revision });
  }

  editDrawing(pageId, strokes, mode) {
    return this.run({ kind: "edit_drawing", pageId, strokes, mode, baseRevision: this.revision });
  }

  insertVersions(afterPageId, variants, activeIndex) {
    return this.run({ kind: "insert_versions", afterPageId, variants, activeIndex, baseRevision: this.revision });
  }

  editVersions(pageId, variants, activeIndex) {
    return this.run({ kind: "edit_versions", pageId, variants, activeIndex, baseRevision: this.revision });
  }

  convertVersionsToText(pageId) {
    return this.run({ kind: "convert_versions_to_text", pageId, baseRevision: this.revision });
  }
}

/**
 * Strips active content from agent-authored SVG before it becomes an asset:
 * scripts, event handlers, foreign objects, and references to anything outside
 * the file itself. Throws when the input is not a plausible standalone SVG.
 */
export const sanitizeSvg = (source) => {
  if (source.length > MAX_SVG_CHARS) throw new Error(`SVG is too large (limit ${MAX_SVG_CHARS} characters).`);
  let svg = source.replace(/^﻿/, "").trim();
  svg = svg.replace(/<\?xml[\s\S]*?\?>/gi, "").replace(/<!DOCTYPE[\s\S]*?>/gi, "").trim();
  if (!/^<svg[\s>]/i.test(svg)) throw new Error("Expected a standalone <svg> document.");

  for (const element of ["script", "foreignObject", "iframe", "object", "embed", "link", "meta", "base", "handler", "animation"]) {
    svg = svg.replace(new RegExp(`<${element}[\\s\\S]*?</${element}\\s*>`, "gi"), "");
    svg = svg.replace(new RegExp(`<${element}[^>]*?/?>`, "gi"), "");
  }
  svg = svg.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  svg = svg.replace(/\s+[a-z:_-]+\s*=\s*("[^"]*javascript:[^"]*"|'[^']*javascript:[^']*')/gi, "");
  svg = svg.replace(/\s+(href|xlink:href|src)\s*=\s*("([^"]*)"|'([^']*)')/gi, (match, _name, _quoted, doubleValue, singleValue) => {
    const value = String(doubleValue ?? singleValue ?? "").trim().toLowerCase();
    return value.startsWith("#") || value.startsWith("data:image/") ? match : "";
  });
  svg = svg.replace(/url\(\s*("[^"]*"|'[^']*'|[^)]*)\s*\)/gi, (match) =>
    /url\(\s*['"]?\s*#/i.test(match) ? match : "none"
  );

  if (/<script|javascript:|\son[a-z]+\s*=/i.test(svg)) throw new Error("SVG still contains active content after sanitizing.");
  return svg;
};

const filenameFromUrl = (url, mimeType) => {
  const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (last.includes(".")) return last;
  const extension = mimeType.split("/")[1]?.split("+")[0] ?? "bin";
  return `${last || "download"}.${extension}`;
};

/**
 * Identifies a media file from its bytes (magic numbers). Servers routinely
 * lie or stay vague (application/octet-stream, text/plain, an HTML error page
 * served for a ".mp3" URL) — labeling those by extension produced assets the
 * app could never play. Returns a MIME string, "text" for text/HTML content,
 * or null when the container is unrecognized.
 */
export const sniffMime = (bytes) => {
  if (bytes.length < 12) return null;
  const ascii = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      if (bytes[offset + index] !== text.charCodeAt(index)) return false;
    }
    return true;
  };

  // Images.
  if (bytes[0] === 0x89 && ascii(1, "PNG")) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(0, "GIF8")) return "image/gif";
  if (ascii(0, "BM")) return "image/bmp";
  // Audio.
  if (ascii(0, "ID3")) return "audio/mpeg";
  if (ascii(0, "fLaC")) return "audio/flac";
  if (ascii(0, "OggS")) {
    const head = Buffer.from(bytes.slice(0, 512)).toString("latin1");
    return head.includes("theora") ? "video/ogg" : head.includes("Opus") ? "audio/opus" : "audio/ogg";
  }
  // RIFF containers.
  if (ascii(0, "RIFF")) {
    if (ascii(8, "WAVE")) return "audio/wav";
    if (ascii(8, "WEBP")) return "image/webp";
    return null;
  }
  // ISO base media (MP4 family): brand at offset 8 decides.
  if (ascii(4, "ftyp")) {
    if (ascii(8, "M4A") || ascii(8, "M4B")) return "audio/mp4";
    if (ascii(8, "qt")) return "video/quicktime";
    if (ascii(8, "avif") || ascii(8, "avis")) return "image/avif";
    return "video/mp4";
  }
  // EBML (WebM/Matroska).
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  // MPEG audio frame sync / ADTS AAC.
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return "audio/aac";
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio/mpeg";

  // Text-ish content (HTML error pages, JSON, plain text, or an actual SVG).
  const headText = Buffer.from(bytes.slice(0, 1024)).toString("utf8").replace(/^﻿/, "").trimStart();
  if (headText.startsWith("<")) {
    if (/^<svg[\s>]/i.test(headText) || (/^<\?xml/i.test(headText) && headText.toLowerCase().includes("<svg"))) return "image/svg+xml";
    return "text";
  }
  if (/^[{["]/.test(headText)) return "text";
  return null;
};

/** Downloads a URL and validates it against the app's accepted media formats
 * and the size cap before any bytes are handed to the app. */
export const fetchMedia = async (rawUrl) => {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http(s) downloads are supported.");

  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": "inktile-agent-broker/0.2" }
  });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} for ${url.href}`);

  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_MEDIA_BYTES) throw new Error(`File is too large (${declaredLength} bytes; limit ${MAX_MEDIA_BYTES}).`);

  const chunks = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The response had no body.");
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_MEDIA_BYTES) {
      await reader.cancel();
      throw new Error(`File is too large (limit ${MAX_MEDIA_BYTES} bytes).`);
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));

  const headerMime = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  // The bytes are the truth: a sniffed container beats whatever the server
  // claimed, and text/HTML masquerading as media is rejected outright instead
  // of being inserted as an asset that can never play.
  const sniffed = sniffMime(bytes);
  if (sniffed === "text") {
    throw new Error(`${url.href} returned text/HTML, not a media file. Link directly to the media file itself.`);
  }
  const mimeType = sniffed ?? (Object.values(mediaMimeTypes).some((set) => set.has(headerMime)) ? headerMime : null);
  if (!mimeType) {
    throw new Error(`Could not identify ${url.href} as a supported image, video, or audio file (content-type "${headerMime || "unknown"}").`);
  }
  const filename = filenameFromUrl(url, mimeType);
  const type = detectMediaPageType(mimeType, filename);
  if (!type) {
    throw new Error(`Unsupported media type "${mimeType}" for ${filename}.`);
  }
  return { bytes, mimeType, filename };
};

const describeResult = (result, note) =>
  result.pageId ? `${note} New page id: ${result.pageId}.` : note;

/** Every document mutation — including deletion — reverts with one undo in
 * the app, so nothing here is destructive in the MCP sense; only fetch_media
 * reaches the open web. Explicit annotations are mandatory: Codex cancels
 * un-annotated MCP tool calls when it runs headless under a restricted
 * sandbox. */
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

const stringProp = { type: "string" };

const strokesSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      tool: { type: "string", enum: ["pen", "highlighter", "eraser"] },
      width: { type: "number", description: "Line width in px (1-24, default 3)." },
      opacity: { type: "number", description: "0-1; highlighter defaults to 0.45." },
      points: {
        type: "array",
        items: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" }, pressure: { type: "number" } },
          required: ["x", "y"],
          additionalProperties: false
        }
      }
    },
    required: ["points"],
    additionalProperties: false
  }
};

const variantsSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      label: { type: "string" },
      html: { type: "string" }
    },
    required: ["html"],
    additionalProperties: false
  }
};

/**
 * Backend-neutral tool table, served to both CLIs over the broker's MCP
 * endpoint. `inputSchema` is plain JSON Schema; `run` returns the text handed
 * back to the model.
 */
export const inktileTools = [
  {
    name: "read_document",
    description: "Read the open inktile: title, page rows (the visual layout, up to 4 pages side by side per row), and every page's component, current HTML, notes, row height, width fraction, vertical alignment, versions (all drafts + active index), and drawing stroke counts. Call it before working — unless your instructions say the document is unchanged since your last turn — and again whenever an edit is rejected because the document changed.",
    annotations: READ,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async ({ document }) => {
      const result = await document.readDocument();
      return JSON.stringify(result.document);
    }
  },
  {
    name: "append_text",
    description: "Append HTML to the end of an existing text page. Stream your writing with many small appends (a sentence or two at a time) so the user watches the text arrive; never buffer a whole page into one call. Basic inline HTML only (p, br, b, i, u, span, headings).",
    annotations: WRITE,
    inputSchema: {
      type: "object",
      properties: { page_id: stringProp, html: stringProp },
      required: ["page_id", "html"],
      additionalProperties: false
    },
    run: async ({ document }, args) => {
      await document.appendText(String(args.page_id), String(args.html));
      return "Appended.";
    }
  },
  {
    name: "edit_text",
    description: "Replace the entire HTML content of an existing text page. Prefer append_text for new writing; use this only to revise what a page already contains.",
    annotations: WRITE,
    inputSchema: {
      type: "object",
      properties: { page_id: stringProp, html: stringProp },
      required: ["page_id", "html"],
      additionalProperties: false
    },
    run: async ({ document }, args) => {
      await document.editText(String(args.page_id), String(args.html));
      return "Replaced.";
    }
  },
  {
    name: "insert_page",
    description: "Insert a new text page (its own row) after the given page, or at the end when after_page_id is omitted. Optionally seed it with initial HTML; keep seeding short and continue with append_text. Every page owns exactly one component.",
    annotations: WRITE,
    inputSchema: {
      type: "object",
      properties: { after_page_id: stringProp, html: stringProp },
      additionalProperties: false
    },
    run: async ({ document }, args) => {
      const result = await document.insertPage(
        args.after_page_id === undefined ? undefined : String(args.after_page_id),
        args.html === undefined ? undefined : String(args.html)
      );
      return describeResult(result, "Inserted a text page.");
    }
  },
  {
    name: "arrange_pages",
    description: "Move a page relative to another: before/after stacks it vertically as its own row; left/right places it side by side in the target's row (a row holds at most four pages).",
    annotations: WRITE,
    inputSchema: {
      type: "object",
      properties: {
        page_id: stringProp,
        target_page_id: stringProp,
        position: { type: "string", enum: ["before", "after", "left", "right"] }
      },
      required: ["page_id", "target_page_id", "position"],
      additionalProperties: false
    },
    run: async ({ document }, args) => {
      await document.arrangePages(String(args.page_id), String(args.target_page_id), String(args.position));
      return "Moved.";
    }
  },
  {
    name: "create_image",
    description: "Author an SVG illustration and insert it as an image page after the given page (or at the end). Provide a complete standalone <svg> document with width/height or viewBox. Scripts, event handlers, and external references are stripped.",
    annotations: WRITE,
    inputSchema: {
      type: "object",
      properties: { svg: stringProp, alt: stringProp, after_page_id: stringProp },
      required: ["svg"],
      additionalProperties: false
    },
    run: async ({ document }, args) => {
      const svg = sanitizeSvg(String(args.svg));
      const result = await document.insertMedia({
        afterPageId: args.after_page_id === undefined ? undefined : String(args.after_page_id),
        filename: "agent-image.svg",
        mimeType: "image/svg+xml",
        alt: args.alt === undefined ? undefined : String(args.alt),
        bytes: Buffer.from(svg, "utf8")
      });
      return describeResult(result, "Inserted the SVG as an image page.");
    }
  },
  {
    name: "fetch_media",
    description: "Download an image, video, or audio file from a URL and insert it as a media page after the given page (or at the end). The download is validated against the app's accepted formats and a size cap. Use this for every binary download; web research tools are for reading pages only.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: { url: stringProp, alt: stringProp, after_page_id: stringProp },
      required: ["url"],
      additionalProperties: false
    },
    run: async ({ document }, args) => {
      const media = await fetchMedia(String(args.url));
      const result = await document.insertMedia({
        afterPageId: args.after_page_id === undefined ? undefined : String(args.after_page_id),
        filename: media.filename,
        mimeType: media.mimeType,
        alt: args.alt === undefined ? undefined : String(args.alt),
        bytes: media.bytes
      });
      return describeResult(result, `Inserted ${media.filename} (${media.mimeType}, ${media.bytes.byteLength} bytes).`);
    }
  },
  {
    name: "set_title",
    description: "Rename the document.",
    annotations: WRITE,
    inputSchema: {
      type: "object",
      properties: { title: stringProp },
      required: ["title"],
      additionalProperties: false
    },
    run: async ({ document }, args) => {
      await document.setTitle(String(args.title));
      return "Renamed.";
    }
  },
  {
    name: "edit_notes",
    description: "Write the back face (\"notes\") of any page — every page has one, shown when the user flips the tile. Replaces the whole notes HTML; read_document returns current notes as notesHtml.",
    annotations: WRITE,
    inputSchema: {
      type: "object",
      properties: { page_id: stringProp, html: stringProp },
      required: ["page_id", "html"],
      additionalProperties: false
    },
    run: async ({ document }, args) => {
      await document.editNotes(String(args.page_id), String(args.html));
      return "Notes updated.";
    }
  },
  {
    name: "delete_pages",
    description: "Delete one or more pages. The user can undo the whole turn in one step, so deletion is recoverable — but only delete what the task actually calls for.",
    annotations: WRITE,
    inputSchema: {
      type: "object",
      properties: { page_ids: { type: "array", items: stringProp } },
      required: ["page_ids"],
      additionalProperties: false
    },
    run: async ({ document }, args) => {
      const ids = Array.isArray(args.page_ids) ? args.page_ids.map(String) : [];
      await document.deletePages(ids);
      return `Deleted ${ids.length} page(s).`;
    }
  },
  {
    name: "set_row_height",
    description: "Resize a row: sets the shared height (in px, 96-1600) of the row containing the given page. All pages in a row share one height; media and drawings fill it.",
    annotations: WRITE,
    inputSchema: {
      type: "object",
      properties: { page_id: stringProp, height: { type: "number" } },
      required: ["page_id", "height"],
      additionalProperties: false
    },
    run: async ({ document }, args) => {
      await document.setRowHeight(String(args.page_id), Number(args.height));
      return "Row resized.";
    }
  },
  {
    name: "set_row_widths",
    description: "Change how the pages of one multi-page row split its width: pass one fraction per page in left-to-right order (they are normalized to sum to 1; each page needs at least 8%). Identify the row by any page in it.",
    annotations: WRITE,
    inputSchema: {
      type: "object",
      properties: { page_id: stringProp, fractions: { type: "array", items: { type: "number" } } },
      required: ["page_id", "fractions"],
      additionalProperties: false
    },
    run: async ({ document }, args) => {
      await document.setRowWidths(String(args.page_id), Array.isArray(args.fractions) ? args.fractions.map(Number) : []);
      return "Row widths updated.";
    }
  },
  {
    name: "set_vertical_align",
    description: "Anchor a page's content to the top, center, or bottom of its card.",
    annotations: WRITE,
    inputSchema: {
      type: "object",
      properties: { page_id: stringProp, align: { type: "string", enum: ["top", "center", "bottom"] } },
      required: ["page_id", "align"],
      additionalProperties: false
    },
    run: async ({ document }, args) => {
      await document.setVerticalAlign(String(args.page_id), String(args.align));
      return "Alignment set.";
    }
  },
  {
    name: "create_drawing",
    description: "Insert a new drawing page after the given page (or at the end) and draw the given strokes onto it. Coordinates are normalized 0..1 (x across the page width, y down the canvas height); the canvas is the full page card, height in px (240-1600, default 240). Build shapes from polyline points — many short segments make smooth curves.",
    annotations: WRITE,
    inputSchema: {
      type: "object",
      properties: { after_page_id: stringProp, height: { type: "number" }, strokes: strokesSchema },
      required: ["strokes"],
      additionalProperties: false
    },
    run: async ({ document }, args) => {
      const result = await document.createDrawing(
        args.after_page_id === undefined ? undefined : String(args.after_page_id),
        args.height === undefined ? undefined : Number(args.height),
        args.strokes
      );
      return describeResult(result, "Created the drawing page.");
    }
  },
  {
    name: "edit_drawing",
    description: "Draw onto an existing drawing page. mode \"append\" (default) adds the strokes on top of what is there; \"replace\" clears the canvas first. Coordinates are normalized 0..1. Eraser strokes remove ink where they pass.",
    annotations: WRITE,
    inputSchema: {
      type: "object",
      properties: { page_id: stringProp, strokes: strokesSchema, mode: { type: "string", enum: ["append", "replace"] } },
      required: ["page_id", "strokes"],
      additionalProperties: false
    },
    run: async ({ document }, args) => {
      await document.editDrawing(String(args.page_id), args.strokes, args.mode === "replace" ? "replace" : "append");
      return "Drawing updated.";
    }
  },
  {
    name: "insert_versions",
    description: "Insert a versions page (side-by-side drafts of one passage; the user flips between them) after the given page or at the end. Provide 1-20 versions, each with HTML and an optional short label; active_index picks which shows first.",
    annotations: WRITE,
    inputSchema: {
      type: "object",
      properties: { after_page_id: stringProp, variants: variantsSchema, active_index: { type: "number" } },
      required: ["variants"],
      additionalProperties: false
    },
    run: async ({ document }, args) => {
      const result = await document.insertVersions(
        args.after_page_id === undefined ? undefined : String(args.after_page_id),
        args.variants,
        args.active_index === undefined ? undefined : Number(args.active_index)
      );
      return describeResult(result, "Inserted a versions page.");
    }
  },
  {
    name: "edit_versions",
    description: "Rework an existing versions page: pass variants to replace the full set of drafts (add/remove/edit), and/or active_index to switch which draft shows. read_document returns the current drafts.",
    annotations: WRITE,
    inputSchema: {
      type: "object",
      properties: { page_id: stringProp, variants: variantsSchema, active_index: { type: "number" } },
      required: ["page_id"],
      additionalProperties: false
    },
    run: async ({ document }, args) => {
      await document.editVersions(
        String(args.page_id),
        args.variants,
        args.active_index === undefined ? undefined : Number(args.active_index)
      );
      return "Versions updated.";
    }
  },
  {
    name: "convert_versions_to_text",
    description: "Replace a versions page with a plain text page containing its currently active draft (the same action as the user's \"use selected version\" control).",
    annotations: WRITE,
    inputSchema: {
      type: "object",
      properties: { page_id: stringProp },
      required: ["page_id"],
      additionalProperties: false
    },
    run: async ({ document }, args) => {
      await document.convertVersionsToText(String(args.page_id));
      return "Converted to a text page.";
    }
  }
];

/** Runs one tool, converting failures into a model-readable error string. */
export const runTool = async (spec, runtime, args) => {
  try {
    return { text: await spec.run(runtime, args ?? {}), isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: `Error: ${message}`, isError: true };
  }
};
