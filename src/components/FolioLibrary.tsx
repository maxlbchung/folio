import { useEffect, useMemo, useRef, useState } from "react";
import {
  deleteLibraryFolio,
  listLibraryFolios,
  renameLibraryFolio,
  searchLibraryFolios,
  sortLibraryFolios,
  type LibraryEntry,
  type LibrarySort,
  type SortDirection
} from "../persistence/library";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  EditIcon,
  FileIcon,
  FolderIcon,
  SearchIcon,
  TrashIcon
} from "./icons";

interface FolioLibraryProps {
  refreshToken: number;
  onCreate: () => void;
  onOpen: (id: string) => Promise<void>;
  onImport: () => Promise<void>;
  onStatus: (message: string) => void;
}

const SORT_OPTIONS: Array<{ value: LibrarySort; label: string }> = [
  { value: "lastOpenedAt", label: "Last opened" },
  { value: "createdAt", label: "Date created" },
  { value: "modifiedAt", label: "Last edited" },
  { value: "title", label: "Title" }
];

const relativeDate = (iso: string): string => {
  const date = new Date(iso);
  const elapsed = Date.now() - date.getTime();
  const days = Math.floor(elapsed / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }).format(date);
};

const excerptForQuery = (entry: LibraryEntry, query: string): string => {
  if (!query.trim()) return entry.previewText;
  const index = entry.plainText.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  if (index < 0) return entry.previewText;
  const start = Math.max(0, index - 52);
  const end = Math.min(entry.plainText.length, index + query.length + 88);
  return `${start ? "…" : ""}${entry.plainText.slice(start, end).trim()}${end < entry.plainText.length ? "…" : ""}`;
};

interface FolioCardProps {
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
  onDelete: () => void;
}

function FolioCard({
  entry, frequency, query, sort, editing, busy, onOpen, onEdit, onCancelEdit, onRename, onDelete
}: FolioCardProps) {
  const [draftTitle, setDraftTitle] = useState(entry.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraftTitle(entry.title);
  }, [entry.title, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commitRename = () => onRename(draftTitle);
  const sortDate = sort === "createdAt" ? entry.createdAt : sort === "modifiedAt" ? entry.modifiedAt : entry.lastOpenedAt;
  const dateLabel = sort === "createdAt" ? "Created" : sort === "modifiedAt" ? "Edited" : "Opened";
  const excerpt = excerptForQuery(entry, query);

  return (
    <article className="folio-card" data-folio-id={entry.id}>
      <span className="folio-card__edge" aria-hidden="true" />
      <div className="folio-card__topline">
        <span>{entry.pageCount} {entry.pageCount === 1 ? "page" : "pages"}</span>
        {frequency !== undefined && <span className="folio-card__frequency">{frequency} {frequency === 1 ? "match" : "matches"}</span>}
      </div>

      {editing ? (
        <form className="folio-card__rename" onSubmit={(event) => { event.preventDefault(); commitRename(); }}>
          <label className="sr-only" htmlFor={`rename-${entry.id}`}>Folio title</label>
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
        <button className="folio-card__open" onClick={onOpen} disabled={busy} aria-label={`Open ${entry.title}`}>
          <h2>{entry.title}</h2>
          <p>{excerpt || "Empty folio — open it to add the first page."}</p>
        </button>
      )}

      <footer className="folio-card__footer">
        <span>{dateLabel} {relativeDate(sortDate)}</span>
        <div className="folio-card__actions">
          <button className="library-icon-button" onClick={onEdit} disabled={busy || editing} title={`Edit title for ${entry.title}`} aria-label={`Edit title for ${entry.title}`}><EditIcon size={14} /></button>
          <button className="library-icon-button library-icon-button--danger" onClick={onDelete} disabled={busy} title={`Delete ${entry.title}`} aria-label={`Delete ${entry.title}`}><TrashIcon size={14} /></button>
        </div>
      </footer>
    </article>
  );
}

export function FolioLibrary({ refreshToken, onCreate, onOpen, onImport, onStatus }: FolioLibraryProps) {
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<LibrarySort>("lastOpenedAt");
  const [direction, setDirection] = useState<SortDirection>("descending");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LibraryEntry | null>(null);

  const refresh = async () => {
    setEntries(await listLibraryFolios());
  };

  useEffect(() => {
    void refresh().catch(() => onStatus("Library could not be loaded")).finally(() => setLoading(false));
  }, [refreshToken]);

  const sortedEntries = useMemo(() => sortLibraryFolios(entries, sort, direction), [entries, sort, direction]);
  const searchResults = useMemo(
    () => searchLibraryFolios(entries, query, sort, direction),
    [entries, query, sort, direction]
  );
  const hasQuery = Boolean(query.trim());
  const resultCount = searchResults.titleMatches.length + searchResults.textMatches.length;

  const openEntry = async (entry: LibraryEntry) => {
    setBusyId(entry.id);
    try {
      await onOpen(entry.id);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Folio could not be opened");
      setBusyId(null);
    }
  };

  const renameEntry = async (entry: LibraryEntry, title: string) => {
    setBusyId(entry.id);
    try {
      await renameLibraryFolio(entry.id, title);
      await refresh();
      setEditingId(null);
      onStatus("Title updated");
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Title could not be updated");
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    try {
      await deleteLibraryFolio(deleteTarget.id);
      await refresh();
      setDeleteTarget(null);
      onStatus("Folio deleted from this library");
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Folio could not be deleted");
    } finally {
      setBusyId(null);
    }
  };

  const renderCard = (entry: LibraryEntry, frequency?: number) => (
    <FolioCard
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
      onDelete={() => setDeleteTarget(entry)}
    />
  );

  return (
    <main className="library" aria-busy={loading}>
      <header className="library-header">
        <a className="folio-wordmark" href="#library" aria-label="Folio library">
          <span aria-hidden="true">F</span>
          <strong>Folio</strong>
        </a>
        <div className="library-header__actions">
          <button className="library-button library-button--secondary" onClick={() => void onImport()}><FolderIcon size={15} />Open .folio</button>
          <button className="library-button library-button--primary" onClick={onCreate}><FileIcon size={15} />New folio</button>
        </div>
      </header>

      <section className="library-intro" aria-labelledby="library-title">
        <div>
          <p className="library-eyebrow">Your working collection</p>
          <h1 id="library-title">Every folio, ready to continue.</h1>
          <p className="library-lede">Create, revisit, and search the words inside your locally stored folios.</p>
        </div>
        <span className="library-count"><strong>{entries.length}</strong>{entries.length === 1 ? "folio" : "folios"}</span>
      </section>

      <section className="library-controls" aria-label="Find and arrange folios">
        <label className="library-search">
          <SearchIcon size={17} />
          <span className="sr-only">Search folio titles and text</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Look up titles and text" />
          {hasQuery && <button onClick={() => setQuery("")} aria-label="Clear search">Clear</button>}
        </label>
        <div className="library-sort">
          <label>
            <span>View by</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as LibrarySort)} aria-label="View folios by">
              {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <button
            className="library-direction"
            onClick={() => setDirection((current) => current === "ascending" ? "descending" : "ascending")}
            aria-label={direction === "ascending" ? "Sort descending" : "Sort ascending"}
            title={direction === "ascending" ? "Ascending" : "Descending"}
          >
            {direction === "ascending" ? <ArrowUpIcon size={15} /> : <ArrowDownIcon size={15} />}
            {direction === "ascending" ? "Ascending" : "Descending"}
          </button>
        </div>
      </section>

      {loading ? (
        <div className="library-state" role="status">Opening your library…</div>
      ) : !entries.length ? (
        <section className="library-empty">
          <div className="library-empty__pages" aria-hidden="true"><span /><span /><span /></div>
          <p className="library-eyebrow">The shelf is empty</p>
          <h2>Start with a blank folio.</h2>
          <p>New folios begin empty. Add text, versions, drawings, or media when you open one.</p>
          <button className="library-button library-button--primary" onClick={onCreate}><FileIcon size={15} />Create your first folio</button>
        </section>
      ) : hasQuery ? (
        <div className="library-results" aria-live="polite">
          <p className="library-result-summary">{resultCount} {resultCount === 1 ? "folio" : "folios"} found for “{query.trim()}”</p>
          {searchResults.titleMatches.length > 0 && (
            <section className="library-result-group" aria-labelledby="title-match-heading">
              <div className="library-section-heading"><h2 id="title-match-heading">In titles</h2><span>{searchResults.titleMatches.length}</span></div>
              <div className="folio-grid">{searchResults.titleMatches.map((entry) => renderCard(entry))}</div>
            </section>
          )}
          {searchResults.textMatches.length > 0 && (
            <section className="library-result-group" aria-labelledby="text-match-heading">
              <div className="library-section-heading"><h2 id="text-match-heading">In folio text</h2><span>Most frequent first</span></div>
              <div className="folio-grid">{searchResults.textMatches.map((entry) => renderCard(entry, entry.frequency))}</div>
            </section>
          )}
          {resultCount === 0 && (
            <div className="library-state">
              <SearchIcon size={22} />
              <strong>No matching words</strong>
              <span>Try another title, word, or phrase.</span>
            </div>
          )}
        </div>
      ) : (
        <section className="library-result-group" aria-labelledby="all-folios-heading">
          <div className="library-section-heading"><h2 id="all-folios-heading">All folios</h2><span>{SORT_OPTIONS.find((option) => option.value === sort)?.label}</span></div>
          <div className="folio-grid">{sortedEntries.map((entry) => renderCard(entry))}</div>
        </section>
      )}

      {deleteTarget && (
        <div className="library-dialog" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeleteTarget(null); }}>
          <section className="library-dialog__panel" role="alertdialog" aria-modal="true" aria-labelledby="delete-folio-title" aria-describedby="delete-folio-description">
            <p className="library-eyebrow">Remove from this device</p>
            <h2 id="delete-folio-title">Delete “{deleteTarget.title}”?</h2>
            <p id="delete-folio-description">This removes the folio from your local library. A separate .folio file saved elsewhere will not be deleted.</p>
            <div>
              <button className="library-button library-button--secondary" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button className="library-button library-button--danger" onClick={() => void confirmDelete()} disabled={busyId === deleteTarget.id}>Delete folio</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
