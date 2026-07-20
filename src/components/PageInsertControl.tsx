import { useRef, useState } from "react";
import { useDocument } from "../document/DocumentContext";
import { createVariantBlock, uuid } from "../document/factories";
import { detectMediaPageType } from "../document/mediaTypes";
import { PlusIcon } from "./icons";

interface Props {
  afterPageId?: string;
}

export function PageInsertControl({ afterPageId }: Props) {
  const { addPage, addBlockPage, addAsset } = useDocument();
  const [open, setOpen] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const mediaInput = useRef<HTMLInputElement>(null);

  const finish = (action: () => void) => {
    action();
    setOpen(false);
  };

  const addMedia = async (file: File | undefined) => {
    if (!file) return;
    const type = detectMediaPageType(file.type, file.name);
    if (!type) {
      setMediaError(`“${file.name}” is not a supported media format yet. Choose an image, video, or audio file.`);
      return;
    }
    try {
      const assetId = await addAsset(file);
      if (type === "image") addBlockPage({ id: uuid(), type, assetId, height: 420, fit: "contain", alt: file.name }, afterPageId);
      if (type === "video") addBlockPage({ id: uuid(), type, assetId, height: 420, fit: "contain", controls: true }, afterPageId);
      if (type === "audio") addBlockPage({ id: uuid(), type, assetId, size: "compact" }, afterPageId);
      setOpen(false);
    } catch (error) {
      setMediaError(error instanceof Error ? error.message : "The media file could not be added.");
    }
  };

  return (
    <div className="page-insert">
      <button className="page-insert__trigger" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <PlusIcon size={14} /> Add tile
      </button>
      {open && (
        <div className="page-insert__menu">
          <button onClick={() => finish(() => addPage(afterPageId, "standard"))}><strong>Text</strong><span>Write freely</span></button>
          <button onClick={() => finish(() => addBlockPage(createVariantBlock(), afterPageId))}><strong>Versions</strong><span>Compare drafts</span></button>
          <button onClick={() => finish(() => addPage(afterPageId, "drawing"))}><strong>Drawing</strong><span>Sketch on a canvas</span></button>
          <button onClick={() => mediaInput.current?.click()}><strong>Media</strong><span>Image, video, or audio</span></button>
        </div>
      )}
      <input
        ref={mediaInput}
        hidden
        type="file"
        aria-label="Choose media file"
        onChange={(event) => {
          const input = event.currentTarget;
          void addMedia(input.files?.[0]).finally(() => { input.value = ""; });
        }}
      />
      {mediaError && (
        <div className="media-error" role="alertdialog" aria-modal="true" aria-labelledby="media-error-title">
          <div className="media-error__panel">
            <strong id="media-error-title">Unsupported file</strong>
            <p>{mediaError}</p>
            <button autoFocus onClick={() => setMediaError(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
