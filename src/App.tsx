import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DocumentProvider, useDocument } from "./document/DocumentContext";
import { InktileHome } from "./components/InktileHome";
import { Toolbar } from "./components/Toolbar";
import { PageStack } from "./components/PageStack";
import { TileSelectionProvider } from "./components/TileSelectionContext";
import { InkjetPanel } from "./components/InkjetPanel";
import { EditorContextMenu } from "./components/EditorContextMenu";
import { TextContextMenu } from "./components/TextContextMenu";
import { WorkspaceScrollbar } from "./components/WorkspaceScrollbar";
import { readAutosave, writeAutosave } from "./persistence/autosave";
import { openDocumentBlob, openDocumentFile, openDocumentPath, overwriteDocumentPath, type OpenResult } from "./persistence/fileSystem";
import {
  getCachedLibraryInktile,
  openLibraryInktile,
  saveLibraryInktile,
  touchLibraryInktile
} from "./persistence/library";
import {
  readPreferences,
  writePreferences,
  type AppPreferences
} from "./persistence/preferences";
import "./styles/app.css";

/** Force the Tauri window shut, bypassing the close-request guard below (no-op on web). */
async function destroyAppWindow() {
  if (!window.__TAURI_INTERNALS__) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().destroy();
}

/** Where a pending leave was headed when autosave is off and edits are unsaved. */
type PendingExit = "home" | "close";

function EditorApp() {
  const { document, assets, dirty, currentPath, newDocument, loadDocument, markSaved } = useDocument();
  const [status, setStatus] = useState("");
  const [view, setView] = useState<"library" | "editor">("library");
  const [libraryReady, setLibraryReady] = useState(false);
  const [libraryRevision, setLibraryRevision] = useState(0);
  const [preferences, setPreferences] = useState(readPreferences);
  // When autosave is off and there are unsaved edits, leaving (Home) or closing the window is
  // held behind a confirmation dialog; this records where the interrupted leave was headed.
  const [pendingExit, setPendingExit] = useState<PendingExit | null>(null);
  const [resolvingExit, setResolvingExit] = useState(false);
  const initialized = useRef(false);

  const updatePreferences = useCallback((patch: Partial<AppPreferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...patch };
      writePreferences(next);
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    const root = window.document.documentElement;
    const apply = () => {
      const theme = preferences.theme;
      const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
      root.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preferences.theme]);

  useLayoutEffect(() => {
    const root = window.document.documentElement;
    root.style.setProperty("--ui-scale", String(preferences.uiScale));
    root.style.setProperty("--ui-scale-inverse", String(1 / preferences.uiScale));
  }, [preferences.uiScale]);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    setLibraryReady(true);
    void readAutosave().then(async (loaded) => {
      if (loaded) {
        try {
          await saveLibraryInktile(loaded.document, loaded.assets, loaded.path);
          setLibraryRevision((revision) => revision + 1);
          if (loaded.recovery) setStatus("Recovered inktile added to your library");
        } finally {
          Object.values(loaded.assets).forEach((asset) => URL.revokeObjectURL(asset.url));
        }
      }
    }).catch(() => setStatus("Recovery data could not be read"));
  }, []);

  const latestEdit = useRef({ document, assets });
  useEffect(() => {
    latestEdit.current = { document, assets };
  });

  // Autosave IS the save: every debounced persist writes the library snapshot, a confirmed
  // (non-recovery) autosave record, and — natively — the external file at currentPath.
  // The chain serializes overlapping flushes so two persists never interleave file writes,
  // and markSaved only clears the dirty indicator when no newer edit arrived meanwhile.
  const persistChain = useRef(Promise.resolve());
  const persistEditorState = () => {
    const snapshotDocument = document;
    const snapshotAssets = assets;
    const path = currentPath;
    const run = persistChain.current.then(async () => {
      const writes: Promise<unknown>[] = [
        writeAutosave(snapshotDocument, snapshotAssets, path, false),
        saveLibraryInktile(snapshotDocument, snapshotAssets, path)
      ];
      if (path && window.__TAURI_INTERNALS__) writes.push(overwriteDocumentPath(snapshotDocument, snapshotAssets, path));
      await Promise.all(writes);
      if (latestEdit.current.document === snapshotDocument && latestEdit.current.assets === snapshotAssets) markSaved();
    });
    persistChain.current = run.catch(() => undefined);
    return run;
  };

  // The window close-request listener is registered once but must act on the live document state,
  // so mirror the values it needs into a ref that every render refreshes.
  const exitContextRef = useRef({ dirty, autosave: preferences.autosave, persist: persistEditorState });
  exitContextRef.current = { dirty, autosave: preferences.autosave, persist: persistEditorState };

  useEffect(() => {
    if (view !== "editor" || !dirty || !preferences.autosave) return;
    const timer = window.setTimeout(() => {
      void persistEditorState().then(() => setStatus("Autosaved")).catch(() => setStatus("Autosave failed"));
    }, 1400);
    return () => clearTimeout(timer);
  }, [document, assets, dirty, currentPath, view, preferences.autosave]);

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), 1800);
    return () => clearTimeout(timer);
  }, [status]);

  // Desktop: intercept the window's close button. With nothing unsaved we let it close; with
  // autosave on we flush first; otherwise we hold the close and ask via the confirmation dialog.
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      if (disposed) return;
      return getCurrentWindow()
        .onCloseRequested(async (event) => {
          const { dirty: isDirty, autosave, persist } = exitContextRef.current;
          if (!isDirty) return;
          event.preventDefault();
          if (autosave) {
            try {
              await persist();
            } catch {
              // Fall through: closing was requested, so don't trap the user on a save failure.
            }
            await destroyAppWindow();
          } else {
            setPendingExit("close");
          }
        })
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        });
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Web fallback: async saving before unload isn't possible, so at least raise the browser's
  // native "leave site?" prompt when there are unsaved edits and autosave is off.
  useEffect(() => {
    if (window.__TAURI_INTERNALS__) return;
    const handler = (event: BeforeUnloadEvent) => {
      const { dirty: isDirty, autosave } = exitContextRef.current;
      if (!isDirty || autosave) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // Escape cancels the unsaved-changes dialog (equivalent to "stay"), unless a save is in flight.
  useEffect(() => {
    if (!pendingExit) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !resolvingExit) setPendingExit(null);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [pendingExit, resolvingExit]);

  const createNewInktile = () => {
    const created = newDocument();
    setView("editor");
    void saveLibraryInktile(created, {}, null, { touchOpened: true }).catch(() => setStatus("New inktile could not be added to the library"));
  };

  const openFromLibrary = async (id: string) => {
    const loaded = getCachedLibraryInktile(id) ?? await openLibraryInktile(id);
    if (!loaded) throw new Error("That inktile is no longer in this library.");
    loadDocument(loaded);
    setView("editor");
    void touchLibraryInktile(id).catch(() => setStatus("Last-opened time could not be updated"));
  };

  const openLoadedInktile = (loaded: OpenResult) => {
    loadDocument(loaded);
    setView("editor");
    setStatus("Opened and added to your library");
    void saveLibraryInktile(loaded.document, loaded.assets, loaded.path, { touchOpened: true })
      .catch(() => setStatus("Opened, but could not be added to your library"));
  };

  const openExternalInktile = async () => {
    const loaded = await openDocumentFile();
    if (!loaded) return;
    openLoadedInktile(loaded);
  };

  /** Open a dropped inktile: a browser File in web builds, an absolute path in the Tauri shell. */
  const openDroppedInktile = async (source: File | string) => {
    try {
      openLoadedInktile(typeof source === "string" ? await openDocumentPath(source) : await openDocumentBlob(source));
    } catch {
      setStatus("That file could not be opened as an inktile");
    }
  };

  // Leave the editor for the library, persisting the current inktile on the way out. Home mounts
  // immediately and lists the index as-is; refresh it again once the exit flush lands so freshly
  // typed text/titles are searchable right away.
  const navigateHome = () => {
    setView("library");
    void persistEditorState()
      .then(() => setLibraryRevision((revision) => revision + 1))
      .catch(() => setStatus("Latest changes could not be added to the library"));
  };

  const showLibrary = () => {
    // Nothing unsaved, or autosave will capture it on the way out: leave immediately.
    if (!dirty || preferences.autosave) {
      if (dirty) navigateHome();
      else setView("library");
      return;
    }
    // Autosave off with unsaved edits: confirm before leaving so nothing is lost silently.
    setPendingExit("home");
  };

  // Resolve the unsaved-changes dialog. "save" flushes first; both choices then complete the
  // interrupted leave (back to the library, or closing the window). Cancel just dismisses it.
  const resolveExit = async (choice: "save" | "discard") => {
    const kind = pendingExit;
    if (!kind || resolvingExit) return;
    setResolvingExit(true);
    try {
      if (choice === "save") {
        try {
          await persistEditorState();
        } catch {
          // Keep the dialog open on a failed save so the edits aren't lost to the close.
          setStatus("Changes could not be saved");
          return;
        }
      }
      setPendingExit(null);
      if (kind === "home") {
        setView("library");
        if (choice === "save") setLibraryRevision((revision) => revision + 1);
      } else {
        await destroyAppWindow();
      }
    } finally {
      setResolvingExit(false);
    }
  };

  return (
    <div className={`app-shell app-shell--${view}`}>
      {!libraryReady ? (
        <div className="library-boot" role="status"><img src="/inktile-logo.png" alt="" aria-hidden="true" /><p>Opening Inktile…</p></div>
      ) : view === "library" ? (
        <>
          <InktileHome
            refreshToken={libraryRevision}
            preferences={preferences}
            onCreate={createNewInktile}
            onOpen={openFromLibrary}
            onImport={openExternalInktile}
            onOpenFile={openDroppedInktile}
            onPreferencesChange={updatePreferences}
            onStatus={setStatus}
          />
          <WorkspaceScrollbar className="workspace-scrollbar--library" />
        </>
      ) : (
        <>
          <Toolbar
            onStatus={setStatus}
            onHome={showLibrary}
            onNewDocument={createNewInktile}
            onOpenDocument={openExternalInktile}
            onSave={persistEditorState}
          />
          <TileSelectionProvider onStatus={setStatus}>
            <PageStack />
            <EditorContextMenu onStatus={setStatus} />
          </TileSelectionProvider>
          <InkjetPanel />
          <WorkspaceScrollbar />
        </>
      )}
      <TextContextMenu />
      {pendingExit && (
        <div
          className="library-dialog"
          role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget && !resolvingExit) setPendingExit(null); }}
        >
          <section className="library-dialog__panel" role="alertdialog" aria-modal="true" aria-labelledby="unsaved-title" aria-describedby="unsaved-description">
            <p className="library-eyebrow">Unsaved changes</p>
            <h2 id="unsaved-title">Save changes to “{document.title.trim() || "Untitled"}”?</h2>
            <p id="unsaved-description">
              {pendingExit === "close"
                ? "This inktile has changes that haven’t been saved. Closing now will discard them unless you save."
                : "This inktile has changes that haven’t been saved. Leaving now will discard them unless you save."}
            </p>
            <div>
              <button className="library-button library-button--secondary" onClick={() => setPendingExit(null)} disabled={resolvingExit}>Cancel</button>
              <button className="library-button library-button--danger" onClick={() => void resolveExit("discard")} disabled={resolvingExit}>Don’t save</button>
              <button className="library-button library-button--primary" onClick={() => void resolveExit("save")} disabled={resolvingExit}>Save changes</button>
            </div>
          </section>
        </div>
      )}
      {status && <div className="toast" role="status">{status}</div>}
    </div>
  );
}

export default function App() {
  return <DocumentProvider><EditorApp /></DocumentProvider>;
}
