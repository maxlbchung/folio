import { useEffect, useRef, useState } from "react";
import { DocumentProvider, useDocument } from "./document/DocumentContext";
import { FolioLibrary } from "./components/FolioLibrary";
import { Toolbar } from "./components/Toolbar";
import { PageStack } from "./components/PageStack";
import { readAutosave, writeAutosave } from "./persistence/autosave";
import { openDocumentFile } from "./persistence/fileSystem";
import {
  getCachedLibraryFolio,
  openLibraryFolio,
  saveLibraryFolio,
  touchLibraryFolio
} from "./persistence/library";
import "./styles/app.css";

function EditorApp() {
  const { document, assets, dirty, currentPath, newDocument, loadDocument } = useDocument();
  const [status, setStatus] = useState("");
  const [view, setView] = useState<"library" | "editor">("library");
  const [libraryReady, setLibraryReady] = useState(false);
  const [libraryRevision, setLibraryRevision] = useState(0);
  const initialized = useRef(false);

  useEffect(() => {
    const root = window.document.documentElement;
    const apply = () => {
      const theme = document.settings.theme;
      const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
      root.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [document.settings.theme]);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    setLibraryReady(true);
    void readAutosave().then(async (loaded) => {
      if (loaded) {
        try {
          await saveLibraryFolio(loaded.document, loaded.assets, loaded.path);
          setLibraryRevision((revision) => revision + 1);
          if (loaded.recovery) setStatus("Recovered folio added to your library");
        } finally {
          Object.values(loaded.assets).forEach((asset) => URL.revokeObjectURL(asset.url));
        }
      }
    }).catch(() => setStatus("Recovery data could not be read"));
  }, []);

  useEffect(() => {
    if (view !== "editor" || !dirty) return;
    const timer = window.setTimeout(() => {
      void Promise.all([
        writeAutosave(document, assets, currentPath),
        saveLibraryFolio(document, assets, currentPath)
      ]).then(() => setStatus("Autosaved")).catch(() => setStatus("Autosave failed"));
    }, 1400);
    return () => clearTimeout(timer);
  }, [document, assets, dirty, currentPath, view]);

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), 1800);
    return () => clearTimeout(timer);
  }, [status]);

  const createNewFolio = () => {
    const created = newDocument();
    setView("editor");
    void saveLibraryFolio(created, {}, null, { touchOpened: true }).catch(() => setStatus("New folio could not be added to the library"));
  };

  const openFromLibrary = async (id: string) => {
    const loaded = getCachedLibraryFolio(id) ?? await openLibraryFolio(id);
    if (!loaded) throw new Error("That folio is no longer in this library.");
    loadDocument(loaded, loaded.path);
    setView("editor");
    void touchLibraryFolio(id).catch(() => setStatus("Last-opened time could not be updated"));
  };

  const openExternalFolio = async () => {
    const loaded = await openDocumentFile();
    if (!loaded) return;
    loadDocument(loaded, loaded.path);
    setView("editor");
    setStatus("Opened and added to your library");
    void saveLibraryFolio(loaded.document, loaded.assets, loaded.path, { touchOpened: true })
      .catch(() => setStatus("Opened, but could not be added to your library"));
  };

  const showLibrary = () => {
    setView("library");
    if (!dirty) return;
    void Promise.all([
      saveLibraryFolio(document, assets, currentPath),
      writeAutosave(document, assets, currentPath)
    ]).catch(() => setStatus("Latest changes could not be added to the library"));
  };

  return (
    <div className={`app-shell app-shell--${view}`}>
      {!libraryReady ? (
        <div className="library-boot" role="status"><span>F</span><p>Opening Folio…</p></div>
      ) : view === "library" ? (
        <FolioLibrary
          refreshToken={libraryRevision}
          onCreate={createNewFolio}
          onOpen={openFromLibrary}
          onImport={openExternalFolio}
          onStatus={setStatus}
        />
      ) : (
        <>
          <Toolbar
            onStatus={setStatus}
            onHome={showLibrary}
            onNewDocument={createNewFolio}
            onOpenDocument={openExternalFolio}
          />
          <PageStack />
        </>
      )}
      {status && <div className="toast" role="status">{status}</div>}
    </div>
  );
}

export default function App() {
  return <DocumentProvider><EditorApp /></DocumentProvider>;
}
