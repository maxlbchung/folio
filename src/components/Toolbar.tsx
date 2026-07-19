import { useEffect, useMemo, useRef, useState } from "react";
import { useDocument } from "../document/DocumentContext";
import { saveDocumentFile } from "../persistence/fileSystem";
import { writeAutosave } from "../persistence/autosave";
import { saveLibraryFolio } from "../persistence/library";
import {
  AlignBottomIcon, AlignCenterIcon, AlignLeftIcon, AlignMiddleIcon, AlignRightIcon, AlignTopIcon,
  ExitFullscreenIcon, FileIcon, FolderIcon,
  FullscreenIcon, HomeIcon, MoonIcon, RedoIcon, RemoveFormatIcon, SaveIcon, SunIcon, UndoIcon,
  ZoomInIcon, ZoomOutIcon
} from "./icons";

interface ToolbarProps {
  onStatus: (message: string) => void;
  onHome: () => void;
  onNewDocument: () => void;
  onOpenDocument: () => Promise<void>;
}

export function Toolbar({ onStatus, onHome, onNewDocument, onOpenDocument }: ToolbarProps) {
  const {
    document, assets, dirty, currentPath, setCurrentPath, markSaved,
    updateTitle, setTheme, setPageVerticalAlign, undo, redo, canUndo, canRedo
  } = useDocument();
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const editableRef = useRef<HTMLElement | null>(null);
  const selectionRef = useRef<Range | null>(null);

  const effectiveDark = useMemo(() => {
    if (document.settings.theme === "dark") return true;
    if (document.settings.theme === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }, [document.settings.theme]);

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
  };

  const applyTextCommand = (command: string, value?: string) => {
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
    captureTextSelection();
  };

  const formatButtonProps = (command: string) => ({
    onMouseDown: (event: React.MouseEvent<HTMLButtonElement>) => event.preventDefault(),
    onClick: () => applyTextCommand(command)
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

  useEffect(() => {
    const syncFullscreen = () => setFullscreen(Boolean(window.document.fullscreenElement));
    window.document.addEventListener("fullscreenchange", syncFullscreen);
    return () => window.document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  const changeZoom = (delta: number) => setZoom((current) => Math.min(2.0, Math.max(.1, Math.round((current + delta) * 10) / 10)));

  const toggleFullscreen = async () => {
    if (window.__TAURI_INTERNALS__) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const appWindow = getCurrentWindow();
      const next = !(await appWindow.isFullscreen());
      await appWindow.setFullscreen(next);
      setFullscreen(next);
      return;
    }
    if (window.document.fullscreenElement) await window.document.exitFullscreen();
    else await window.document.documentElement.requestFullscreen();
  };

  const save = async (forceDialog = false) => {
    setBusy(true);
    try {
      const result = await saveDocumentFile(document, assets, currentPath, forceDialog);
      if (!result.cancelled) {
        setCurrentPath(result.path);
        markSaved();
        await Promise.all([
          writeAutosave(document, assets, result.path, false),
          saveLibraryFolio(document, assets, result.path)
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
          <button className="icon-button" title="Back to folios" aria-label="Back to folios" onClick={onHome}><HomeIcon /></button>
          <button className="icon-button" title="New folio" onClick={onNewDocument}><FileIcon /></button>
          <button className="icon-button" title="Open (.folio)" onClick={() => void open()} disabled={busy}><FolderIcon /></button>
          <button className="icon-button" title="Save (Ctrl+S)" onClick={() => void save(false)} disabled={busy}><SaveIcon /></button>
          <span className={`save-dot ${dirty ? "save-dot--dirty" : ""}`} title={dirty ? "Unsaved changes" : "Saved"} />
        </div>

        <div className="topbar__cluster topbar__cluster--right">
          <button className="icon-button" title="Undo" disabled={!canUndo} onClick={undo}><UndoIcon /></button>
          <button className="icon-button" title="Redo" disabled={!canRedo} onClick={redo}><RedoIcon /></button>
          <button className="icon-button" title={effectiveDark ? "Use light mode" : "Use dark mode"} onClick={() => setTheme(effectiveDark ? "light" : "dark")}>
            {effectiveDark ? <SunIcon /> : <MoonIcon />}
          </button>
          <span className="topbar__divider" />
          <button className="icon-button" title="Zoom out (Ctrl+-)" disabled={zoom <= .1} onClick={() => changeZoom(-.1)}><ZoomOutIcon /></button>
          <button className="zoom-value" title="Reset zoom (Ctrl+0)" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button className="icon-button" title="Zoom in (Ctrl++)" disabled={zoom >= 2.0} onClick={() => changeZoom(.1)}><ZoomInIcon /></button>
          <button className="icon-button" title={fullscreen ? "Exit fullscreen" : "Enter fullscreen"} onClick={() => void toggleFullscreen()}>
            {fullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
          </button>
        </div>
      </div>

      <div className="text-toolbar" aria-label="Text formatting">
        <select aria-label="Font family" defaultValue="Arial" onPointerDown={captureTextSelection} onChange={(event) => applyTextCommand("fontName", event.target.value)}>
          <option value="Arial">Arial</option>
          <option value="Georgia">Georgia</option>
          <option value="Times New Roman">Times New Roman</option>
          <option value="Trebuchet MS">Trebuchet</option>
          <option value="Courier New">Courier</option>
        </select>
        <select aria-label="Font size" defaultValue="3" onPointerDown={captureTextSelection} onChange={(event) => applyTextCommand("fontSize", event.target.value)}>
          <option value="3">Normal</option>
          <option value="2">Small</option>
          <option value="4">Large</option>
          <option value="5">Heading</option>
          <option value="6">Display</option>
        </select>
        <span className="text-toolbar__divider" />
        <button className="format-button" title="Bold (Ctrl+B)" aria-label="Bold" {...formatButtonProps("bold")}><strong>B</strong></button>
        <button className="format-button" title="Italic (Ctrl+I)" aria-label="Italic" {...formatButtonProps("italic")}><em>I</em></button>
        <button className="format-button format-button--underline" title="Underline (Ctrl+U)" aria-label="Underline" {...formatButtonProps("underline")}>U</button>
        <button className="format-button format-button--strike" title="Strikethrough" aria-label="Strikethrough" {...formatButtonProps("strikeThrough")}>S</button>
        <span className="text-toolbar__divider" />
        <button className="format-button" title="Align left" aria-label="Align left" {...formatButtonProps("justifyLeft")}><AlignLeftIcon size={15}/></button>
        <button className="format-button" title="Align center" aria-label="Align center" {...formatButtonProps("justifyCenter")}><AlignCenterIcon size={15}/></button>
        <button className="format-button" title="Align right" aria-label="Align right" {...formatButtonProps("justifyRight")}><AlignRightIcon size={15}/></button>
        <span className="text-toolbar__divider" />
        <button title="Anchor text to top" aria-label="Anchor text to top" {...verticalAlignButtonProps("top")}><AlignTopIcon size={15}/></button>
        <button title="Anchor text to middle" aria-label="Anchor text to middle" {...verticalAlignButtonProps("center")}><AlignMiddleIcon size={15}/></button>
        <button title="Anchor text to bottom" aria-label="Anchor text to bottom" {...verticalAlignButtonProps("bottom")}><AlignBottomIcon size={15}/></button>
        <button className="format-button" title="Clear formatting" aria-label="Clear formatting" {...formatButtonProps("removeFormat")}><RemoveFormatIcon size={15}/></button>
      </div>
    </header>
  );
}
