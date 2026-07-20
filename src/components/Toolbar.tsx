import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDocument } from "../document/DocumentContext";
import { saveDocumentFile } from "../persistence/fileSystem";
import { exportDocumentAsPdf, exportDocumentAsText } from "../persistence/exportDocument";
import { writeAutosave } from "../persistence/autosave";
import { saveLibraryInktile } from "../persistence/library";
import { ExportDialog, type ExportFormat } from "./ExportDialog";
import { ZWSP } from "../utils/editorHtml";
import {
  AlignBottomIcon, AlignCenterIcon, AlignLeftIcon, AlignMiddleIcon, AlignRightIcon, AlignTopIcon,
  BulletListIcon, ExportIcon, HighlighterIcon,
  HomeIcon, NumberedListIcon, RedoIcon, RemoveFormatIcon, SaveIcon, UndoIcon,
  ZoomInIcon, ZoomOutIcon
} from "./icons";

interface ToolbarProps {
  onStatus: (message: string) => void;
  onHome: () => void;
  onNewDocument: () => void;
  onOpenDocument: () => Promise<void>;
  onSave: () => Promise<void>;
}

// Single source of truth for the two dropdowns: used both to render the options and to
// map the browser's queryCommand* readings back onto a known option when the selection moves.
const FONT_FAMILIES = [
  { value: "Arial", label: "Arial" },
  { value: "Georgia", label: "Georgia" },
  { value: "Times New Roman", label: "Times New Roman" },
  { value: "Trebuchet MS", label: "Trebuchet" },
  { value: "Courier New", label: "Courier" }
];
// value = the legacy execCommand("fontSize") bucket (1-7) the label maps to.
const FONT_SIZES = [
  { value: "3", label: "Normal" },
  { value: "2", label: "Small" },
  { value: "4", label: "Large" },
  { value: "5", label: "Heading" },
  { value: "6", label: "Display" }
];

/**
 * Swatches for the two color popovers. The `light` value is canonical — it is what
 * execCommand writes into the document (so archives stay theme-independent and the
 * print/PDF pipeline, which renders on white, needs no mapping). ONLY GREYSCALE swatches
 * carry a `dark` value and mirror in dark mode (black ↔ white, greys flip lightness);
 * hue swatches have no `dark` value and render identically in both themes — this split is
 * the product contract, not an omission. The mirroring itself is applied by the injected
 * stylesheet below.
 */
interface ColorSwatch { light: string; dark?: string; }

const TEXT_COLORS: ColorSwatch[] = [
  { light: "#1d1d1b", dark: "#efefe9" },
  { light: "#6d7178", dark: "#9aa1ab" },
  { light: "#b3b7bd", dark: "#585d64" },
  { light: "#ffffff", dark: "#000000" },
  { light: "#c0392b" },
  { light: "#e2711d" },
  { light: "#d4a017" },
  { light: "#27ae60" },
  { light: "#16a085" },
  { light: "#2f80cf" },
  { light: "#8e44ad" },
  { light: "#d81b60" }
];
const HIGHLIGHT_COLORS: ColorSwatch[] = [
  { light: "#fff59d" },
  { light: "#ffcc80" },
  { light: "#a5d6a7" },
  { light: "#80deea" },
  { light: "#90caf9" },
  { light: "#ce93d8" },
  { light: "#f48fb1" },
  { light: "#e0e0e0", dark: "#4c4e50" }
];

const isDarkTheme = () => window.document.documentElement.dataset.theme === "dark";

/** The value a swatch should display as under the current theme. */
const displayColor = (canonical: string, palette: ColorSwatch[]): string =>
  isDarkTheme() ? palette.find((swatch) => swatch.light === canonical)?.dark ?? canonical : canonical;

/** Map a computed color (either theme's rendering) back to its canonical light value. */
const canonicalColor = (hex: string, palette: ColorSwatch[]): string =>
  palette.find((swatch) => swatch.light === hex || swatch.dark === hex)?.light ?? hex;

const hexToRgb = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

/**
 * Dark-mode rendering of the palette: documents store canonical light-theme colors as
 * inline styles, and these rules restyle the GREYSCALE values inside the editable tiles —
 * hue swatches have no dark variant and keep their stored color in both themes. Pale
 * highlights also keep their color, so a highlighted run renders as a "light-mode island":
 * default text inside it drops back to the light text color and mirrored greyscale text
 * keeps its light value, exactly as the run looks in light mode. Chromium serializes
 * inline colors as "prop: rgb(r, g, b)", which is what the attribute substring selectors
 * match. Injected once, generated from the palettes so they cannot drift apart; left in
 * place for the app's lifetime.
 */
const ensureDarkColorStyles = () => {
  const doc = window.document;
  if (doc.getElementById("theme-text-colors")) return;
  const scope = ':root[data-theme="dark"] :is(.text-block, .variant-editor)';
  const attr = (prop: string, swatch: ColorSwatch) => `[style*="${prop}: ${hexToRgb(swatch.light)}"]`;
  const mirroredText = TEXT_COLORS.filter((swatch) => swatch.dark);
  const paleSelectors = HIGHLIGHT_COLORS.filter((swatch) => !swatch.dark).map((swatch) => attr("background-color", swatch));
  const rules: string[] = [];
  for (const swatch of mirroredText) {
    rules.push(`${scope} ${attr("color", swatch)} { color: ${swatch.dark} !important; }`);
    // Inside a pale highlight the mirror is undone (the two-attribute selectors outweigh
    // the single-attribute mirror above), covering both merged spans and nested ones.
    const exceptions = paleSelectors.flatMap((selector) => [
      `${scope} ${selector}${attr("color", swatch)}`,
      `${scope} ${selector} ${attr("color", swatch)}`
    ]);
    rules.push(`${exceptions.join(", ")} { color: ${swatch.light} !important; }`);
  }
  // Default (uncolored) text inside a pale highlight inherits the light text color; hue
  // text keeps winning through its inline style.
  rules.push(`${paleSelectors.map((selector) => `${scope} ${selector}`).join(", ")} { color: ${TEXT_COLORS[0].light}; }`);
  // The greyscale highlight mirrors just like greyscale text does.
  for (const swatch of HIGHLIGHT_COLORS.filter((s) => s.dark)) {
    rules.push(`${scope} ${attr("background-color", swatch)} { background-color: ${swatch.dark} !important; }`);
  }
  const style = doc.createElement("style");
  style.id = "theme-text-colors";
  style.textContent = rules.join("\n");
  doc.head.appendChild(style);
};

interface FormatState {
  fontName: string;
  fontSize: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikeThrough: boolean;
  subscript: boolean;
  superscript: boolean;
  /** Hex text color of the selection; "" = document default. */
  foreColor: string;
  /** Hex highlight color of the selection; "" = none. */
  hiliteColor: string;
  unorderedList: boolean;
  orderedList: boolean;
  align: "left" | "center" | "right";
}

const DEFAULT_FORMAT: FormatState = {
  fontName: "Arial", fontSize: "3", bold: false, italic: false, underline: false, strikeThrough: false,
  subscript: false, superscript: false, foreColor: "", hiliteColor: "", unorderedList: false, orderedList: false,
  align: "left"
};

// queryCommandValue returns computed colors ("rgb(29, 29, 27)"); reduce to lowercase hex so
// they compare against the palette swatches. Transparent/unparseable → "" (no color).
const cssColorToHex = (raw: string): string => {
  const value = (raw || "").trim().toLowerCase();
  if (!value || value === "transparent") return "";
  if (value.startsWith("#")) return value.length === 4 ? `#${[...value.slice(1)].map((c) => c + c).join("")}` : value;
  const match = value.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.%]+))?\s*\)/);
  if (!match) return "";
  if (match[4] !== undefined && parseFloat(match[4]) === 0) return "";
  const hex = (part: string) => Number(part).toString(16).padStart(2, "0");
  return `#${hex(match[1])}${hex(match[2])}${hex(match[3])}`;
};

// queryCommandValue("fontName") returns the resolved font-family, which may be quoted and/or a
// full fallback stack ("Arial, Helvetica, sans-serif"). Reduce it to a known option, defaulting
// to Arial when the selection uses a font outside the dropdown (matches the Arial default rule).
const normalizeFontName = (raw: string): string => {
  const first = (raw || "").split(",")[0].trim().replace(/^["']|["']$/g, "");
  return FONT_FAMILIES.find((font) => font.value.toLowerCase() === first.toLowerCase())?.value ?? "Arial";
};

interface ColorMenuProps {
  anchor: DOMRect;
  colors: ColorSwatch[];
  columns: number;
  /** Canonical (light) value of the current color; compared against swatch.light. */
  activeColor: string;
  defaultLabel: string;
  /** Receives the canonical (light) value; null = the default/none entry. */
  onPick: (color: string | null) => void;
  onClose: () => void;
}

/** Swatch-grid popover for the text/highlight color buttons. Portaled to <body> because the
 * toolbar scrolls horizontally and would clip an absolutely positioned dropdown. */
function ColorMenu({ anchor, colors, columns, activeColor, defaultLabel, onPick, onClose }: ColorMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(anchor.left);

  // Clamp to the viewport once measured so the grid never spills off-screen.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    setLeft(Math.max(8, Math.min(anchor.left, window.innerWidth - menu.offsetWidth - 8)));
  }, [anchor.left]);

  useEffect(() => {
    const handlePointer = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      // The swatch toolbar buttons toggle the menu themselves in onClick; closing here too
      // would make that click immediately reopen it.
      if (menuRef.current?.contains(target as Node) || target?.closest(".format-button--swatch")) return;
      onClose();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", handlePointer, true);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", handlePointer, true);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  return createPortal(
    // Prevent mousedown default so the editable tile keeps focus + selection while picking.
    <div
      ref={menuRef}
      className="color-menu"
      role="menu"
      style={{ left, top: anchor.bottom + 6 }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button className="color-menu__default" role="menuitem" onClick={() => onPick(null)}>
        <span className="color-menu__none-swatch" aria-hidden />{defaultLabel}
      </button>
      <div className="color-menu__grid" style={{ gridTemplateColumns: `repeat(${columns}, 20px)` }}>
        {colors.map((swatch) => {
          // Swatches preview what the color will look like in the current theme (only
          // greyscale swatches have a dark rendering; hues look the same in both).
          const shown = isDarkTheme() ? swatch.dark ?? swatch.light : swatch.light;
          return (
            <button
              key={swatch.light}
              role="menuitem"
              className={`color-menu__swatch ${swatch.light === activeColor ? "is-active" : ""}`}
              style={{ background: shown }}
              title={shown}
              aria-label={`Color ${shown}`}
              onClick={() => onPick(swatch.light)}
            />
          );
        })}
      </div>
    </div>,
    window.document.body
  );
}

export function Toolbar({ onStatus, onHome, onNewDocument, onOpenDocument, onSave }: ToolbarProps) {
  const {
    document, assets, dirty, currentPath, setCurrentPath, markSaved,
    updateTitle, setPageVerticalAlign, undo, redo, canUndo, canRedo
  } = useDocument();
  const [busy, setBusy] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [format, setFormat] = useState<FormatState>(DEFAULT_FORMAT);
  const [colorMenu, setColorMenu] = useState<{ kind: "fore" | "hilite"; anchor: DOMRect } | null>(null);
  const editableRef = useRef<HTMLElement | null>(null);
  const selectionRef = useRef<Range | null>(null);
  // "Stored marks" for a collapsed caret, ProseMirror-style: toggling a style with no text
  // selected sets a pending typing style the browser won't report back through
  // queryCommandState until you actually type. We remember the intended value here, keyed to
  // the caret position, so the toolbar reflects the toggle immediately and stays honest.
  const storedMarksRef = useRef<{ node: Node; offset: number; marks: Partial<FormatState> } | null>(null);

  // Record the pending style(s) for the current collapsed caret. Merges onto an existing
  // record only when the caret has not moved, so a second toggle at the same spot stacks.
  const rememberPendingMarks = (marks: Partial<FormatState>) => {
    const selection = window.getSelection();
    if (!selection?.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const previous = storedMarksRef.current;
    const sameCaret = previous != null && previous.node === range.startContainer && previous.offset === range.startOffset;
    storedMarksRef.current = {
      node: range.startContainer,
      offset: range.startOffset,
      marks: sameCaret ? { ...previous.marks, ...marks } : { ...marks }
    };
  };

  // Read the formatting of the current selection/caret so the toolbar reflects it. Called
  // whenever the selection moves into a text tile, so switching tiles updates the controls
  // instead of leaving them showing the previous tile's font, size, and active styles.
  const syncFormatState = () => {
    const doc = window.document;
    const selection = window.getSelection();
    // Discard pending marks once the caret leaves the position where they were set (typing a
    // character or clicking elsewhere both move it), so they never bleed into other text.
    const stored = storedMarksRef.current;
    if (stored) {
      const range = selection?.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null;
      if (!range || range.startContainer !== stored.node || range.startOffset !== stored.offset) {
        storedMarksRef.current = null;
      }
    }
    const marks = storedMarksRef.current?.marks;
    const rawSize = doc.queryCommandValue("fontSize");
    // marks?.x ?? query: a stored value wins even when it is `false` (?? only falls through on
    // null/undefined), which is exactly the "toggle bold off" case the query gets wrong.
    const next: FormatState = {
      fontName: marks?.fontName ?? normalizeFontName(doc.queryCommandValue("fontName")),
      fontSize: marks?.fontSize ?? (FONT_SIZES.some((size) => size.value === rawSize) ? rawSize : "3"),
      bold: marks?.bold ?? doc.queryCommandState("bold"),
      italic: marks?.italic ?? doc.queryCommandState("italic"),
      underline: marks?.underline ?? doc.queryCommandState("underline"),
      strikeThrough: marks?.strikeThrough ?? doc.queryCommandState("strikeThrough"),
      subscript: marks?.subscript ?? doc.queryCommandState("subscript"),
      superscript: marks?.superscript ?? doc.queryCommandState("superscript"),
      // Computed colors reflect the active theme's rendering (the injected dark-mode rules
      // override the stored values), so both are mapped back to their canonical swatch.
      foreColor: marks?.foreColor ?? canonicalColor(cssColorToHex(doc.queryCommandValue("foreColor")), TEXT_COLORS),
      // backColor reads the effective (inherited) background, so plain text reports the page
      // color rather than "" — harmless, since it only drives the active-swatch highlight.
      hiliteColor: marks?.hiliteColor ?? canonicalColor(cssColorToHex(doc.queryCommandValue("backColor")), HIGHLIGHT_COLORS),
      unorderedList: doc.queryCommandState("insertUnorderedList"),
      orderedList: doc.queryCommandState("insertOrderedList"),
      align: doc.queryCommandState("justifyCenter") ? "center" : doc.queryCommandState("justifyRight") ? "right" : "left"
    };
    // Keep the same object when nothing changed so frequent selectionchange events during
    // typing don't trigger needless re-renders.
    setFormat((prev) =>
      (Object.keys(next) as (keyof FormatState)[]).every((key) => prev[key] === next[key]) ? prev : next
    );
  };

  const captureTextSelection = () => {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const node = selection.anchorNode;
    const element = node instanceof Element ? node : node?.parentElement;
    const editable = element?.closest<HTMLElement>(".text-block, .variant-editor");
    if (!editable) return;
    const pageId = editable.closest<HTMLElement>("[data-page-id]")?.dataset.pageId;
    editableRef.current = editable;
    selectionRef.current = selection.getRangeAt(0).cloneRange();
    if (pageId) setSelectedPageId(pageId);
    syncFormatState();
  };

  // `marks` is the resulting toolbar state for this command; when the caret is collapsed it is
  // remembered as a pending typing style so the controls update at once (see storedMarksRef).
  const applyTextCommand = (command: string, value?: string, marks?: Partial<FormatState>) => {
    const editable = editableRef.current;
    const range = selectionRef.current;
    if (!editable || !range) return;
    editable.focus();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    window.document.execCommand("styleWithCSS", false, "true");
    window.document.execCommand(command, false, value);
    editable.dispatchEvent(new Event("input", { bubbles: true }));
    if (marks) rememberPendingMarks(marks);
    captureTextSelection();
  };

  // Sub/superscript at a collapsed caret can't go through execCommand: the browser only
  // records a pending typing style, so the caret would not visibly drop/raise until the
  // first keystroke. Instead the caret is moved into (or out of) a real <sub>/<sup>
  // element immediately, anchored by a zero-width space the tile views strip from stored
  // HTML (see stripCaretArtifacts). With a real selection this defers to applyTextCommand.
  const applyScriptCommand = (kind: "subscript" | "superscript") => {
    const editable = editableRef.current;
    const range = selectionRef.current;
    if (!editable || !range) return;
    const marks: Partial<FormatState> = kind === "subscript"
      ? { subscript: !format.subscript, superscript: false }
      : { superscript: !format.superscript, subscript: false };
    if (!range.collapsed) {
      applyTextCommand(kind, undefined, marks);
      return;
    }
    editable.focus();
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
    const doc = window.document;
    const tag = kind === "superscript" ? "sup" : "sub";
    const caret = selection.getRangeAt(0);
    // The caret's enclosing script region: a <sub>/<sup> (what this handler inserts) or a
    // vertical-align span (what execCommand's styleWithCSS path produces for a selection).
    const scriptKindOf = (element: HTMLElement): "subscript" | "superscript" | null => {
      const name = element.tagName.toLowerCase();
      if (name === "sub" || element.style.verticalAlign === "sub") return "subscript";
      if (name === "sup" || element.style.verticalAlign === "super") return "superscript";
      return null;
    };
    let inside: HTMLElement | null = null;
    for (
      let element = caret.startContainer instanceof Element ? caret.startContainer as HTMLElement : caret.startContainer.parentElement;
      element && element !== editable;
      element = element.parentElement
    ) {
      if (scriptKindOf(element)) { inside = element; break; }
    }
    const placeCaret = (node: Node, offset: number) => {
      const next = doc.createRange();
      next.setStart(node, offset);
      next.collapse(true);
      selection.removeAllRanges();
      selection.addRange(next);
    };
    const newScriptElement = () => {
      const element = doc.createElement(tag);
      element.textContent = ZWSP;
      return element;
    };
    if (!inside) {
      // Plain text → enter a fresh script element.
      const element = newScriptElement();
      caret.insertNode(element);
      placeCaret(element.firstChild as Node, 1);
    } else {
      // "At the region's end" must be measured as remaining text, not compared boundary
      // points: a caret at the end of the region's last text node compares as *before*
      // the [element, childCount] boundary. Anchor ZWSPs don't count — they're invisible.
      const tail = doc.createRange();
      tail.setStart(caret.startContainer, caret.startOffset);
      tail.setEnd(inside, inside.childNodes.length);
      if (tail.toString().split(ZWSP).join("").length > 0) {
        // Caret mid-element: exiting here would teleport it, so keep the browser's
        // pending-typing-style behavior for this rare case.
        applyTextCommand(kind, undefined, marks);
        return;
      }
      if (scriptKindOf(inside) === kind) {
        // Toggling off at the region's end → step out to the baseline just after it. The
        // anchor must be a baseline-styled span rather than a bare text node: Chromium
        // canonicalizes a caret in a zero-width text node back to the visually equivalent
        // end of the script element, which would keep the caret raised until typing.
        const anchor = doc.createElement("span");
        anchor.style.verticalAlign = "baseline";
        anchor.textContent = ZWSP;
        inside.after(anchor);
        placeCaret(anchor.firstChild as Node, 1);
      } else {
        // Switching sub ↔ sup → continue in a new element of the other kind.
        const element = newScriptElement();
        inside.after(element);
        placeCaret(element.firstChild as Node, 1);
      }
    }
    editable.dispatchEvent(new Event("input", { bubbles: true }));
    captureTextSelection();
  };

  const scriptButtonProps = (kind: "subscript" | "superscript", active: boolean) => ({
    onMouseDown: (event: React.MouseEvent<HTMLButtonElement>) => event.preventDefault(),
    onClick: () => applyScriptCommand(kind),
    className: `format-button format-button--script ${active ? "is-active" : ""}`.trim()
  });

  const toggleColorMenu = (kind: "fore" | "hilite") => (event: React.MouseEvent<HTMLButtonElement>) => {
    const anchor = event.currentTarget.getBoundingClientRect();
    setColorMenu((current) => (current?.kind === kind ? null : { kind, anchor }));
  };

  // null = the "Default color" / "No highlight" entry. There is no execCommand to *remove* a
  // color, so default text color applies the first swatch — the canonical light-theme text
  // color, which the dark-mode rules render as the dark theme's text color — and
  // no-highlight applies transparent.
  const pickColor = (kind: "fore" | "hilite", color: string | null) => {
    setColorMenu(null);
    if (kind === "fore") {
      const value = color ?? TEXT_COLORS[0].light;
      applyTextCommand("foreColor", value, { foreColor: value });
    } else {
      applyTextCommand("hiliteColor", color ?? "transparent", { hiliteColor: color ?? "" });
    }
  };

  const formatButtonProps = (command: string, active = false, extraClass = "", marks?: Partial<FormatState>) => ({
    onMouseDown: (event: React.MouseEvent<HTMLButtonElement>) => event.preventDefault(),
    onClick: () => applyTextCommand(command, undefined, marks),
    className: `format-button ${extraClass} ${active ? "is-active" : ""}`.replace(/\s+/g, " ").trim()
  });

  const verticalAlignButtonProps = (alignment: "top" | "center" | "bottom") => ({
    onMouseDown: (event: React.MouseEvent<HTMLButtonElement>) => event.preventDefault(),
    onClick: () => {
      if (selectedPageId) setPageVerticalAlign(selectedPageId, alignment);
    },
    disabled: !selectedPageId,
    className: `format-button ${selectedPageId && document.pages[selectedPageId]?.verticalAlign === alignment ? "is-active" : ""}`
  });

  useEffect(ensureDarkColorStyles, []);

  useEffect(() => {
    const capture = () => captureTextSelection();
    window.document.addEventListener("selectionchange", capture);
    return () => window.document.removeEventListener("selectionchange", capture);
  }, []);

  useEffect(() => {
    window.document.documentElement.style.setProperty("--editor-zoom", String(zoom));
    return () => { window.document.documentElement.style.removeProperty("--editor-zoom"); };
  }, [zoom]);

  const changeZoom = (delta: number) => setZoom((current) => Math.min(2.0, Math.max(.1, Math.round((current + delta) * 10) / 10)));

  const save = async (forceDialog = false) => {
    setBusy(true);
    try {
      if (!forceDialog) {
        // Ctrl+S is only an immediate flush of the same serialized persistence the
        // debounced autosave uses (library + autosave record + native currentPath).
        await onSave();
        onStatus("Saved");
        return;
      }
      const result = await saveDocumentFile(document, assets, currentPath, true);
      if (!result.cancelled) {
        setCurrentPath(result.path);
        markSaved();
        await Promise.all([
          writeAutosave(document, assets, result.path, false),
          saveLibraryInktile(document, assets, result.path)
        ]).catch(() => undefined);
        onStatus("Saved");
      }
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const open = async () => {
    setBusy(true);
    try {
      await onOpenDocument();
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Open failed");
    } finally {
      setBusy(false);
    }
  };

  const exportAs = async (format: ExportFormat) => {
    setExportOpen(false);
    if (format === "inktile") {
      await save(true);
      return;
    }
    setBusy(true);
    try {
      if (format === "txt") {
        const result = await exportDocumentAsText(document);
        onStatus(result.cancelled ? "Export cancelled" : "Text file exported");
      } else {
        // Status goes up first: print() blocks this task while the dialog is open.
        onStatus("Choose “Save as PDF” in the print dialog");
        await exportDocumentAsPdf(document, assets);
      }
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Export failed");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const command = event.ctrlKey || event.metaKey;
      if (!command) return;
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save(event.shiftKey);
      } else if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        void open();
      } else if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        onNewDocument();
      } else if (event.key.toLowerCase() === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if ((event.key.toLowerCase() === "z" && event.shiftKey) || event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      } else if (!event.shiftKey && (event.key.toLowerCase() === "b" || event.key.toLowerCase() === "i" || event.key.toLowerCase() === "u")) {
        // Bold/italic/underline shortcuts must run through the same path as the toolbar buttons
        // rather than the browser's native contentEditable handler -- otherwise the pending
        // typing style at a collapsed caret never becomes a stored mark and the toolbar
        // highlight lags until the next keystroke (see storedMarksRef / applyTextCommand).
        const active = window.document.activeElement;
        const editable = active instanceof HTMLElement ? active.closest<HTMLElement>(".text-block, .variant-editor") : null;
        if (!editable) return;
        event.preventDefault();
        captureTextSelection();
        const key = event.key.toLowerCase();
        if (key === "b") applyTextCommand("bold", undefined, { bold: !format.bold });
        else if (key === "i") applyTextCommand("italic", undefined, { italic: !format.italic });
        else applyTextCommand("underline", undefined, { underline: !format.underline });
      } else if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        changeZoom(.1);
      } else if (event.key === "-") {
        event.preventDefault();
        changeZoom(-.1);
      } else if (event.key === "0") {
        event.preventDefault();
        setZoom(1);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  useEffect(() => {
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const delta = event.deltaY > 0 ? -.1 : .1;
      changeZoom(delta);
    };
    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => window.removeEventListener("wheel", handleWheel);
  }, []);

  return (
    <header className="topbar">
      <div className="topbar__main">
        <div className="topbar__cluster">
          <input
            className="document-title"
            value={document.title}
            onChange={(event) => updateTitle(event.target.value)}
            aria-label="Document title"
          />
          <span className="topbar__divider" />
          <button className="icon-button" title="Back to inktiles" aria-label="Back to inktiles" onClick={onHome}><HomeIcon /></button>
          <button
            className="icon-button"
            title="Save (Ctrl+S)"
            aria-label="Save"
            onClick={() => void save(false)}
            disabled={busy}
          ><SaveIcon /></button>
          <button
            className="icon-button"
            title="Export…"
            aria-label="Export"
            aria-haspopup="dialog"
            aria-expanded={exportOpen}
            onClick={() => setExportOpen(true)}
            disabled={busy}
          ><ExportIcon /></button>
          <span className={`save-dot ${dirty ? "save-dot--dirty" : ""}`} title={dirty ? "Unsaved changes" : "Saved"} />
        </div>

        <div className="topbar__cluster topbar__cluster--right">
          <button className="icon-button" title="Undo" disabled={!canUndo} onClick={undo}><UndoIcon /></button>
          <button className="icon-button" title="Redo" disabled={!canRedo} onClick={redo}><RedoIcon /></button>
          <span className="topbar__divider" />
          <button className="icon-button" title="Zoom out (Ctrl+-)" disabled={zoom <= .1} onClick={() => changeZoom(-.1)}><ZoomOutIcon /></button>
          <button className="zoom-value" title="Reset zoom (Ctrl+0)" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button className="icon-button" title="Zoom in (Ctrl++)" disabled={zoom >= 2.0} onClick={() => changeZoom(.1)}><ZoomInIcon /></button>
        </div>
      </div>

      <div className="text-toolbar" aria-label="Text formatting">
        <select aria-label="Font family" value={format.fontName} onPointerDown={captureTextSelection} onChange={(event) => applyTextCommand("fontName", event.target.value, { fontName: normalizeFontName(event.target.value) })}>
          {FONT_FAMILIES.map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}
        </select>
        <select aria-label="Font size" value={format.fontSize} onPointerDown={captureTextSelection} onChange={(event) => applyTextCommand("fontSize", event.target.value, { fontSize: event.target.value })}>
          {FONT_SIZES.map((size) => <option key={size.value} value={size.value}>{size.label}</option>)}
        </select>
        <span className="text-toolbar__divider" />
        <button title="Bold (Ctrl+B)" aria-label="Bold" {...formatButtonProps("bold", format.bold, "", { bold: !format.bold })}><strong>B</strong></button>
        <button title="Italic (Ctrl+I)" aria-label="Italic" {...formatButtonProps("italic", format.italic, "", { italic: !format.italic })}><em>I</em></button>
        <button title="Underline (Ctrl+U)" aria-label="Underline" {...formatButtonProps("underline", format.underline, "format-button--underline", { underline: !format.underline })}>U</button>
        <button title="Strikethrough" aria-label="Strikethrough" {...formatButtonProps("strikeThrough", format.strikeThrough, "format-button--strike", { strikeThrough: !format.strikeThrough })}>S</button>
        {/* Glyphs wrapped in a span: the button is a grid, and bare children would be laid
            out as separate stacked grid items, breaking the X²/X₂ rendering. */}
        <button title="Subscript" aria-label="Subscript" {...scriptButtonProps("subscript", format.subscript)}><span>X<sub>2</sub></span></button>
        <button title="Superscript" aria-label="Superscript" {...scriptButtonProps("superscript", format.superscript)}><span>X<sup>2</sup></span></button>
        <span className="text-toolbar__divider" />
        <button
          title="Text color" aria-label="Text color" aria-haspopup="menu" aria-expanded={colorMenu?.kind === "fore"}
          className="format-button format-button--swatch"
          onMouseDown={(event) => event.preventDefault()}
          onClick={toggleColorMenu("fore")}
        >
          <span className="swatch-glyph">A</span>
          <span className="swatch-bar" style={{ background: format.foreColor ? displayColor(format.foreColor, TEXT_COLORS) : "var(--text)" }} />
        </button>
        <button
          title="Highlight color" aria-label="Highlight color" aria-haspopup="menu" aria-expanded={colorMenu?.kind === "hilite"}
          className="format-button format-button--swatch"
          onMouseDown={(event) => event.preventDefault()}
          onClick={toggleColorMenu("hilite")}
        >
          <HighlighterIcon size={13} />
          <span className="swatch-bar swatch-bar--outlined" style={{ background: HIGHLIGHT_COLORS.some((swatch) => swatch.light === format.hiliteColor) ? displayColor(format.hiliteColor, HIGHLIGHT_COLORS) : "transparent" }} />
        </button>
        <span className="text-toolbar__divider" />
        <button title="Bulleted list" aria-label="Bulleted list" {...formatButtonProps("insertUnorderedList", format.unorderedList)}><BulletListIcon size={15}/></button>
        <button title="Numbered list" aria-label="Numbered list" {...formatButtonProps("insertOrderedList", format.orderedList)}><NumberedListIcon size={15}/></button>
        <span className="text-toolbar__divider" />
        <button title="Align left" aria-label="Align left" {...formatButtonProps("justifyLeft", format.align === "left")}><AlignLeftIcon size={15}/></button>
        <button title="Align center" aria-label="Align center" {...formatButtonProps("justifyCenter", format.align === "center")}><AlignCenterIcon size={15}/></button>
        <button title="Align right" aria-label="Align right" {...formatButtonProps("justifyRight", format.align === "right")}><AlignRightIcon size={15}/></button>
        <span className="text-toolbar__divider" />
        <button title="Anchor text to top" aria-label="Anchor text to top" {...verticalAlignButtonProps("top")}><AlignTopIcon size={15}/></button>
        <button title="Anchor text to middle" aria-label="Anchor text to middle" {...verticalAlignButtonProps("center")}><AlignMiddleIcon size={15}/></button>
        <button title="Anchor text to bottom" aria-label="Anchor text to bottom" {...verticalAlignButtonProps("bottom")}><AlignBottomIcon size={15}/></button>
        <button title="Clear formatting" aria-label="Clear formatting" {...formatButtonProps("removeFormat", false, "", { fontName: "Arial", fontSize: "3", bold: false, italic: false, underline: false, strikeThrough: false, subscript: false, superscript: false, foreColor: "", hiliteColor: "" })}><RemoveFormatIcon size={15}/></button>
      </div>

      {colorMenu && (
        <ColorMenu
          anchor={colorMenu.anchor}
          colors={colorMenu.kind === "fore" ? TEXT_COLORS : HIGHLIGHT_COLORS}
          columns={colorMenu.kind === "fore" ? 6 : 4}
          activeColor={colorMenu.kind === "fore" ? format.foreColor : format.hiliteColor}
          defaultLabel={colorMenu.kind === "fore" ? "Default color" : "No highlight"}
          onPick={(color) => pickColor(colorMenu.kind, color)}
          onClose={() => setColorMenu(null)}
        />
      )}

      {exportOpen && (
        <ExportDialog
          native={Boolean(window.__TAURI_INTERNALS__)}
          onPick={(format) => void exportAs(format)}
          onClose={() => setExportOpen(false)}
        />
      )}
    </header>
  );
}
