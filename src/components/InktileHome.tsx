import { useEffect, useMemo, useRef, useState } from "react";
import {
  countTextMatches,
  deleteLibraryInktile,
  duplicateLibraryInktile,
  listLibraryInktiles,
  renameLibraryInktile,
  setLibraryInktilePinned,
  sortLibraryInktiles,
  type LibraryEntry,
  type LibrarySort,
  type SortDirection
} from "../persistence/library";
import type { AppPreferences, CardSize, ThemePreference, UiScale } from "../persistence/preferences";
import { HomeContextMenu, type HomeMenuState } from "./HomeContextMenu";
import { RowScrollbar } from "./RowScrollbar";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CloseIcon,
  DuplicateIcon,
  EditIcon,
  FileIcon,
  FolderIcon,
  GridLargeIcon,
  GridMediumIcon,
  GridSmallIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  TrashIcon,
  UnpinIcon
} from "./icons";
import type {
  ComponentType,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  SVGProps
} from "react";

interface InktileHomeProps {
  refreshToken: number;
  preferences: AppPreferences;
  onCreate: () => void;
  onOpen: (id: string) => Promise<void>;
  onImport: () => Promise<void>;
  onOpenFile: (source: File | string) => Promise<void>;
  onPreferencesChange: (patch: Partial<AppPreferences>) => void;
  onStatus: (message: string) => void;
}

const SORT_OPTIONS: Array<{ value: LibrarySort; label: string }> = [
  { value: "lastOpenedAt", label: "Last opened" },
  { value: "createdAt", label: "Date created" },
  { value: "modifiedAt", label: "Last edited" }
];

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" }
];

const UI_SCALE_OPTIONS: Array<{ value: UiScale; label: string }> = [
  { value: 0.8, label: "80%" },
  { value: 0.9, label: "90%" },
  { value: 1, label: "100%" },
  { value: 1.1, label: "110%" },
  { value: 1.2, label: "120%" }
];

const CARD_SIZE_OPTIONS: Array<{ value: CardSize; label: string; Icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number }> }> = [
  { value: "small", label: "Small", Icon: GridSmallIcon },
  { value: "medium", label: "Medium", Icon: GridMediumIcon },
  { value: "large", label: "Large", Icon: GridLargeIcon }
];

const relativeDate = (iso: string): string => {
  const date = new Date(iso);
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric"
  }).format(date);
};

// Characters of context shown on each side of the matched term in a result excerpt. Kept modest
// so the highlighted term stays within the card's clamped (3–5) visible lines rather than being
// pushed past the fold.
const EXCERPT_CONTEXT = 48;

// Build the excerpt for a search hit: jump to the first occurrence of the term in the body and
// show an equal window of text before and after it, with ellipses marking any trimmed ends. Falls
// back to the plain preview when the term isn't in the body (e.g. a title-only match).
const excerptForQuery = (entry: LibraryEntry, query: string): string => {
  const needle = query.trim();
  if (!needle) return entry.previewText;
  const index = entry.plainText.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (index < 0) return entry.previewText;
  const start = Math.max(0, index - EXCERPT_CONTEXT);
  const end = Math.min(entry.plainText.length, index + needle.length + EXCERPT_CONTEXT);
  return `${start > 0 ? "…" : ""}${entry.plainText.slice(start, end).trim()}${end < entry.plainText.length ? "…" : ""}`;
};

// Wrap every case-insensitive occurrence of the search term in <mark> so matches stand out in
// both the card title and its excerpt. Matching stays substring-based to line up with the excerpt
// window, which jumps to the first substring hit via indexOf above.
const highlightMatches = (text: string, query: string): ReactNode => {
  const needle = query.trim();
  if (!needle) return text;
  const haystack = text.toLocaleLowerCase();
  const target = needle.toLocaleLowerCase();
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (let hit = haystack.indexOf(target); hit >= 0; hit = haystack.indexOf(target, cursor)) {
    if (hit > cursor) nodes.push(text.slice(cursor, hit));
    nodes.push(<mark key={hit}>{text.slice(hit, hit + needle.length)}</mark>);
    cursor = hit + needle.length;
  }
  if (!nodes.length) return text;
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
};

interface InktileCardProps {
  entry: LibraryEntry;
  frequency?: number;
  query: string;
  sort: LibrarySort;
  editing: boolean;
  busy: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onRename: (title: string) => void;
  onTogglePin: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

function InktileCard({
  entry, frequency, query, sort, editing, busy, onOpen, onEdit, onCancelEdit, onRename, onTogglePin, onDuplicate, onDelete
}: InktileCardProps) {
  const [draftTitle, setDraftTitle] = useState(entry.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraftTitle(entry.title);
  }, [entry.title, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const sortDate = sort === "createdAt" ? entry.createdAt : sort === "modifiedAt" ? entry.modifiedAt : entry.lastOpenedAt;
  const dateLabel = sort === "createdAt" ? "Created" : sort === "modifiedAt" ? "Edited" : "Opened";
  const excerpt = excerptForQuery(entry, query);

  return (
    <article className="inktile-card" data-inktile-id={entry.id}>
      {editing ? (
        <form className="inktile-card__rename" onSubmit={(event) => { event.preventDefault(); onRename(draftTitle); }}>
          <label className="sr-only" htmlFor={`rename-${entry.id}`}>Inktile title</label>
          <input
            id={`rename-${entry.id}`}
            ref={inputRef}
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") onCancelEdit(); }}
            maxLength={120}
          />
          <div>
            <button type="submit" disabled={busy}>Save title</button>
            <button type="button" onClick={onCancelEdit}>Cancel</button>
          </div>
        </form>
      ) : (
        <button className="inktile-card__open" onClick={onOpen} disabled={busy} aria-label={`Open ${entry.title}`}>
          <h2>{highlightMatches(entry.title, query)}</h2>
          <p>{excerpt ? highlightMatches(excerpt, query) : "Empty inktile — open it to add the first tile."}</p>
        </button>
      )}

      <footer className="inktile-card__footer">
        <span className="inktile-card__meta" title={`${dateLabel} ${relativeDate(sortDate)}`}>
          {entry.pageCount} {entry.pageCount === 1 ? "tile" : "tiles"} · {relativeDate(sortDate)}
        </span>
        {frequency !== undefined && <span className="inktile-card__frequency">{frequency} {frequency === 1 ? "match" : "matches"}</span>}
        <div className="inktile-card__actions">
          <button className="library-icon-button" onClick={onTogglePin} disabled={busy} title={entry.pinned ? `Unpin ${entry.title}` : `Pin ${entry.title}`} aria-label={entry.pinned ? `Unpin ${entry.title}` : `Pin ${entry.title}`}>{entry.pinned ? <UnpinIcon size={14} /> : <PinIcon size={14} />}</button>
          <button className="library-icon-button" onClick={onEdit} disabled={busy || editing} title={`Edit title for ${entry.title}`} aria-label={`Edit title for ${entry.title}`}><EditIcon size={14} /></button>
          <button className="library-icon-button" onClick={onDuplicate} disabled={busy} title={`Duplicate ${entry.title}`} aria-label={`Duplicate ${entry.title}`}><DuplicateIcon size={14} /></button>
          <button className="library-icon-button library-icon-button--danger" onClick={onDelete} disabled={busy} title={`Delete ${entry.title}`} aria-label={`Delete ${entry.title}`}><TrashIcon size={14} /></button>
        </div>
      </footer>
    </article>
  );
}

export function InktileHome({
  refreshToken, preferences, onCreate, onOpen, onImport, onOpenFile, onPreferencesChange, onStatus
}: InktileHomeProps) {
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<LibrarySort>("lastOpenedAt");
  const [direction, setDirection] = useState<SortDirection>("descending");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LibraryEntry | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menu, setMenu] = useState<HomeMenuState | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsCloseRef = useRef<HTMLButtonElement>(null);
  const pinnedRowRef = useRef<HTMLDivElement>(null);
  const openCardRef = useRef<HTMLButtonElement>(null);
  const suppressRowClick = useRef(false);
  const [rowPanning, setRowPanning] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [dragging, setDragging] = useState(false);

  const refresh = async () => setEntries(await listLibraryInktiles());

  useEffect(() => {
    void refresh().catch(() => onStatus("Library could not be loaded")).finally(() => setLoading(false));
  }, [refreshToken]);

  useEffect(() => {
    const syncFullscreen = () => setFullscreen(Boolean(window.document.fullscreenElement));
    window.document.addEventListener("fullscreenchange", syncFullscreen);
    return () => window.document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

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

  useEffect(() => {
    if (!settingsOpen) return;
    settingsCloseRef.current?.focus();
    if (window.__TAURI_INTERNALS__) {
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().isFullscreen())
        .then(setFullscreen)
        .catch(() => {});
    } else {
      setFullscreen(Boolean(window.document.fullscreenElement));
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [settingsOpen]);

  const sortedEntries = useMemo(() => sortLibraryInktiles(entries, sort, direction), [entries, sort, direction]);
  const pinnedEntries = useMemo(() => sortedEntries.filter((entry) => entry.pinned), [sortedEntries]);
  const unpinnedEntries = useMemo(() => sortedEntries.filter((entry) => !entry.pinned), [sortedEntries]);
  const searchResults = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    const matches = entries
      .map((entry) => ({ ...entry, frequency: countTextMatches(entry.plainText, query) }))
      .filter((entry) => entry.title.toLocaleLowerCase().includes(normalized) || entry.frequency > 0);
    return sortLibraryInktiles(matches, sort, direction) as Array<LibraryEntry & { frequency: number }>;
  }, [entries, query, sort, direction]);
  const hasQuery = Boolean(query.trim());
  const sortLabel = SORT_OPTIONS.find((option) => option.value === sort)?.label ?? "Sorted";
  const orderLabel = `${sortLabel} · ${direction === "ascending" ? "Ascending" : "Descending"}`;

  const closeSettings = () => {
    setSettingsOpen(false);
    window.requestAnimationFrame(() => settingsTriggerRef.current?.focus());
  };

  const openEntry = async (entry: LibraryEntry) => {
    setBusyId(entry.id);
    try {
      await onOpen(entry.id);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Inktile could not be opened");
      setBusyId(null);
    }
  };

  const renameEntry = async (entry: LibraryEntry, title: string) => {
    setBusyId(entry.id);
    try {
      await renameLibraryInktile(entry.id, title);
      await refresh();
      setEditingId(null);
      onStatus("Title updated");
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Title could not be updated");
    } finally {
      setBusyId(null);
    }
  };

  const togglePinEntry = async (entry: LibraryEntry) => {
    // setLibraryInktilePinned mutates the shared cache entry, so decide the target state up front.
    const nextPinned = !entry.pinned;
    setBusyId(entry.id);
    try {
      await setLibraryInktilePinned(entry.id, nextPinned);
      await refresh();
      onStatus(nextPinned ? `Pinned “${entry.title}”` : `Unpinned “${entry.title}”`);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Pin could not be updated");
    } finally {
      setBusyId(null);
    }
  };

  const duplicateEntry = async (entry: LibraryEntry) => {
    setBusyId(entry.id);
    try {
      await duplicateLibraryInktile(entry.id);
      await refresh();
      onStatus(`Duplicated “${entry.title}”`);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Inktile could not be duplicated");
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    try {
      await deleteLibraryInktile(deleteTarget.id);
      await refresh();
      setDeleteTarget(null);
      onStatus("Inktile deleted from this library");
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Inktile could not be deleted");
    } finally {
      setBusyId(null);
    }
  };

  // Listen at the document level so the whole Home view — including the empty side
  // margins outside the centered <main> — opens our menu instead of the native one.
  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      // Right-click on our own menu: suppress the native menu, keep ours open.
      if (target.closest(".home-menu")) {
        event.preventDefault();
        return;
      }
      // Leave the native menu for editable fields (search) and modal dialogs.
      if (target.closest("input, textarea, select, .library-dialog")) return;
      event.preventDefault();
      const cardEl = target.closest<HTMLElement>("[data-inktile-id]");
      const entry = cardEl ? entries.find((item) => item.id === cardEl.dataset.inktileId) ?? null : null;
      setMenu({ x: event.clientX, y: event.clientY, entry });
    };
    window.document.addEventListener("contextmenu", handleContextMenu);
    return () => window.document.removeEventListener("contextmenu", handleContextMenu);
  }, [entries]);

  /** Visual px per layout px inside the zoomed shell (1 when UI scale is 100%). */
  const rowZoom = (row: HTMLElement): number => {
    const rect = row.getBoundingClientRect();
    return row.clientWidth > 0 ? rect.width / row.clientWidth : 1;
  };

  // Drive the pan from window listeners rather than pointer capture. Capturing the pointer to
  // the row would lock the browser's :hover onto whichever card sat under the cursor when the
  // drag began, leaving it highlighted after you drag off it (hover isn't re-evaluated while a
  // pointer is captured). Window listeners keep the drag robust when the cursor leaves the row
  // without ever taking capture, so hover tracks the cursor normally throughout.
  const onRowPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Mouse only: touch pointers already pan the row through native overflow scrolling.
    if (event.button !== 0 || event.pointerType !== "mouse") return;
    const row = pinnedRowRef.current;
    if (!row) return;
    if ((event.target as HTMLElement).closest("input, textarea, select")) return;
    const drag = { pointerId: event.pointerId, startX: event.clientX, startScroll: row.scrollLeft, zoom: rowZoom(row), panning: false };

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== drag.pointerId) return;
      const delta = moveEvent.clientX - drag.startX;
      if (!drag.panning) {
        if (Math.abs(delta) < 6 || row.scrollWidth <= row.clientWidth) return;
        drag.panning = true;
        setRowPanning(true);
      }
      row.scrollLeft = drag.startScroll - delta / drag.zoom;
    };

    const onEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== drag.pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      if (!drag.panning) return;
      setRowPanning(false);
      // A press that became a drag leaves focus on the card's button, and its :focus-within keeps
      // the top accent bar lit until focus moves (i.e. until you click elsewhere). Drop that focus
      // so a drag leaves no highlight behind, just like a plain hover would.
      const focused = window.document.activeElement;
      if (focused instanceof HTMLElement && row.contains(focused)) focused.blur();
      // Swallow the click that follows a pan so the card under the cursor doesn't open.
      suppressRowClick.current = true;
      window.setTimeout(() => { suppressRowClick.current = false; }, 120);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  const onRowClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressRowClick.current) return;
    suppressRowClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const onOpenCardDragOver = (event: ReactDragEvent<HTMLButtonElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropActive(true);
  };

  const onOpenCardDrop = (event: ReactDragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDropActive(false);
    const files = Array.from(event.dataTransfer.files);
    const file = files.find((item) => /\.inktile$/i.test(item.name)) ?? files[0];
    if (file) void onOpenFile(file);
  };

  const onOpenFileRef = useRef(onOpenFile);
  useEffect(() => { onOpenFileRef.current = onOpenFile; });

  // In the Tauri shell the webview intercepts OS file drops, so HTML5 drop events never carry
  // files; listen to the native drag-drop stream and hit-test against the Open card instead.
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const overOpenCard = (position: { x: number; y: number }): boolean => {
      const card = openCardRef.current;
      if (!card) return false;
      const rect = card.getBoundingClientRect();
      const x = position.x / window.devicePixelRatio;
      const y = position.y / window.devicePixelRatio;
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setDragging(true);
          setDropActive(overOpenCard(event.payload.position));
        } else if (event.payload.type === "drop") {
          setDragging(false);
          setDropActive(false);
          const path = event.payload.paths.find((item) => /\.inktile$/i.test(item)) ?? event.payload.paths[0];
          if (path && overOpenCard(event.payload.position)) void onOpenFileRef.current(path);
        } else {
          setDragging(false);
          setDropActive(false);
        }
      })
    ).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Browser/dev counterpart of the Tauri drag stream above: dim the library and spotlight the
  // Open card whenever a file is dragged anywhere over the window. A depth counter absorbs the
  // dragenter/dragleave pairs that fire while the pointer crosses nested children so the scrim
  // doesn't flicker; drop/dragend force it back down. (The Tauri shell drives `dragging` itself,
  // so skip these listeners there to avoid double-counting.)
  useEffect(() => {
    if (window.__TAURI_INTERNALS__) return;
    let depth = 0;
    const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const onEnter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth += 1;
      setDragging(true);
    };
    const onOver = (event: DragEvent) => {
      if (carriesFiles(event)) event.preventDefault();
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onEnd = (event: DragEvent) => {
      if (event.type === "drop") event.preventDefault();
      depth = 0;
      setDragging(false);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onEnd);
    window.addEventListener("dragend", onEnd);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onEnd);
      window.removeEventListener("dragend", onEnd);
    };
  }, []);

  const renderCard = (entry: LibraryEntry, frequency?: number) => (
    <InktileCard
      key={entry.id}
      entry={entry}
      frequency={frequency}
      query={query}
      sort={sort}
      editing={editingId === entry.id}
      busy={busyId === entry.id}
      onOpen={() => void openEntry(entry)}
      onEdit={() => setEditingId(entry.id)}
      onCancelEdit={() => setEditingId(null)}
      onRename={(title) => void renameEntry(entry, title)}
      onTogglePin={() => void togglePinEntry(entry)}
      onDuplicate={() => void duplicateEntry(entry)}
      onDelete={() => setDeleteTarget(entry)}
    />
  );

  return (
    <main className="library" aria-busy={loading}>
      <header className="library-header">
        <a className="inktile-wordmark" href="#library" aria-label="Inktile library">
          <img src="/inktile-logo.png" alt="" aria-hidden="true" />
          <strong>Inktile</strong>
        </a>
        <div className="library-header__actions">
          <button
            ref={settingsTriggerRef}
            className="library-button library-button--secondary"
            onClick={() => setSettingsOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
          ><SettingsIcon size={15} />Settings</button>
        </div>
      </header>

      <section className="library-topline" aria-label="Find and arrange inktiles">
        <div className="library-topline__heading">
          <h1 id="library-title">Library</h1>
          <span className="library-count">{entries.length} {entries.length === 1 ? "inktile" : "inktiles"}</span>
        </div>
        <div className="library-tools">
          <label className="library-search">
            <SearchIcon size={15} />
            <span className="sr-only">Search inktile titles and text</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Look up titles and text" />
            {hasQuery && <button onClick={() => setQuery("")} aria-label="Clear search">Clear</button>}
          </label>
          <select
            className="library-view"
            value={sort}
            onChange={(event) => setSort(event.target.value as LibrarySort)}
            aria-label="View inktiles by"
          >
            {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <button
            className="library-direction"
            onClick={() => setDirection((current) => current === "ascending" ? "descending" : "ascending")}
            aria-label={direction === "ascending" ? "Sort descending" : "Sort ascending"}
            title={direction === "ascending" ? "Ascending" : "Descending"}
          >
            {direction === "ascending" ? <ArrowUpIcon size={14} /> : <ArrowDownIcon size={14} />}
          </button>
          <div className="library-cardsize" role="group" aria-label="Card size">
            {CARD_SIZE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={preferences.cardSize === option.value ? "is-active" : ""}
                onClick={() => onPreferencesChange({ cardSize: option.value })}
                aria-pressed={preferences.cardSize === option.value}
                title={`${option.label} cards`}
                aria-label={`${option.label} cards`}
              >
                <option.Icon size={15} />
              </button>
            ))}
          </div>
        </div>
      </section>

      {loading ? (
        <div className="library-state" role="status">Opening your library…</div>
      ) : !entries.length ? (
        <section className="library-empty">
          <div className="library-empty__pages" aria-hidden="true"><span /><span /><span /></div>
          <p className="library-eyebrow">The shelf is empty</p>
          <h2>Start with a blank inktile.</h2>
          <p>New inktiles begin empty. Add text, versions, drawings, or media when you open one.</p>
          <button className="library-button library-button--primary" onClick={onCreate}><FileIcon size={15} />Create your first inktile</button>
          <button className="library-button library-button--secondary" onClick={() => void onImport()}><FolderIcon size={15} />Open .inktile</button>
        </section>
      ) : hasQuery ? (
        <div className="library-results" aria-live="polite">
          <p className="library-result-summary">{searchResults.length} {searchResults.length === 1 ? "inktile" : "inktiles"} found for “{query.trim()}”</p>
          {searchResults.length > 0 ? (
            <section className="library-result-group" aria-label="Matches">
              <div className={`inktile-grid inktile-grid--${preferences.cardSize}`}>{searchResults.map((entry) => renderCard(entry, entry.frequency || undefined))}</div>
            </section>
          ) : (
            <div className="library-state">
              <SearchIcon size={22} />
              <strong>No matching words</strong>
              <span>Try another title, word, or phrase.</span>
            </div>
          )}
        </div>
      ) : (
        <div className="library-sections">
          <section className="library-result-group" aria-label="Pinned and quick actions">
            <h2 className="library-eyebrow">Pinned</h2>
            <div
              ref={pinnedRowRef}
              className={`inktile-grid inktile-grid--${preferences.cardSize} inktile-grid--row${rowPanning ? " is-panning" : ""}`}
              onPointerDown={onRowPointerDown}
              onClickCapture={onRowClickCapture}
            >
              <button type="button" className="inktile-card inktile-card--action" onClick={onCreate}>
                <span className="inktile-card--action__icon" aria-hidden="true"><PlusIcon size={20} /></span>
                <span className="inktile-card--action__title">New inktile</span>
                <span className="inktile-card--action__hint">Start with a blank inktile.</span>
              </button>
              <button
                type="button"
                ref={openCardRef}
                className={`inktile-card inktile-card--action${dropActive ? " is-drop-target" : ""}${dragging ? " is-drag-lifted" : ""}`}
                onClick={() => void onImport()}
                onDragOver={onOpenCardDragOver}
                onDragLeave={() => setDropActive(false)}
                onDrop={onOpenCardDrop}
              >
                <span className="inktile-card--action__icon" aria-hidden="true"><FolderIcon size={20} /></span>
                <span className="inktile-card--action__title">Open .inktile</span>
                <span className="inktile-card--action__hint">{dropActive ? "Drop to open it." : "Bring in a file from disk."}</span>
              </button>
              {pinnedEntries.map((entry) => renderCard(entry))}
            </div>
            <RowScrollbar
              scrollerRef={pinnedRowRef}
              watch={`${pinnedEntries.length}-${preferences.cardSize}`}
              label="Scroll pinned inktiles"
            />
          </section>
          {unpinnedEntries.length > 0 && (
            <section className="library-result-group" aria-label="All inktiles">
              <h2 className="library-eyebrow">{orderLabel}</h2>
              <div className={`inktile-grid inktile-grid--${preferences.cardSize}`}>{unpinnedEntries.map((entry) => renderCard(entry))}</div>
            </section>
          )}
        </div>
      )}

      {dragging && <div className="library-drop-scrim" aria-hidden="true" />}

      {settingsOpen && (
        <div className="library-dialog library-settings-dialog" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeSettings(); }}>
          <section className="library-settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <span className="library-settings-panel__edge" aria-hidden="true" />
            <header className="library-settings-panel__header">
              <h2 id="settings-title">Settings</h2>
              <button ref={settingsCloseRef} className="library-settings-close" onClick={closeSettings} aria-label="Close settings"><CloseIcon /></button>
            </header>

            <div className="library-settings-list">
              <div className="library-setting-row" role="radiogroup" aria-labelledby="theme-label">
                <span className="library-setting-label" id="theme-label">Theme</span>
                <div className="library-theme-options">
                  {THEME_OPTIONS.map((option) => (
                    <label key={option.value} className={preferences.theme === option.value ? "is-selected" : ""}>
                      <input
                        type="radio"
                        name="theme"
                        value={option.value}
                        checked={preferences.theme === option.value}
                        onChange={() => onPreferencesChange({ theme: option.value })}
                      />
                      <span className={`library-theme-swatch library-theme-swatch--${option.value}`} aria-hidden="true" />
                      {option.label}
                    </label>
                  ))}
                </div>
              </div>

              <label className="library-setting-row library-setting-row--inline">
                <span>UI scale</span>
                <select
                  value={preferences.uiScale}
                  onChange={(event) => onPreferencesChange({ uiScale: Number(event.target.value) as UiScale })}
                  aria-label="UI scale"
                >
                  {UI_SCALE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>

              <div className="library-setting-row library-setting-row--inline">
                <span id="autosave-label">Autosave</span>
                <button
                  type="button"
                  className={`library-toggle-capsule${preferences.autosave ? " is-on" : ""}`}
                  role="switch"
                  aria-checked={preferences.autosave}
                  aria-labelledby="autosave-label"
                  onClick={() => onPreferencesChange({ autosave: !preferences.autosave })}
                >
                  <span className="library-toggle-capsule__knob" aria-hidden="true" />
                </button>
              </div>

              <div className="library-setting-row library-setting-row--inline">
                <span id="fullscreen-label">Fullscreen</span>
                <button
                  type="button"
                  className={`library-toggle-capsule${fullscreen ? " is-on" : ""}`}
                  role="switch"
                  aria-checked={fullscreen}
                  aria-labelledby="fullscreen-label"
                  onClick={() => void toggleFullscreen()}
                >
                  <span className="library-toggle-capsule__knob" aria-hidden="true" />
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      {deleteTarget && (
        <div className="library-dialog" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeleteTarget(null); }}>
          <section className="library-dialog__panel" role="alertdialog" aria-modal="true" aria-labelledby="delete-inktile-title" aria-describedby="delete-inktile-description">
            <p className="library-eyebrow">Remove from this device</p>
            <h2 id="delete-inktile-title">Delete “{deleteTarget.title}”?</h2>
            <p id="delete-inktile-description">This removes the inktile from your local library. A separate .inktile file saved elsewhere will not be deleted.</p>
            <div>
              <button className="library-button library-button--secondary" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button className="library-button library-button--danger" onClick={() => void confirmDelete()} disabled={busyId === deleteTarget.id}>Delete inktile</button>
            </div>
          </section>
        </div>
      )}

      {menu && (
        <HomeContextMenu
          state={menu}
          onClose={() => setMenu(null)}
          onCreate={onCreate}
          onImport={() => void onImport()}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenEntry={(entry) => void openEntry(entry)}
          onRenameEntry={(entry) => setEditingId(entry.id)}
          onTogglePinEntry={(entry) => void togglePinEntry(entry)}
          onDuplicateEntry={(entry) => void duplicateEntry(entry)}
          onDeleteEntry={(entry) => setDeleteTarget(entry)}
        />
      )}
    </main>
  );
}
