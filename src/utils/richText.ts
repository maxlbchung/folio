/**
 * Rich-content behaviors for the contentEditable tiles: checklists, tables, and
 * markdown-style autoformat shortcuts. Everything here manipulates the live DOM of an
 * editable (.text-block / .variant-editor) and reports changes through a bubbling
 * "input" event, so the owning view serializes and commits exactly as it does for a
 * keystroke — persistence, autosave, undo, and the Inkjet revision guard all apply
 * unchanged.
 */

/** Dispatch the same bubbling input event a keystroke produces, so the owning view commits. */
export const notifyInput = (editable: HTMLElement) => {
  editable.dispatchEvent(new Event("input", { bubbles: true }));
};

const BLOCKISH = /^(DIV|P|LI|TD|TH|BLOCKQUOTE|PRE|H[1-6])$/;

const elementOf = (node: Node | null | undefined): HTMLElement | null =>
  node instanceof HTMLElement ? node : node?.parentElement ?? null;

/** Place a collapsed caret at the start (or end) of an element's content. */
export const placeCaretIn = (element: HTMLElement, atStart = true) => {
  const doc = element.ownerDocument;
  const selection = doc.defaultView?.getSelection();
  if (!selection) return;
  const range = doc.createRange();
  range.selectNodeContents(element);
  range.collapse(atStart);
  selection.removeAllRanges();
  selection.addRange(range);
};

// ---------------------------------------------------------------------------
// Checklists — a `ul.checklist` whose items carry `data-checked`; the box itself is a
// CSS ::before in the item's left padding, so the list content stays plain editable text.
// ---------------------------------------------------------------------------

/** Screen-space scale of an element (workspace zoom × UI scale), measured from the DOM so
 * checkbox hit-testing works at any zoom instead of trusting a CSS variable. */
const visualScale = (element: HTMLElement): number =>
  element.offsetWidth > 0 ? element.getBoundingClientRect().width / element.offsetWidth : 1;

// The clickable checkbox region: the li's reserved left padding, first line only.
const CHECKBOX_HIT_WIDTH = 22;
const CHECKBOX_HIT_HEIGHT = 24;

/** The checklist item whose checkbox the pointer landed on, or null for ordinary clicks. */
export const checklistHit = (event: { target: EventTarget | null; clientX: number; clientY: number }): HTMLLIElement | null => {
  const target = event.target instanceof Element ? event.target : null;
  const item = target?.closest<HTMLLIElement>("ul.checklist > li");
  if (!item) return null;
  const rect = item.getBoundingClientRect();
  const scale = visualScale(item);
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  return x >= 0 && x <= CHECKBOX_HIT_WIDTH * scale && y >= 0 && y <= CHECKBOX_HIT_HEIGHT * scale ? item : null;
};

export const toggleChecklistItem = (item: HTMLLIElement) => {
  item.setAttribute("data-checked", item.getAttribute("data-checked") === "true" ? "false" : "true");
};

/** The checklist item holding the caret, or null. Captured before Enter so the fixup below
 * can tell which half of the split is the new item. */
export const checklistCaretItem = (editable: HTMLElement): HTMLLIElement | null => {
  const selection = editable.ownerDocument.defaultView?.getSelection();
  const item = elementOf(selection?.anchorNode)?.closest<HTMLLIElement>("ul.checklist > li");
  return item && editable.contains(item) ? item : null;
};

/** After Enter splits a checklist item, the browser clones the li together with its
 * data-checked attribute; a freshly created item should start unchecked instead. Enter at
 * the item's start leaves the caret in the original li and inserts the new one above it. */
export const fixChecklistAfterEnter = (editable: HTMLElement, previous: HTMLLIElement | null) => {
  if (!previous) return;
  const current = checklistCaretItem(editable);
  if (!current) return;
  if (current !== previous) {
    current.setAttribute("data-checked", "false");
    return;
  }
  const above = current.previousElementSibling;
  if (above instanceof HTMLLIElement && above.hasAttribute("data-checked") && !(above.textContent ?? "").trim()) {
    above.setAttribute("data-checked", "false");
  }
};

/** Turn the selection's list into a checklist (the caller has already ensured a ul exists). */
export const decorateChecklistAtSelection = (editable: HTMLElement, checkFirstItem = false) => {
  const selection = editable.ownerDocument.defaultView?.getSelection();
  const anchor = elementOf(selection?.anchorNode);
  const list = anchor?.closest("ul");
  if (!list || !editable.contains(list)) return;
  list.classList.add("checklist");
  for (const item of Array.from(list.children)) {
    if (item instanceof HTMLLIElement && !item.hasAttribute("data-checked")) item.setAttribute("data-checked", "false");
  }
  if (checkFirstItem) anchor?.closest("li")?.setAttribute("data-checked", "true");
};

/** Strip checklist chrome from the selection's list, leaving a plain bulleted list. */
export const undecorateChecklistAtSelection = (editable: HTMLElement) => {
  const selection = editable.ownerDocument.defaultView?.getSelection();
  const list = elementOf(selection?.anchorNode)?.closest("ul.checklist");
  if (!list || !editable.contains(list)) return;
  list.classList.remove("checklist");
  if (!list.classList.length) list.removeAttribute("class");
  for (const item of Array.from(list.querySelectorAll("li[data-checked]"))) item.removeAttribute("data-checked");
};

/** True when the selection sits inside a checklist (drives the toolbar's active states). */
export const selectionInChecklist = (): boolean => {
  const selection = window.getSelection();
  return Boolean(elementOf(selection?.anchorNode)?.closest("ul.checklist"));
};

/**
 * Self-healing pass run before every serialize: list conversions rebuild elements and can
 * strand checklist attributes on plain lists (or the class on an ol), pasted fragments
 * can bring half-decorated items, and pasted links can carry unsafe schemes. Attribute-only
 * fixes, so the caret is never disturbed.
 */
export const normalizeRichContent = (editable: HTMLElement) => {
  for (const item of Array.from(editable.querySelectorAll("li[data-checked]"))) {
    if (!item.parentElement?.matches("ul.checklist")) item.removeAttribute("data-checked");
  }
  for (const list of Array.from(editable.querySelectorAll("ol.checklist"))) {
    list.classList.remove("checklist");
    if (!list.classList.length) list.removeAttribute("class");
  }
  for (const list of Array.from(editable.querySelectorAll("ul.checklist"))) {
    for (const item of Array.from(list.children)) {
      if (item instanceof HTMLLIElement && !item.hasAttribute("data-checked")) item.setAttribute("data-checked", "false");
    }
  }
  for (const anchor of Array.from(editable.querySelectorAll("a[href]"))) {
    if (!isSafeLinkHref(anchor.getAttribute("href") ?? "")) anchor.removeAttribute("href");
  }
};

// ---------------------------------------------------------------------------
// Links — plain `<a href>` in the stored HTML. Only http(s)/mailto ever open, a plain
// click never navigates the webview (the tile views intercept it), and typing a URL
// followed by a space autolinks it.
// ---------------------------------------------------------------------------

/** Schemes a stored link may carry and the click-open gate accepts. */
export const isSafeLinkHref = (href: string): boolean => /^(https?:|mailto:)/i.test(href.trim());

/** Open a link outside the app (safe schemes only) — the webview itself never navigates. */
export const openLinkExternally = (href: string) => {
  if (isSafeLinkHref(href)) window.open(href, "_blank", "noopener,noreferrer");
};

/** Normalize user-entered link text: bare domains get https://, anything that does not
 * parse as an http(s)/mailto URL is rejected with null. */
export const normalizeLinkUrl = (raw: string): string | null => {
  const value = raw.trim();
  if (!value) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
};

/** The link containing the live selection's anchor point, when inside this editable. */
export const selectionLink = (editable: HTMLElement): HTMLAnchorElement | null => {
  const selection = editable.ownerDocument.defaultView?.getSelection();
  const link = elementOf(selection?.anchorNode)?.closest("a");
  return link && editable.contains(link) ? (link as HTMLAnchorElement) : null;
};

/** Replace an element with its children (used to strip a link but keep its text). */
export const unwrapElement = (element: HTMLElement) => {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  element.remove();
};

/** Seat the caret just after an element, so continued typing stays outside it. */
const placeCaretAfter = (element: HTMLElement) => {
  const doc = element.ownerDocument;
  const selection = doc.defaultView?.getSelection();
  if (!selection) return;
  const range = doc.createRange();
  range.setStartAfter(element);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
};

/**
 * Paste-triggered autolink: when pasted text is a single URL, pasting onto a selection
 * links the selected text and pasting at a caret inserts the URL as linked text. Returns
 * true when handled (the caller suppresses the default paste). Requires an explicit
 * scheme or www./mailto: prefix — bare words are left to the ordinary paste, since almost
 * anything parses as a hostname.
 */
export const insertPastedLink = (pasted: string, editable: HTMLElement, checkpoint: () => void): boolean => {
  const text = pasted.trim();
  if (!text || /\s/.test(text) || !/^(https?:\/\/|www\.|mailto:)/i.test(text)) return false;
  const url = normalizeLinkUrl(text);
  if (!url) return false;
  const doc = editable.ownerDocument;
  const selection = doc.defaultView?.getSelection();
  if (!selection?.rangeCount || !editable.contains(selection.anchorNode)) return false;
  // Inside an existing link, keep the ordinary text paste instead of nesting links.
  if (selectionLink(editable)) return false;
  checkpoint();
  if (selection.isCollapsed) {
    const escapedText = text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const escapedUrl = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    doc.execCommand("insertHTML", false, `<a href="${escapedUrl}">${escapedText}</a>`);
  } else {
    doc.execCommand("createLink", false, url);
  }
  // Continue typing on the baseline after the link, not inside it.
  const link = selectionLink(editable);
  if (link) placeCaretAfter(link);
  notifyInput(editable);
  return true;
};

/** ClipboardEvent adapter for insertPastedLink, used by the views' onPaste. */
export const handleLinkPaste = (clipboard: DataTransfer | null, editable: HTMLElement, checkpoint: () => void): boolean =>
  insertPastedLink(clipboard?.getData("text/plain") ?? "", editable, checkpoint);

/**
 * Space-triggered autolink: when the text just before the caret is an http(s) URL, wrap
 * it in an anchor and insert the space after the link. Only handles the common case of
 * the URL living in one text node — anything odd falls through to plain typing.
 */
export const applyLinkAutoformat = (editable: HTMLElement, checkpoint: () => void): boolean => {
  const doc = editable.ownerDocument;
  const selection = doc.defaultView?.getSelection();
  if (!selection?.isCollapsed || !selection.rangeCount) return false;
  if (selectionLink(editable)) return false;
  const line = lineTextBeforeCaret(editable);
  if (!line) return false;
  const match = line.text.match(/(?:^|\s)(https?:\/\/\S+)$/);
  if (!match) return false;
  const url = match[1].replace(/[),.;:!?\]]+$/, "");
  try {
    new URL(url);
  } catch {
    return false;
  }
  const caret = selection.getRangeAt(0);
  const container = caret.startContainer;
  if (container.nodeType !== Node.TEXT_NODE || caret.startOffset < url.length) return false;
  const nodeText = container.textContent ?? "";
  if (!nodeText.slice(0, caret.startOffset).endsWith(url)) return false;
  checkpoint();
  const urlRange = doc.createRange();
  urlRange.setStart(container, caret.startOffset - url.length);
  urlRange.setEnd(container, caret.startOffset);
  selection.removeAllRanges();
  selection.addRange(urlRange);
  doc.execCommand("createLink", false, url);
  // Continue typing on the baseline after the link, not inside it.
  const link = selectionLink(editable);
  if (link) placeCaretAfter(link);
  doc.execCommand("insertText", false, " ");
  notifyInput(editable);
  return true;
};

// ---------------------------------------------------------------------------
// Tables — a plain `table.text-table` inside the editable flow. Tab walks the cells
// (growing the table from the last cell), and the text context menu edits structure.
// ---------------------------------------------------------------------------

/** Marks a just-inserted table so the toolbar can find it and seat the caret; never stored. */
export const FRESH_TABLE_ATTR = "data-fresh-table";

/** A starter grid: one header row, `rows - 1` body rows. Cells hold a <br> so empty cells
 * keep a caret-sized line box. The trailing div gives the caret a landing line below. */
export const tableHtml = (columns = 3, rows = 3): string => {
  const headerRow = `<tr>${"<th><br></th>".repeat(columns)}</tr>`;
  const bodyRow = `<tr>${"<td><br></td>".repeat(columns)}</tr>`;
  return `<table class="text-table" ${FRESH_TABLE_ATTR}="true"><tbody>${headerRow}${bodyRow.repeat(Math.max(0, rows - 1))}</tbody></table><div><br></div>`;
};

const caretCell = (editable: HTMLElement): HTMLTableCellElement | null => {
  const selection = editable.ownerDocument.defaultView?.getSelection();
  const cell = elementOf(selection?.anchorNode)?.closest<HTMLTableCellElement>("td, th");
  return cell && editable.contains(cell) ? cell : null;
};

/**
 * Tab/Shift+Tab inside a table: step through cells in reading order; Tab on the last cell
 * appends a fresh row and continues there (committed via input event). Returns false when
 * the caret is not in a table so the caller can keep its default Tab behavior.
 */
export const handleTableTab = (editable: HTMLElement, backwards: boolean): boolean => {
  const cell = caretCell(editable);
  if (!cell) return false;
  const table = cell.closest("table");
  if (!table) return false;
  const cells = Array.from(table.querySelectorAll<HTMLTableCellElement>("td, th"));
  const index = cells.indexOf(cell);
  if (index < 0) return false;
  if (backwards) {
    if (index > 0) placeCaretIn(cells[index - 1], false);
    return true;
  }
  if (index < cells.length - 1) {
    placeCaretIn(cells[index + 1]);
    return true;
  }
  const row = cell.closest("tr");
  if (!row) return true;
  const doc = editable.ownerDocument;
  const fresh = doc.createElement("tr");
  for (let column = 0; column < row.cells.length; column += 1) {
    const freshCell = doc.createElement("td");
    freshCell.appendChild(doc.createElement("br"));
    fresh.appendChild(freshCell);
  }
  row.after(fresh);
  placeCaretIn(fresh.cells[0]);
  notifyInput(editable);
  return true;
};

/** The collapsed caret's client rect, or null when it has no usable geometry (e.g. an
 * empty cell whose only child is a <br>). */
const caretClientRect = (editable: HTMLElement): DOMRect | null => {
  const selection = editable.ownerDocument.defaultView?.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const rects = range.getClientRects();
  if (rects.length) return rects[0];
  const rect = range.getBoundingClientRect();
  return rect.width || rect.height ? rect : null;
};

/**
 * Up/Down arrows inside a table step between rows, keeping the column. A multi-line cell
 * keeps the browser's native line movement until the caret reaches its boundary line
 * (measured against the cell's line-height). Returns false to keep the default behavior —
 * including on the first/last row, where the caret should leave the table naturally.
 */
export const handleTableArrow = (editable: HTMLElement, up: boolean): boolean => {
  const cell = caretCell(editable);
  if (!cell) return false;
  const row = cell.closest("tr");
  const table = row?.closest("table");
  if (!row || !table) return false;
  const rows = Array.from(table.querySelectorAll<HTMLTableRowElement>("tr"));
  const target = rows[rows.indexOf(row) + (up ? -1 : 1)];
  if (!target) return false;
  const rect = caretClientRect(editable);
  if (rect) {
    const cellRect = cell.getBoundingClientRect();
    // Scaled to screen space so the check holds at any workspace zoom.
    const line = (parseFloat(getComputedStyle(cell).lineHeight) || 20) * visualScale(cell);
    if (up ? rect.top - cellRect.top > line * 0.8 : cellRect.bottom - rect.bottom > line * 0.8) return false;
  }
  const targetCell = target.cells[Math.min(cell.cellIndex, target.cells.length - 1)];
  if (!targetCell) return false;
  placeCaretIn(targetCell, !up);
  return true;
};

export type TableEdit = "row-above" | "row-below" | "column-left" | "column-right" | "delete-row" | "delete-column" | "delete-table";

/** Structural table edits for the context menu. The caller dispatches the input event. */
export const editTable = (cell: HTMLTableCellElement, edit: TableEdit) => {
  const doc = cell.ownerDocument;
  const row = cell.closest("tr");
  const table = cell.closest("table");
  if (!row || !table) return;
  const rows = Array.from(table.querySelectorAll("tr"));
  const freshCell = (tag: string) => {
    const created = doc.createElement(tag);
    created.appendChild(doc.createElement("br"));
    return created;
  };
  switch (edit) {
    case "row-above":
    case "row-below": {
      const fresh = doc.createElement("tr");
      for (let column = 0; column < row.cells.length; column += 1) fresh.appendChild(freshCell("td"));
      if (edit === "row-above") row.before(fresh);
      else row.after(fresh);
      break;
    }
    case "column-left":
    case "column-right": {
      const index = cell.cellIndex;
      for (const current of rows) {
        const reference = current.cells[index];
        const fresh = freshCell(reference?.tagName.toLowerCase() ?? "td");
        if (!reference) current.appendChild(fresh);
        else if (edit === "column-left") reference.before(fresh);
        else reference.after(fresh);
      }
      break;
    }
    case "delete-row":
      row.remove();
      if (!table.querySelector("td, th")) table.remove();
      break;
    case "delete-column": {
      const index = cell.cellIndex;
      for (const current of rows) current.cells[index]?.remove();
      if (!table.querySelector("td, th")) table.remove();
      break;
    }
    case "delete-table":
      table.remove();
      break;
  }
};

// ---------------------------------------------------------------------------
// Markdown autoformat — line-start markers convert on the space (or Enter for ---) that
// follows them. The literal marker is checkpointed away, so one undo restores it.
// ---------------------------------------------------------------------------

type AutoformatKind = "bullets" | "numbers" | "checklist" | "checked" | "heading" | "subheading";

const MARKERS: { pattern: RegExp; kind: AutoformatKind }[] = [
  { pattern: /^[-*]$/, kind: "bullets" },
  { pattern: /^\d{1,2}[.)]$/, kind: "numbers" },
  { pattern: /^\[( )?\]$/, kind: "checklist" },
  { pattern: /^\[[xX]\]$/, kind: "checked" },
  { pattern: /^#$/, kind: "heading" },
  { pattern: /^##$/, kind: "subheading" }
];

/** The caret's line container: its nearest block-ish ancestor, or the editable itself for
 * the first, unwrapped line. */
const lineContainerOf = (node: Node, editable: HTMLElement): HTMLElement => {
  for (let element = elementOf(node); element && element !== editable; element = element.parentElement) {
    if (BLOCKISH.test(element.tagName)) return element;
  }
  return editable;
};

/** The text between the caret's line start and the caret. Null when there is no usable
 * collapsed caret inside the editable. */
const lineTextBeforeCaret = (editable: HTMLElement): { text: string; range: Range } | null => {
  const selection = editable.ownerDocument.defaultView?.getSelection();
  if (!selection?.isCollapsed || !selection.rangeCount) return null;
  const caret = selection.getRangeAt(0);
  if (!editable.contains(caret.startContainer)) return null;
  const line = lineContainerOf(caret.startContainer, editable);
  const range = editable.ownerDocument.createRange();
  range.setStart(line, 0);
  range.setEnd(caret.startContainer, caret.startOffset);
  return { text: range.toString(), range };
};

/** Select and delete the literal marker through execCommand, keeping the browser's own
 * content normalization. */
const removeMarker = (editable: HTMLElement, range: Range) => {
  const selection = editable.ownerDocument.defaultView?.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
  editable.ownerDocument.execCommand("delete");
};

/**
 * Space-triggered conversions: `- `/`* ` bullets, `1. ` numbers, `[] `/`[x] ` checklist,
 * `# `/`## ` heading sizes (the toolbar's Heading/Large buckets). Returns true when a
 * conversion ran (the caller prevents the space). `checkpoint` records the pre-conversion
 * document, so undo brings the literal marker back.
 */
export const applyAutoformat = (editable: HTMLElement, checkpoint: () => void): boolean => {
  const doc = editable.ownerDocument;
  const line = lineTextBeforeCaret(editable);
  if (!line) return false;
  const selection = doc.defaultView?.getSelection();
  // Already inside a list item: leave typed markers alone (they are prose there).
  if (elementOf(selection?.anchorNode)?.closest("li")) return false;
  const marker = MARKERS.find((entry) => entry.pattern.test(line.text));
  if (!marker) return false;
  checkpoint();
  removeMarker(editable, line.range);
  doc.execCommand("styleWithCSS", false, "true");
  switch (marker.kind) {
    case "bullets":
      doc.execCommand("insertUnorderedList");
      break;
    case "numbers":
      doc.execCommand("insertOrderedList");
      break;
    case "checklist":
    case "checked":
      doc.execCommand("insertUnorderedList");
      decorateChecklistAtSelection(editable, marker.kind === "checked");
      break;
    case "heading":
      doc.execCommand("fontSize", false, "5");
      break;
    case "subheading":
      doc.execCommand("fontSize", false, "4");
      break;
  }
  notifyInput(editable);
  return true;
};

/** Enter on a line holding exactly `---` becomes a horizontal rule. */
export const applyRuleAutoformat = (editable: HTMLElement, checkpoint: () => void): boolean => {
  const line = lineTextBeforeCaret(editable);
  if (!line || line.text !== "---") return false;
  checkpoint();
  removeMarker(editable, line.range);
  editable.ownerDocument.execCommand("insertHorizontalRule");
  notifyInput(editable);
  return true;
};
