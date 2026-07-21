import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDocument } from "../document/DocumentContext";
import { editTable, insertPastedLink, notifyInput, type TableEdit } from "../utils/richText";
import { CutIcon, DuplicateIcon, MinusIcon, PasteIcon, PlusIcon, SelectAllIcon, TrashIcon } from "./icons";

/** Where the menu was summoned and the editable field it acts on. */
interface TextMenuState {
  x: number;
  y: number;
  field: HTMLElement;
  canCopy: boolean;
  canEdit: boolean;
  /** Set when the menu was summoned over a table cell in a rich-text tile: unlocks the
   * structural row/column items below. */
  cell: HTMLTableCellElement | null;
}

/** Keep the menu this many pixels clear of the viewport edges when it would overflow. */
const MENU_MARGIN = 8;

/** Editable targets this menu handles; also the guard the other menus use to defer here. */
export const EDITABLE_SELECTOR = 'input, textarea, [contenteditable="true"], .text-block, .variant-editor';

interface TextMenuViewProps {
  state: TextMenuState;
  onClose: () => void;
}

function TextMenuView({ state, onClose }: TextMenuViewProps) {
  const { checkpoint } = useDocument();
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: state.x, top: state.y });

  // Clamp to the viewport once the menu has a measured size, so it never spills off-screen.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const maxLeft = window.innerWidth - menu.offsetWidth - MENU_MARGIN;
    const maxTop = window.innerHeight - menu.offsetHeight - MENU_MARGIN;
    setPos({
      left: Math.max(MENU_MARGIN, Math.min(state.x, maxLeft)),
      top: Math.max(MENU_MARGIN, Math.min(state.y, maxTop))
    });
  }, [state.x, state.y]);

  // Dismiss on outside pointer, Escape, scroll, or resize.
  useEffect(() => {
    const handlePointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
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

  const { field, canCopy, canEdit, cell } = state;

  // Structural table edits work on the live DOM; the input event routes the result
  // through the owning tile's normal serialize-and-commit path. Each edit checkpoints
  // first so it undoes as one discrete step (checkpoint dedupes if the tile's own
  // session checkpoint fires for the same gesture).
  const runTableEdit = (edit: TableEdit) => {
    if (cell) {
      checkpoint();
      editTable(cell, edit);
      notifyInput(field);
    }
    onClose();
  };

  const copy = () => { field.focus(); window.document.execCommand("copy"); onClose(); };
  const cut = () => { field.focus(); window.document.execCommand("cut"); onClose(); };
  const selectAll = () => { field.focus(); window.document.execCommand("selectAll"); onClose(); };
  const paste = async () => {
    field.focus();
    try {
      if (navigator.clipboard?.readText) {
        const text = await navigator.clipboard.readText();
        field.focus();
        // A single pasted URL autolinks in the rich-text tiles, same as Ctrl+V there.
        if (!(field.matches(".text-block, .variant-editor") && insertPastedLink(text, field, checkpoint))) {
          window.document.execCommand("insertText", false, text);
        }
      } else {
        window.document.execCommand("paste");
      }
    } catch {
      try { window.document.execCommand("paste"); } catch { /* clipboard unavailable */ }
    } finally {
      onClose();
    }
  };

  return createPortal(
    // Prevent mousedown default so the editable field keeps focus + selection while we act on it.
    <div
      ref={menuRef}
      className="home-menu home-menu--compact"
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(event) => event.preventDefault()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button className="home-menu__item" role="menuitem" onClick={cut} disabled={!canEdit || !canCopy}>
        <CutIcon size={15} />Cut
      </button>
      <button className="home-menu__item" role="menuitem" onClick={copy} disabled={!canCopy}>
        <DuplicateIcon size={15} />Copy
      </button>
      <button className="home-menu__item" role="menuitem" onClick={() => void paste()} disabled={!canEdit}>
        <PasteIcon size={15} />Paste
      </button>
      <div className="home-menu__sep" role="separator" />
      <button className="home-menu__item" role="menuitem" onClick={selectAll}>
        <SelectAllIcon size={15} />Select all
      </button>
      {cell && canEdit && (
        <>
          <div className="home-menu__sep" role="separator" />
          <button className="home-menu__item" role="menuitem" onClick={() => runTableEdit("row-above")}>
            <PlusIcon size={15} />Insert row above
          </button>
          <button className="home-menu__item" role="menuitem" onClick={() => runTableEdit("row-below")}>
            <PlusIcon size={15} />Insert row below
          </button>
          <button className="home-menu__item" role="menuitem" onClick={() => runTableEdit("column-left")}>
            <PlusIcon size={15} />Insert column left
          </button>
          <button className="home-menu__item" role="menuitem" onClick={() => runTableEdit("column-right")}>
            <PlusIcon size={15} />Insert column right
          </button>
          <button className="home-menu__item" role="menuitem" onClick={() => runTableEdit("delete-row")}>
            <MinusIcon size={15} />Delete row
          </button>
          <button className="home-menu__item" role="menuitem" onClick={() => runTableEdit("delete-column")}>
            <MinusIcon size={15} />Delete column
          </button>
          <button className="home-menu__item" role="menuitem" onClick={() => runTableEdit("delete-table")}>
            <TrashIcon size={15} />Delete table
          </button>
        </>
      )}
    </div>,
    window.document.body
  );
}

/**
 * A styled Cut/Copy/Paste/Select-all menu that replaces the browser's native context menu over
 * editable fields (inputs and rich-text blocks). Mounted once at the app root so it covers both
 * the library and editor views; the tile/home menus defer to it via EDITABLE_SELECTOR.
 */
export function TextContextMenu() {
  const [menu, setMenu] = useState<TextMenuState | null>(null);

  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      // Right-click on any of our own menus: suppress native, let that menu manage itself.
      if (target.closest(".home-menu")) { event.preventDefault(); return; }
      const field = target.closest<HTMLElement>(EDITABLE_SELECTOR);
      if (!field) return; // not an editable field → leave it to the tile/home context menus
      event.preventDefault();
      let canCopy = false;
      let canEdit = true;
      let cell: HTMLTableCellElement | null = null;
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        canCopy = field.selectionStart !== null && field.selectionStart !== field.selectionEnd;
        canEdit = !field.readOnly && !field.disabled;
      } else {
        const selection = window.getSelection();
        canCopy = Boolean(selection) && !selection!.isCollapsed && field.contains(selection!.anchorNode);
        canEdit = field.isContentEditable;
        cell = target.closest("td, th");
        if (cell && !field.contains(cell)) cell = null;
      }
      setMenu({ x: event.clientX, y: event.clientY, field, canCopy, canEdit, cell });
    };
    window.document.addEventListener("contextmenu", handleContextMenu);
    return () => window.document.removeEventListener("contextmenu", handleContextMenu);
  }, []);

  if (!menu) return null;
  return <TextMenuView state={menu} onClose={() => setMenu(null)} />;
}
