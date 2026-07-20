import { useEffect } from "react";
import { createPortal } from "react-dom";

export type ExportFormat = "inktile" | "pdf" | "txt";

interface Props {
  native: boolean;
  onPick: (format: ExportFormat) => void;
  onClose: () => void;
}

/** Format picker behind the toolbar Export button; reuses the library dialog shell. */
export function ExportDialog({ native, onPick, onClose }: Props) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose]);

  // Portaled to <body>: the topbar's backdrop-filter makes it the containing block for
  // fixed-position descendants, which would pin the overlay to the 45px header instead
  // of covering the viewport.
  return createPortal(
    <div className="library-dialog" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="library-dialog__panel" role="dialog" aria-modal="true" aria-labelledby="export-dialog-title">
        <p className="library-eyebrow">Export</p>
        <h2 id="export-dialog-title">Export this inktile</h2>
        <div className="export-options">
          <button className="export-option" autoFocus onClick={() => onPick("inktile")}>
            <strong>Inktile file (.inktile)</strong>
            <span>{native
              ? "Save a full copy to a location you choose — pages, media, and notes. (Ctrl+Shift+S)"
              : "Download a full copy — pages, media, and notes. (Ctrl+Shift+S)"}</span>
          </button>
          <button className="export-option" onClick={() => onPick("pdf")}>
            <strong>PDF document</strong>
            <span>Lays the tiles out for print and opens the print dialog — pick “Save as PDF” there.</span>
          </button>
          <button className="export-option" onClick={() => onPick("txt")}>
            <strong>Text file (.txt)</strong>
            <span>Keeps just the text: every tile, all versions, and notes.</span>
          </button>
        </div>
        <div>
          <button className="library-button library-button--secondary" onClick={onClose}>Cancel</button>
        </div>
      </section>
    </div>,
    window.document.body
  );
}
