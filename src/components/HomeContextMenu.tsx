import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LibraryEntry } from "../persistence/library";
import { DuplicateIcon, EditIcon, FileIcon, FolderIcon, PinIcon, PlusIcon, SettingsIcon, TrashIcon, UnpinIcon } from "./icons";

/** Where the menu was summoned and, when a card was hit, which inktile it belongs to. */
export interface HomeMenuState {
  x: number;
  y: number;
  entry: LibraryEntry | null;
}

interface HomeContextMenuProps {
  state: HomeMenuState;
  onClose: () => void;
  onCreate: () => void;
  onImport: () => void;
  onOpenSettings: () => void;
  onOpenEntry: (entry: LibraryEntry) => void;
  onRenameEntry: (entry: LibraryEntry) => void;
  onTogglePinEntry: (entry: LibraryEntry) => void;
  onDuplicateEntry: (entry: LibraryEntry) => void;
  onDeleteEntry: (entry: LibraryEntry) => void;
}

/** Keep the menu this many pixels clear of the viewport edges when it would overflow. */
const MENU_MARGIN = 8;

const formatDateTime = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
};

const countWords = (text: string): number => {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
};

const formatCount = (value: number): string => value.toLocaleString();

export function HomeContextMenu({
  state, onClose, onCreate, onImport, onOpenSettings,
  onOpenEntry, onRenameEntry, onTogglePinEntry, onDuplicateEntry, onDeleteEntry
}: HomeContextMenuProps) {
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
  }, [state.x, state.y, state.entry]);

  // Dismiss on outside pointer, Escape, scroll, or resize.
  useEffect(() => {
    menuRef.current?.focus();
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

  // Run an action, then always dismiss the menu.
  const run = (action: () => void) => () => { onClose(); action(); };

  const { entry } = state;

  return createPortal(
    <div
      ref={menuRef}
      className="home-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {entry ? (
        <>
          <div className="home-menu__details">
            <p className="home-menu__eyebrow">Inktile</p>
            <h3 className="home-menu__title" title={entry.title}>{entry.title}</h3>
            <dl className="home-menu__meta">
              <dt>Tiles</dt>
              <dd>{formatCount(entry.pageCount)}</dd>
              <dt>Words</dt>
              <dd>{formatCount(countWords(entry.plainText))}</dd>
              <dt>Created</dt>
              <dd>{formatDateTime(entry.createdAt)}</dd>
              <dt>Edited</dt>
              <dd>{formatDateTime(entry.modifiedAt)}</dd>
              <dt>Opened</dt>
              <dd>{formatDateTime(entry.lastOpenedAt)}</dd>
              <dt>File</dt>
              <dd title={entry.path ?? undefined}>{entry.path ?? "Library only"}</dd>
            </dl>
          </div>
          <button className="home-menu__item" role="menuitem" onClick={run(() => onOpenEntry(entry))}>
            <FileIcon size={15} />Open
          </button>
          <button className="home-menu__item" role="menuitem" onClick={run(() => onRenameEntry(entry))}>
            <EditIcon size={15} />Rename
          </button>
          <button className="home-menu__item" role="menuitem" onClick={run(() => onTogglePinEntry(entry))}>
            {entry.pinned ? <><UnpinIcon size={15} />Unpin</> : <><PinIcon size={15} />Pin to top</>}
          </button>
          <button className="home-menu__item" role="menuitem" onClick={run(() => onDuplicateEntry(entry))}>
            <DuplicateIcon size={15} />Duplicate
          </button>
          <div className="home-menu__sep" role="separator" />
          <button className="home-menu__item home-menu__item--danger" role="menuitem" onClick={run(() => onDeleteEntry(entry))}>
            <TrashIcon size={15} />Delete
          </button>
        </>
      ) : (
        <>
          <button className="home-menu__item" role="menuitem" onClick={run(onCreate)}>
            <PlusIcon size={15} />New inktile
          </button>
          <button className="home-menu__item" role="menuitem" onClick={run(onImport)}>
            <FolderIcon size={15} />Open .inktile…
          </button>
          <div className="home-menu__sep" role="separator" />
          <button className="home-menu__item" role="menuitem" onClick={run(onOpenSettings)}>
            <SettingsIcon size={15} />Settings
          </button>
        </>
      )}
    </div>,
    window.document.body
  );
}
