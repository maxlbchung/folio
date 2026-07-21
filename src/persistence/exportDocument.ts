import { safeBaseName } from "./fileSystem";
import { collectKatexCss, renderMathInHtml } from "../utils/mathField";
import type {
  Block, DrawingBlock, DrawingStroke, InktileDocument, InktilePage, PageFace, RuntimeAssetMap
} from "../document/types";

export interface ExportResult {
  cancelled: boolean;
}

const isTauri = () => Boolean(window.__TAURI_INTERNALS__);

/** `pageRows` is canonical (AGENTS.md); flatten it row by row for reading order. */
const pagesInOrder = (document: InktileDocument): InktilePage[] =>
  document.pageRows.flat().map((id) => document.pages[id]).filter((page): page is InktilePage => Boolean(page));

// Tags that end a line in contentEditable output (divs from Enter, lists, headings).
const BLOCK_TAG = /^(DIV|P|LI|UL|OL|H[1-6]|BLOCKQUOTE|PRE|TABLE|TR)$/;

/** A table cell (or other container) flattened to a single line of text. */
const inlineCellText = (element: Element): string => {
  const chunk: string[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      chunk.push(node.textContent ?? "");
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.tagName === "BR") {
      chunk.push(" ");
      return;
    }
    if (BLOCK_TAG.test(node.tagName)) chunk.push(" ");
    node.childNodes.forEach(visit);
    if (BLOCK_TAG.test(node.tagName)) chunk.push(" ");
  };
  element.childNodes.forEach(visit);
  return chunk.join("").replace(/\s+/g, " ").trim();
};

const htmlToText = (html: string): string => {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  // Math fields keep only their TeX source in the document; export it in TeX delimiters.
  for (const field of Array.from(body.querySelectorAll("[data-tex]"))) {
    const tex = field.getAttribute("data-tex") ?? "";
    const display = field.getAttribute("data-display") === "true";
    field.replaceWith(body.ownerDocument.createTextNode(display ? `$$${tex}$$` : `$${tex}$`));
  }
  const parts: string[] = [];
  const endsWithBreak = () => parts.length === 0 || parts[parts.length - 1].endsWith("\n");
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? "");
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.tagName === "BR") {
      parts.push("\n");
      return;
    }
    if (node.tagName === "HR") {
      if (!endsWithBreak()) parts.push("\n");
      parts.push("---\n");
      return;
    }
    if (node.tagName === "TR") {
      // One line per table row, pipe-separated cells.
      if (!endsWithBreak()) parts.push("\n");
      const cells = Array.from(node.children).filter((child) => /^(TD|TH)$/.test(child.tagName));
      parts.push(`${cells.map(inlineCellText).join(" | ")}\n`);
      return;
    }
    if (node.tagName === "A") {
      // Keep the destination visible in plain text unless the text already is the URL.
      const text = inlineCellText(node);
      const href = node.getAttribute("href") ?? "";
      parts.push(text);
      if (href && href !== text) parts.push(` (${href})`);
      return;
    }
    const block = BLOCK_TAG.test(node.tagName);
    if (block && !endsWithBreak()) parts.push("\n");
    if (node.tagName === "LI" && node.parentElement?.matches("ul.checklist")) {
      parts.push(node.getAttribute("data-checked") === "true" ? "[x] " : "[ ] ");
    }
    node.childNodes.forEach(walk);
    if (block && !endsWithBreak()) parts.push("\n");
  };
  body.childNodes.forEach(walk);
  return parts.join("").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
};

/** All text on one face: text blocks plus every version of a versions block. */
const faceText = (face: PageFace | undefined): string => {
  if (!face) return "";
  const chunks: string[] = [];
  for (const block of face.blocks) {
    if (block.type === "text") {
      const text = htmlToText(block.html);
      if (text) chunks.push(text);
    } else if (block.type === "variants") {
      for (const variant of block.variants) {
        const text = htmlToText(variant.html);
        if (!text) continue;
        chunks.push(block.variants.length > 1 && variant.label ? `[${variant.label}]\n${text}` : text);
      }
    }
  }
  return chunks.join("\n\n");
};

export const buildDocumentText = (document: InktileDocument): string => {
  const sections: string[] = [];
  for (const page of pagesInOrder(document)) {
    const front = faceText(page.front);
    const back = faceText(page.back);
    const section = [front, back ? `Notes:\n${back}` : ""].filter(Boolean).join("\n\n");
    if (section) sections.push(section);
  }
  return `${[document.title.trim(), ...sections].filter(Boolean).join("\n\n")}\n`;
};

export async function exportDocumentAsText(document: InktileDocument): Promise<ExportResult> {
  const text = buildDocumentText(document);
  const filename = `${safeBaseName(document.title)}.txt`;

  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: filename, filters: [{ name: "Text file", extensions: ["txt"] }] });
    if (!path) return { cancelled: true };
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    await writeFile(path, new TextEncoder().encode(text));
    return { cancelled: false };
  }

  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { cancelled: false };
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
};

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);

const strokePathData = (stroke: DrawingStroke, width: number, height: number): string =>
  stroke.points
    .map((point, index) => `${index === 0 ? "M" : "L"}${(point.x * width).toFixed(1)} ${(point.y * height).toFixed(1)}`)
    .join(" ");

/**
 * Strokes as static SVG. Eraser strokes replicate the canvas destination-out layering:
 * each one becomes a mask wrapped around everything drawn before it, so ink drawn after
 * an erase stays untouched.
 */
const drawingSvg = (block: DrawingBlock, document: InktileDocument): string => {
  const width = document.settings.pageWidth;
  const height = Math.max(1, block.height);
  const masks: string[] = [];
  let content = "";
  block.strokes.forEach((stroke, index) => {
    if (stroke.points.length < 2) return;
    const d = strokePathData(stroke, width, height);
    const strokeAttrs = `fill="none" stroke-width="${stroke.width}" stroke-linecap="round" stroke-linejoin="round"`;
    if (stroke.tool === "eraser") {
      const id = `erase-${block.id}-${index}`;
      masks.push(`<mask id="${id}"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" stroke="#000" ${strokeAttrs}/></mask>`);
      content = `<g mask="url(#${id})">${content}</g>`;
    } else {
      const color = stroke.tool === "highlighter" ? "#e9c84a" : "#1f1e1b";
      content += `<path d="${d}" stroke="${color}" stroke-opacity="${stroke.opacity}" ${strokeAttrs}/>`;
    }
  });
  if (!content) return "";
  return `<svg class="drawing" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><defs>${masks.join("")}</defs>${content}</svg>`;
};

const blockHtml = (block: Block, document: InktileDocument, assets: RuntimeAssetMap): string => {
  switch (block.type) {
    case "text":
      // Stored math fields hold only TeX; the print frame gets static KaTeX markup baked in.
      return `<div class="text">${renderMathInHtml(block.html)}</div>`;
    case "variants": {
      const active = block.variants[block.activeVariant] ?? block.variants[0];
      if (!active) return "";
      const label = block.variants.length > 1 && active.label ? `<p class="eyebrow">${escapeHtml(active.label)}</p>` : "";
      return `<div class="text">${label}${renderMathInHtml(active.html)}</div>`;
    }
    case "image": {
      const asset = assets[block.assetId];
      return asset ? `<img src="${asset.url}" alt="${escapeHtml(block.alt)}">` : "";
    }
    case "video":
      return `<p class="placeholder">Video: ${escapeHtml(assets[block.assetId]?.metadata.filename ?? "missing file")}</p>`;
    case "audio":
      return `<p class="placeholder">Audio: ${escapeHtml(assets[block.assetId]?.metadata.filename ?? "missing file")}</p>`;
    case "drawing":
      return drawingSvg(block, document);
    case "divider":
      return "<hr>";
  }
};

const pageHtml = (page: InktilePage, document: InktileDocument, assets: RuntimeAssetMap): string => {
  // A drawing page keeps its strokes on `page.drawing`, not in the front face blocks.
  const blocks: Block[] = page.type === "drawing" && page.drawing ? [page.drawing] : page.front.blocks;
  const front = blocks.map((block) => blockHtml(block, document, assets)).join("");
  const backText = faceText(page.back);
  const notes = backText
    ? `<div class="notes"><p class="eyebrow">Notes</p><div class="text">${escapeHtml(backText).replace(/\n/g, "<br>")}</div></div>`
    : "";
  if (!front.trim() && !notes) return "";
  return `<section class="tile">${front}${notes}</section>`;
};

/**
 * The print iframe is a fresh same-origin document, so it does NOT inherit the app's bundled
 * @font-face rules — without this, any tile using a bundled font (Lora, Fraunces, …) would
 * silently fall back to a system font in the exported PDF. Copy every @font-face rule out of the
 * app's own stylesheets, absolutizing each url() against its sheet's location so the font files
 * still resolve from inside the iframe (whose base URL differs from the stylesheet's).
 */
const collectFontFaceCss = (): string => {
  const faces: string[] = [];
  for (const sheet of Array.from(window.document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try { rules = sheet.cssRules; } catch { continue; } // cross-origin sheet: not readable, skip
    if (!rules) continue;
    const base = sheet.href ?? window.document.baseURI;
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      faces.push(rule.cssText.replace(/url\((['"]?)([^'")]+)\1\)/g, (whole, _quote, ref) => {
        try { return `url("${new URL(ref, base).href}")`; } catch { return whole; }
      }));
    }
  }
  return faces.join("\n");
};

// The <title> still carries the document title so the print dialog suggests it as the
// PDF filename, but the rendered pages hold nothing except the tiles themselves:
// borderless, full width, separated only by vertical space.
const buildPrintHtml = (document: InktileDocument, assets: RuntimeAssetMap): string => {
  const title = escapeHtml(document.title.trim() || "Untitled Inktile");
  const tiles = pagesInOrder(document).map((page) => pageHtml(page, document, assets)).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
    ${collectFontFaceCss()}
    ${tiles.includes("katex") ? collectKatexCss() : ""}
    @page { margin: 10mm; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, Arial, Helvetica, sans-serif; font-size: 13px; line-height: 1.55; color: #1f1e1b; }
    .tile { margin: 0 0 16px; break-inside: avoid; page-break-inside: avoid; }
    .tile:last-child { margin-bottom: 0; }
    .tile img, .tile .drawing { display: block; width: 100%; height: auto; }
    .text > *:first-child { margin-top: 0; }
    .text > *:last-child { margin-bottom: 0; }
    .eyebrow { margin: 0 0 4px; font-size: 9px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #8a857c; }
    .placeholder { margin: 0; color: #8a857c; font-style: italic; }
    .notes { margin-top: 12px; padding-top: 10px; border-top: 1px dashed #d8d4cc; }
    hr { border: none; border-top: 1px solid #d8d4cc; }
    a { color: #2f80cf; text-decoration: underline; }
    table.text-table { border-collapse: collapse; width: 100%; margin: 6px 0; table-layout: fixed; }
    .text-table th, .text-table td { border: 1px solid #d8d4cc; padding: 4px 8px; vertical-align: top; text-align: left; word-break: break-word; }
    .text-table th { background: #f4f2ee; font-weight: 600; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    ul.checklist { list-style: none; padding-left: 4px; }
    ul.checklist > li { position: relative; padding-left: 24px; }
    ul.checklist > li::before { content: ""; position: absolute; left: 1px; top: .3em; width: 13px; height: 13px; border: 1.5px solid #b5b1a9; border-radius: 4px; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    ul.checklist > li[data-checked="true"]::before { background: #6d7770; border-color: #6d7770; }
    ul.checklist > li[data-checked="true"]::after { content: ""; position: absolute; left: 4.5px; top: calc(.3em + 3px); width: 7px; height: 4px; border-left: 1.7px solid #fff; border-bottom: 1.7px solid #fff; transform: rotate(-45deg); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    ul.checklist > li[data-checked="true"] { color: #8a857c; text-decoration: line-through; }
    .math-field[data-display="true"] { display: block; text-align: center; margin: 8px 0; }
  </style></head><body>${tiles}</body></html>`;
};

/**
 * PDF export goes through the engine's own print pipeline (vector text, native
 * pagination) instead of bundling a PDF library: a hidden same-origin iframe gets a
 * print-only rendering of the document, and the print dialog offers "Save as PDF" in
 * both the browser and the WebView2 shell.
 */
export async function exportDocumentAsPdf(document: InktileDocument, assets: RuntimeAssetMap): Promise<void> {
  const iframe = window.document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  window.document.body.appendChild(iframe);

  const frameDocument = iframe.contentDocument;
  const frameWindow = iframe.contentWindow;
  if (!frameDocument || !frameWindow) {
    iframe.remove();
    throw new Error("PDF export is unavailable in this environment");
  }
  frameDocument.open();
  frameDocument.write(buildPrintHtml(document, assets));
  frameDocument.close();

  // Blob-URL images must be decoded before print snapshots the frame.
  await Promise.all(Array.from(frameDocument.images).map((image) => image.decode().catch(() => undefined)));
  try { await frameDocument.fonts.ready; } catch { /* older engines: print with fallback metrics */ }

  const cleanup = () => iframe.remove();
  frameWindow.addEventListener("afterprint", cleanup, { once: true });
  // Engines that skip afterprint for cancelled dialogs still get the frame removed.
  window.setTimeout(cleanup, 120_000);
  frameWindow.focus();
  frameWindow.print();
}
