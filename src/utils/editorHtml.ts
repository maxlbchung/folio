/** The zero-width space used as an invisible caret anchor by the sub/sup controls. */
export const ZWSP = "\u200b";

const ZWSP_GLOBAL = new RegExp(ZWSP, "g");
const EMPTY_SCRIPT_TAG = /<(sub|sup)><\/\1>/g;
const EMPTY_BASELINE_SPAN = /<span style="vertical-align: baseline;?"><\/span>/g;

/**
 * Strip caret-anchor artifacts from edited tile HTML before it is stored: the sub/sup
 * toolbar buttons insert a zero-width space inside a fresh <sub>/<sup> (or inside a
 * baseline span when stepping out of one) so the caret visibly drops/raises immediately at
 * a collapsed caret. The anchors must stay in the live DOM while the tile is focused, but
 * stored HTML gets the ZWSPs removed plus any anchor element that emptied out as a result.
 */
export const stripCaretArtifacts = (html: string): string =>
  html.replace(ZWSP_GLOBAL, "").replace(EMPTY_SCRIPT_TAG, "").replace(EMPTY_BASELINE_SPAN, "");
