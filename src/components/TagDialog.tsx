import { useEffect, useRef, useState } from "react";
import { TAG_COLORS, type InktileTag } from "../persistence/tags";

interface TagDialogProps {
  /** Editing an existing tag; omitted when creating a new one. */
  tag?: InktileTag;
  /** Suggested swatch for a new tag (first preset color not in use). */
  defaultColor: string;
  /** How many inktiles carry the tag — shown in the delete confirmation (edit mode). */
  usageCount?: number;
  busy?: boolean;
  onSave: (name: string, color: string) => void;
  onDelete?: () => void;
  onCancel: () => void;
}

/** Create/edit dialog for a tag: name, preset color swatches, and a free-pick color well. */
export function TagDialog({ tag, defaultColor, usageCount = 0, busy, onSave, onDelete, onCancel }: TagDialogProps) {
  const [name, setName] = useState(tag?.name ?? "");
  const [color, setColor] = useState(tag?.color ?? defaultColor);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.select();
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  const customActive = !TAG_COLORS.includes(color);

  return (
    <div className="library-dialog" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="library-dialog__panel" role="dialog" aria-modal="true" aria-labelledby="tag-dialog-title">
        <p className="library-eyebrow">Tags</p>
        <h2 id="tag-dialog-title">{tag ? "Edit tag" : "New tag"}</h2>
        <form
          className="tag-dialog__form"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) onSave(name, color);
          }}
        >
          <label className="sr-only" htmlFor="tag-dialog-name">Tag name</label>
          <input
            id="tag-dialog-name"
            ref={nameRef}
            className="tag-dialog__name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Name this tag"
            maxLength={40}
          />
          <div className="tag-dialog__swatches" role="radiogroup" aria-label="Tag color">
            {TAG_COLORS.map((swatch) => (
              <button
                key={swatch}
                type="button"
                className={`tag-dialog__swatch${color === swatch ? " is-active" : ""}`}
                style={{ background: swatch }}
                onClick={() => setColor(swatch)}
                role="radio"
                aria-checked={color === swatch}
                aria-label={`Color ${swatch}`}
              />
            ))}
            <label className={`tag-dialog__swatch tag-dialog__swatch--custom${customActive ? " is-active" : ""}`} title="Custom color">
              <input type="color" value={color} onChange={(event) => setColor(event.target.value)} aria-label="Custom color" />
              {customActive && <span style={{ background: color }} aria-hidden="true" />}
            </label>
          </div>
          <div className="tag-dialog__actions">
            {tag && onDelete && (
              <button
                type="button"
                className={`library-button tag-dialog__delete${confirmingDelete ? " library-button--danger" : " library-button--secondary"}`}
                onClick={() => (confirmingDelete ? onDelete() : setConfirmingDelete(true))}
                disabled={busy}
              >
                {confirmingDelete
                  ? `Remove from ${usageCount} ${usageCount === 1 ? "inktile" : "inktiles"}?`
                  : "Delete tag"}
              </button>
            )}
            <button type="button" className="library-button library-button--secondary" onClick={onCancel}>Cancel</button>
            <button type="submit" className="library-button library-button--primary" disabled={busy || !name.trim()}>
              {tag ? "Save tag" : "Create tag"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
