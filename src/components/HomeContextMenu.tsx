import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LibraryEntry } from "../persistence/library";
import type { InktileTag } from "../persistence/tags";
import { ChevronDown, ChevronUp, CloseIcon, DuplicateIcon, EditIcon, FileIcon, FolderIcon, PinIcon, PlusIcon, SettingsIcon, TagIcon, TrashIcon, UnpinIcon } from "./icons";

/** Where the menu was summoned and, when a card was hit, which inktile it belongs to. */
export interface HomeMenuState {
  x: number;
  y: number;
  entry: LibraryEntry | null;
}

interface HomeContextMenuProps {
  state: HomeMenuState;
  tags: InktileTag[];
  onClose: () => void;
  onCreate: () => void;
  onImport: () => void;
  onOpenSettings: () => void;
  onOpenEntry: (entry: LibraryEntry) => void;
  onRenameEntry: (entry: LibraryEntry) => void;
  onTogglePinEntry: (entry: LibraryEntry) => void;
  onDuplicateEntry: (entry: LibraryEntry) => void;
  onDeleteEntry: (entry: LibraryEntry) => void;
  /** Apply or remove one tag; the menu stays open so several tags can be changed in a row. */
  onToggleEntryTag: (entry: LibraryEntry, tag: InktileTag, apply: boolean) => void;
  onCreateTagForEntry: (entry: LibraryEntry) => void;
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
  state, tags, onClose, onCreate, onImport, onOpenSettings,
  onOpenEntry, onRenameEntry, onTogglePinEntry, onDuplicateEntry, onDeleteEntry,
  onToggleEntryTag, onCreateTagForEntry
}: HomeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: state.x, top: state.y });
  const [tagPickerOpen, setTagPickerOpen] = useState(false);

  const appliedTags = state.entry
    ? (state.entry.tags ?? []).map((id) => tags.find((tag) => tag.id === id)).filter((tag): tag is InktileTag => Boolean(tag))
    : [];
  const availableTags = state.entry ? tags.filter((tag) => !(state.entry!.tags ?? []).includes(tag.id)) : [];

  // Clamp to the viewport once the menu has a measured size, so it never spills off-screen.
  // Tag toggles and the tag picker change the menu's height, so they re-run the clamp.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const maxLeft = window.innerWidth - menu.offsetWidth - MENU_MARGIN;
    const maxTop = window.innerHeight - menu.offsetHeight - MENU_MARGIN;
    setPos({
      left: Math.max(MENU_MARGIN, Math.min(state.x, maxLeft)),
      top: Math.max(MENU_MARGIN, Math.min(state.y, maxTop))
    });
  }, [state.x, state.y, state.entry, tagPickerOpen, appliedTags.length]);

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
          <div className="home-menu__tags">
            <p className="home-menu__eyebrow">Tags</p>
            {appliedTags.map((tag) => (
              <div key={tag.id} className="home-menu__tag-row">
                <span className="home-menu__tag-dot" style={{ background: tag.color }} aria-hidden="true" />
                <span className="home-menu__tag-name" title={tag.name}>{tag.name}</span>
                <button
                  className="home-menu__tag-remove"
                  onClick={() => onToggleEntryTag(entry, tag, false)}
                  title={`Remove tag “${tag.name}”`}
                  aria-label={`Remove tag ${tag.name}`}
                ><CloseIcon size={11} /></button>
              </div>
            ))}
            {!appliedTags.length && <p className="home-menu__tag-empty">No tags yet</p>}
            <button
              className="home-menu__item"
              role="menuitem"
              aria-expanded={tagPickerOpen}
              onClick={() => setTagPickerOpen((open) => !open)}
            >
              <TagIcon size={15} />Add tag
              <span className="home-menu__item-caret">{tagPickerOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</span>
            </button>
            {tagPickerOpen && (
              <div className="home-menu__tag-picker">
                {availableTags.map((tag) => (
                  <button key={tag.id} className="home-menu__tag-option" onClick={() => onToggleEntryTag(entry, tag, true)}>
                    <span className="home-menu__tag-dot" style={{ background: tag.color }} aria-hidden="true" />
                    <span className="home-menu__tag-name" title={tag.name}>{tag.name}</span>
                  </button>
                ))}
                {!availableTags.length && tags.length > 0 && <p className="home-menu__tag-empty">All tags applied</p>}
                <button className="home-menu__tag-option home-menu__tag-option--new" onClick={run(() => onCreateTagForEntry(entry))}>
                  <PlusIcon size={13} />New tag…
                </button>
              </div>
            )}
          </div>
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
