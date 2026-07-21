import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDocument } from "../document/DocumentContext";
import { isSafeLinkHref, normalizeLinkUrl, notifyInput, openLinkExternally, unwrapElement } from "../utils/richText";
import { OpenExternalIcon } from "./icons";

/**
 * The popover a plain click on a tile link opens: the display text and destination are
 * both editable in place, an Open action launches the destination externally (the webview
 * itself never navigates), and a small inert live preview of the page renders below —
 * with an explicit fallback when the site refuses to be embedded (X-Frame-Options/CSP),
 * which most large sites do. One host is mounted per editor view; the tile views summon
 * it through `openLinkPreview`.
 */

interface LinkPreviewState {
  element: HTMLAnchorElement;
  /** The tile editable owning the link, captured at open so Remove can still commit. */
  editable: HTMLElement;
  href: string;
  text: string;
  anchor: DOMRect;
}

/** Open Graph card the desktop shell unfurls (fetch_link_metadata in src-tauri). */
interface LinkMetadata {
  title?: string | null;
  description?: string | null;
  image?: string | null;
}

let openHandler: ((element: HTMLAnchorElement) => void) | null = null;

/** Show the link popover for a tile link (no-op for unsafe or missing hrefs). */
export const openLinkPreview = (element: HTMLAnchorElement) => openHandler?.(element);

export function LinkPreviewHost() {
  const { agentTurn, checkpoint } = useDocument();
  const [state, setState] = useState<LinkPreviewState | null>(null);
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [frameLoaded, setFrameLoaded] = useState(false);
  // null = no card (web build, or the shell found nothing → fall back to the embed);
  // "pending" = the shell is unfurling; an object = render the metadata card.
  const [metadata, setMetadata] = useState<LinkMetadata | "pending" | null>(null);
  const [cardImageFailed, setCardImageFailed] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    openHandler = (element) => {
      const href = element.getAttribute("href") ?? "";
      if (!isSafeLinkHref(href)) return;
      const editable = element.closest<HTMLElement>(".text-block, .variant-editor");
      if (!editable) return;
      const currentText = (element.textContent ?? "").trim();
      setText(currentText);
      setUrl(href);
      setFrameLoaded(false);
      setCardImageFailed(false);
      // Desktop: ask the shell for the page's Open Graph card (native fetches are not
      // subject to CORS — the same trick chat apps perform on their servers). The web
      // build cannot read cross-origin HTML, so it goes straight to the live embed.
      const unfurl = Boolean(window.__TAURI_INTERNALS__) && /^https?:/i.test(href);
      setMetadata(unfurl ? "pending" : null);
      setState({ element, editable, href, text: currentText, anchor: element.getBoundingClientRect() });
      if (unfurl) {
        void (async () => {
          let card: LinkMetadata | null = null;
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            const result = await invoke<LinkMetadata>("fetch_link_metadata", { url: href });
            if (result && (result.title || result.description || result.image)) card = result;
          } catch {
            // Unfurl unavailable (old shell, mock, network): the embed takes over below.
          }
          if (stateRef.current?.element === element) setMetadata(card);
        })();
      }
    };
    return () => { openHandler = null; };
  }, []);

  // Focus the destination field without scrolling: focus-driven scroll events must never
  // reach dismiss listeners (and there is deliberately no scroll-dismiss here anyway).
  useEffect(() => {
    if (state) urlInputRef.current?.focus({ preventScroll: true });
  }, [state]);

  // Clamp to the viewport once measured; flip above the link when the bottom overflows.
  // Re-run when the preview/card sections appear, since that changes the popover height.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || !state) return;
    const left = Math.max(8, Math.min(state.anchor.left, window.innerWidth - panel.offsetWidth - 8));
    let top = state.anchor.bottom + 6;
    if (top + panel.offsetHeight > window.innerHeight - 8) {
      top = Math.max(8, state.anchor.top - panel.offsetHeight - 6);
    }
    setPosition({ left, top });
  }, [state, frameLoaded, metadata, cardImageFailed]);

  // Dismiss on outside pointer, Escape, or resize. No scroll-dismiss: the popover holds
  // text inputs, and an incidental scroll must not eat what the user is typing.
  useEffect(() => {
    if (!state) return;
    const close = () => setState(null);
    const handlePointer = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) close();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("mousedown", handlePointer, true);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", handlePointer, true);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("resize", close);
    };
  }, [state]);

  const validUrl = normalizeLinkUrl(url);

  const apply = () => {
    if (!state || agentTurn || !validUrl) return;
    if (state.element.isConnected) {
      const nextText = text.trim() || validUrl;
      if (nextText !== state.text || validUrl !== state.href) {
        checkpoint();
        state.element.setAttribute("href", validUrl);
        // Editing the display text replaces the link's content as plain text.
        if (nextText !== (state.element.textContent ?? "").trim()) state.element.textContent = nextText;
        notifyInput(state.editable);
      }
    }
    setState(null);
  };

  const remove = () => {
    if (!state || agentTurn) return;
    if (state.element.isConnected) {
      checkpoint();
      unwrapElement(state.element);
      notifyInput(state.editable);
    }
    setState(null);
  };

  if (!state) return null;

  let parsed: URL | null = null;
  try { parsed = new URL(state.href); } catch { /* beyond repair: still allow editing */ }
  const isWeb = parsed?.protocol === "http:" || parsed?.protocol === "https:";
  // The unfurled card wins over the live embed; the embed is the fallback when there is
  // no card (web build, shell found nothing, or unfurl failed). Per the no-broken-images
  // rule, a card image that fails to load simply disappears.
  const card = metadata !== "pending" && metadata !== null ? metadata : null;
  const cardImage = card?.image && !cardImageFailed ? card.image : null;
  const cardText = card && (card.title || card.description) ? card : null;
  const showCard = isWeb && Boolean(cardImage || cardText);
  const showEmbed = isWeb && metadata === null;
  const applyOnEnter = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      apply();
    }
  };

  return createPortal(
    <div
      ref={panelRef}
      className="link-preview"
      role="dialog"
      aria-label="Link"
      style={{ left: position.left, top: position.top }}
    >
      <label className="link-preview__row">
        <span className="link-preview__label">Text</span>
        <input
          type="text"
          aria-label="Link text"
          placeholder="Display text"
          value={text}
          disabled={agentTurn}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={applyOnEnter}
        />
      </label>
      <label className="link-preview__row">
        <span className="link-preview__label">Link</span>
        {isWeb && parsed && (
          <img
            className="link-preview__favicon"
            src={`${parsed.origin}/favicon.ico`}
            alt=""
            onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
          />
        )}
        <input
          ref={urlInputRef}
          type="text"
          aria-label="Link URL"
          placeholder="https://…"
          value={url}
          disabled={agentTurn}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={applyOnEnter}
        />
      </label>
      {showCard && (
        <div className="link-preview__card" aria-hidden="true">
          {cardImage && (
            <img src={cardImage} alt="" onError={() => setCardImageFailed(true)} />
          )}
          {cardText && (
            <div className="link-preview__card-text">
              {cardText.title && <span className="link-preview__card-title">{cardText.title}</span>}
              {cardText.description && <span className="link-preview__card-desc">{cardText.description}</span>}
            </div>
          )}
        </div>
      )}
      {showEmbed && (
        /* The preview defaults to absent and appears only for a PROVEN successful load.
           An <object> embed is used instead of an iframe deliberately: iframes fire load
           for Chromium's own error pages too (refused embeds, network failures — the
           "sad file" page) and expose nothing that distinguishes them from a successful
           cross-origin page, while <object> honors the spec's fallback semantics and
           fires its error event for those failures. Sites that refuse framing
           (X-Frame-Options / CSP frame-ancestors — most large sites) therefore never
           show a preview; the browser offers no way to fetch their metadata instead
           (services like Google Docs unfurl links server-side). While pending, the frame
           is clipped to zero height rather than display:none so the embed still loads.
           Inert (no pointer events, so no user activation inside — Chromium blocks
           non-activated top-navigation and popups from embeds): a zoomed-out look at the
           page, not a browser. Rendered for the link's ORIGINAL destination. */
        <div className={`link-preview__frame ${frameLoaded ? "" : "link-preview__frame--pending"}`.trim()} aria-hidden="true">
          <object
            type="text/html"
            data={state.href}
            tabIndex={-1}
            onLoad={() => setFrameLoaded(true)}
          />
        </div>
      )}
      <div className="link-preview__actions">
        <button
          className="link-preview__open"
          title="Open link"
          aria-label="Open link"
          onClick={() => openLinkExternally(validUrl ?? state.href)}
        ><OpenExternalIcon size={13} />Open</button>
        {/* Editing actions disappear under the agent-turn lock; opening stays available. */}
        {!agentTurn && (
          <>
            <button className="link-preview__remove" onClick={remove}>Remove</button>
            <button className="link-preview__apply" disabled={!validUrl} onClick={apply}>Apply</button>
          </>
        )}
      </div>
    </div>,
    window.document.body
  );
}
