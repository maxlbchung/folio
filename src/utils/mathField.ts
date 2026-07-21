import katex from "katex";
import "katex/dist/katex.min.css";

/**
 * Math fields: atomic `<span class="math-field" data-tex="…" data-display="…"
 * contenteditable="false">` elements inside tile HTML. The document stores ONLY the TeX
 * source — the KaTeX rendering lives in a shadow root attached at display time, which
 * contentEditable serialization can never see, so stored HTML, archives, and the Inkjet
 * protocol stay clean without any stripping pass.
 */

export const MATH_FIELD_SELECTOR = ".math-field";

/** Marks a just-inserted field so the toolbar can find it and open the editor; never stored. */
export const FRESH_MATH_ATTR = "data-fresh-math";

// The zero-width space keeps Chromium's insertHTML from dropping the "empty" span; it never
// renders (the shadow root hides light DOM) and stripCaretArtifacts keeps it out of stored HTML.
export const mathFieldHtml = (): string =>
  `<span class="math-field" data-tex="" data-display="false" contenteditable="false" ${FRESH_MATH_ATTR}="true">​</span>`;

/** Rendered-state cache. Kept off-DOM (an attribute would leak into stored HTML); cloned
 * or pasted fields miss the map and simply re-render. */
const renderedKeys = new WeakMap<HTMLElement, string>();

/**
 * Every non-@font-face rule mentioning `.katex` from the app's stylesheets (the katex.css
 * import above lands there in every bundler). Fonts stay at document level: @font-face is
 * document-global and loaded faces apply inside shadow trees too.
 */
export const collectKatexCss = (): string => {
  const rules: string[] = [];
  for (const sheet of Array.from(window.document.styleSheets)) {
    let list: CSSRuleList | null = null;
    try { list = sheet.cssRules; } catch { continue; } // cross-origin sheet: not readable, skip
    if (!list) continue;
    for (const rule of Array.from(list)) {
      if (rule instanceof CSSFontFaceRule) continue;
      if (rule.cssText.includes(".katex")) rules.push(rule.cssText);
    }
  }
  return rules.join("\n");
};

// What an empty field looks like until its TeX arrives; also the shadow tree's own chrome.
const SHADOW_LOCAL_CSS = `
  .math-placeholder { font-style: italic; opacity: .55; }
`;

let shadowSheet: CSSStyleSheet | null = null;
const katexShadowSheet = (): CSSStyleSheet => {
  if (!shadowSheet) {
    shadowSheet = new CSSStyleSheet();
    shadowSheet.replaceSync(`${collectKatexCss()}\n${SHADOW_LOCAL_CSS}`);
  }
  return shadowSheet;
};

export const renderTexToHtml = (tex: string, display: boolean): string => {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false });
  } catch {
    return tex; // even throwOnError:false can reject malformed input wholesale
  }
};

/** Render TeX into `element` (a preview surface outside the editable flow, light DOM). */
export const renderTexInto = (element: HTMLElement, tex: string, display: boolean) => {
  element.innerHTML = tex.trim() ? renderTexToHtml(tex, display) : "";
};

/**
 * (Re)render every math field under `root`. Idempotent and cheap when nothing changed, so
 * views call it after any live-DOM rewrite and on every input; fields recreated by
 * contentEditable normalization or paste simply render again.
 */
export const renderMathIn = (root: ParentNode) => {
  for (const element of Array.from(root.querySelectorAll<HTMLElement>(MATH_FIELD_SELECTOR))) {
    const tex = element.getAttribute("data-tex") ?? "";
    const display = element.getAttribute("data-display") === "true";
    const key = `${display ? "D" : "I"}:${tex}`;
    if (renderedKeys.get(element) === key && element.shadowRoot) continue;
    const shadow = element.shadowRoot ?? element.attachShadow({ mode: "open" });
    shadow.adoptedStyleSheets = [katexShadowSheet()];
    shadow.innerHTML = tex.trim() ? renderTexToHtml(tex, display) : `<span class="math-placeholder">formula…</span>`;
    renderedKeys.set(element, key);
  }
};

/**
 * Static rendering for the print/PDF iframe: stored HTML keeps math fields empty, and a
 * fresh document has no shadow-render pass, so the KaTeX markup is baked into the light
 * DOM here instead. Pair with collectKatexCss() in the print stylesheet.
 */
export const renderMathInHtml = (html: string): string => {
  if (!html.includes("math-field")) return html;
  const body = new DOMParser().parseFromString(html, "text/html").body;
  for (const element of Array.from(body.querySelectorAll<HTMLElement>(MATH_FIELD_SELECTOR))) {
    const tex = element.getAttribute("data-tex") ?? "";
    const display = element.getAttribute("data-display") === "true";
    element.innerHTML = tex.trim() ? renderTexToHtml(tex, display) : "";
    element.removeAttribute("contenteditable");
  }
  return body.innerHTML;
};
