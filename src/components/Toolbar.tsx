import { useEffect, useRef, useState } from "react";
import { useDocument } from "../document/DocumentContext";
import { saveDocumentFile } from "../persistence/fileSystem";
import { exportDocumentAsPdf, exportDocumentAsText } from "../persistence/exportDocument";
import { writeAutosave } from "../persistence/autosave";
import { saveLibraryInktile } from "../persistence/library";
import { ExportDialog, type ExportFormat } from "./ExportDialog";
import {
  AlignBottomIcon, AlignCenterIcon, AlignLeftIcon, AlignMiddleIcon, AlignRightIcon, AlignTopIcon,
  ExportIcon,
  HomeIcon, RedoIcon, RemoveFormatIcon, SaveIcon, UndoIcon,
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

interface FormatState {
  fontName: string;
  fontSize: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikeThrough: boolean;
  align: "left" | "center" | "right";
}

const DEFAULT_FORMAT: FormatState = {
  fontName: "Arial", fontSize: "3", bold: false, italic: false, underline: false, strikeThrough: false, align: "left"
};

// queryCommandValue("fontName") returns the resolved font-family, which may be quoted and/or a
// full fallback stack ("Arial, Helvetica, sans-serif"). Reduce it to a known option, defaulting
// to Arial when the selection uses a font outside the dropdown (matches the Arial default rule).
const normalizeFontName = (raw: string): string => {
  const first = (raw || "").split(",")[0].trim().replace(/^["']|["']$/g, "");
  return FONT_FAMILIES.find((font) => font.value.toLowerCase() === first.toLowerCase())?.value ?? "Arial";
};

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
      align: doc.queryCommandState("justifyCenter") ? "center" : doc.queryCommandState("justifyRight") ? "right" : "left"
    };
    // Keep the same object when nothing changed so frequent selectionchange events during
    // typing don't trigger needless re-renders.
    setFormat((prev) =>
      prev.fontName === next.fontName && prev.fontSize === next.fontSize && prev.bold === next.bold &&
      prev.italic === next.italic && prev.underline === next.underline && prev.strikeThrough === next.strikeThrough &&
      prev.align === next.align ? prev : next
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
        <span className="text-toolbar__divider" />
        <button title="Align left" aria-label="Align left" {...formatButtonProps("justifyLeft", format.align === "left")}><AlignLeftIcon size={15}/></button>
        <button title="Align center" aria-label="Align center" {...formatButtonProps("justifyCenter", format.align === "center")}><AlignCenterIcon size={15}/></button>
        <button title="Align right" aria-label="Align right" {...formatButtonProps("justifyRight", format.align === "right")}><AlignRightIcon size={15}/></button>
        <span className="text-toolbar__divider" />
        <button title="Anchor text to top" aria-label="Anchor text to top" {...verticalAlignButtonProps("top")}><AlignTopIcon size={15}/></button>
        <button title="Anchor text to middle" aria-label="Anchor text to middle" {...verticalAlignButtonProps("center")}><AlignMiddleIcon size={15}/></button>
        <button title="Anchor text to bottom" aria-label="Anchor text to bottom" {...verticalAlignButtonProps("bottom")}><AlignBottomIcon size={15}/></button>
        <button title="Clear formatting" aria-label="Clear formatting" {...formatButtonProps("removeFormat", false, "", { fontName: "Arial", fontSize: "3", bold: false, italic: false, underline: false, strikeThrough: false })}><RemoveFormatIcon size={15}/></button>
      </div>

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
