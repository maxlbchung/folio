// Presentation layer for agent turns. Document state always applies instantly
// (protocol acks, revision guard, undo, and autosave never wait on visuals);
// these helpers only pace how the already-committed change becomes visible —
// text types out, strokes draw one by one, and a shared FIFO queue keeps
// concurrent effects sequential. Cancellation is an epoch bump: a running
// animation notices it is stale and resolves without touching the DOM again,
// and the owning component snaps its view to the real state.

let epoch = 0;
let chain: Promise<void> = Promise.resolve();

/** True when the OS asks for reduced motion — every animation then snaps. */
const reducedMotion = (): boolean =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Invalidates every queued and running agent animation. Owners snap their own
 * DOM afterwards; stale runners resolve promptly without further DOM writes. */
export const cancelAgentAnimations = () => {
  epoch += 1;
  lastFocus = null;
};

// --- Agent focus -----------------------------------------------------------
//
// The reveal tasks report which element they are about to animate; the panel's
// follow mode subscribes to keep the viewport centered on the agent's work.

const focusListeners = new Set<(element: HTMLElement) => void>();
let lastFocus: HTMLElement | null = null;

/** Called by reveal tasks (and new-tile mounts) as they start on an element. */
export const reportAgentFocus = (element: HTMLElement) => {
  lastFocus = element;
  for (const listener of focusListeners) listener(element);
};

/** The most recent focus target, if it is still in the document. */
export const lastAgentFocus = (): HTMLElement | null =>
  lastFocus && lastFocus.isConnected ? lastFocus : null;

/** Subscribes to focus reports; returns the unsubscribe. */
export const onAgentFocus = (listener: (element: HTMLElement) => void): (() => void) => {
  focusListeners.add(listener);
  return () => {
    focusListeners.delete(listener);
  };
};

/**
 * Appends an animation to the global turn queue. Tasks run strictly one after
 * another — an op's visual effect starts only when every earlier op's effect
 * has finished — which is what makes rapid op bursts read as sequential work.
 */
export const queueAgentAnimation = (run: (isStale: () => boolean) => Promise<void>) => {
  const startedEpoch = epoch;
  const isStale = () => epoch !== startedEpoch;
  chain = chain.then(() => (isStale() ? undefined : run(isStale))).catch(() => undefined);
};

/** Drives frame(t) with t rising 0→1 over durationMs (time-based, so throttled
 * frames still finish on schedule). Resolves early — without a final frame —
 * when stale; the owner's snap is the authoritative final state. */
export const animateFrames = (durationMs: number, isStale: () => boolean, frame: (t: number) => void): Promise<void> =>
  new Promise((resolve) => {
    if (durationMs <= 0 || reducedMotion()) {
      if (!isStale()) frame(1);
      resolve();
      return;
    }
    const start = performance.now();
    const step = () => {
      if (isStale()) {
        resolve();
        return;
      }
      const t = Math.min(1, (performance.now() - start) / durationMs);
      frame(t);
      if (t >= 1) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

/** A short stale-aware pause between sequential steps (stroke gaps). */
export const animationPause = (ms: number, isStale: () => boolean): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0 || reducedMotion() || isStale()) {
      resolve();
      return;
    }
    setTimeout(resolve, ms);
  });

// --- Text reveal -----------------------------------------------------------
//
// A tile's content is revealed by a single character budget walked across the
// DOM in document order. Text nodes truncate to their share of the budget;
// elements with no text at all (math fields, <br>, <hr>) are atoms worth one
// budget unit that toggle visibility; block containers stay hidden until their
// first character arrives, so paragraphs, list items, and tables appear as
// they start to "type" rather than as empty skeletons up front.

type RevealUnit =
  | { kind: "text"; node: Text; full: string }
  | { kind: "atom"; element: HTMLElement };

interface RevealPlan {
  units: RevealUnit[];
  /** Block containers paired with the budget offset that reveals them. */
  containers: { element: HTMLElement; revealAt: number }[];
  total: number;
}

/** Atoms stand in for one signature character so edits around them diff sanely. */
const ATOM_CHAR = "￼";

const HIDE_CONTAINERS = new Set(["P", "LI", "UL", "OL", "TABLE", "H1", "H2", "H3", "H4", "H5", "H6", "DIV", "PRE", "BLOCKQUOTE"]);

const collectUnits = (root: HTMLElement): RevealUnit[] => {
  const units: RevealUnit[] = [];
  const visit = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child instanceof Text) {
        if (child.data.length) units.push({ kind: "text", node: child, full: child.data });
      } else if (child instanceof HTMLElement) {
        // Shadow content (rendered math) never counts as text, so math fields
        // land here alongside <br>/<hr> and other intentionally empty elements.
        if ((child.textContent ?? "") === "") units.push({ kind: "atom", element: child });
        else visit(child);
      }
    }
  };
  visit(root);
  return units;
};

const planReveal = (root: HTMLElement): RevealPlan => {
  const units = collectUnits(root);
  const offsets: number[] = [];
  let total = 0;
  for (const unit of units) {
    offsets.push(total);
    total += unit.kind === "text" ? unit.full.length : 1;
  }
  const containers: RevealPlan["containers"] = [];
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    if (!HIDE_CONTAINERS.has(element.tagName)) continue;
    const first = units.findIndex((unit) =>
      unit.kind === "text" ? element.contains(unit.node) : element.contains(unit.element)
    );
    if (first !== -1) containers.push({ element, revealAt: offsets[first] });
  }
  return { units, containers, total };
};

/** The reveal signature: what a budget position means, independent of markup. */
const revealSignature = (root: HTMLElement): string =>
  collectUnits(root)
    .map((unit) => (unit.kind === "text" ? unit.full : ATOM_CHAR))
    .join("");

const applyBudget = (plan: RevealPlan, budget: number) => {
  let remaining = budget;
  for (const unit of plan.units) {
    const length = unit.kind === "text" ? unit.full.length : 1;
    const take = Math.min(length, Math.max(0, remaining));
    remaining -= take;
    if (unit.kind === "text") {
      const next = unit.full.slice(0, take);
      if (unit.node.data !== next) unit.node.data = next;
    } else {
      unit.element.style.display = take > 0 ? "" : "none";
    }
  }
  for (const { element, revealAt } of plan.containers) {
    element.style.display = budget > revealAt ? "" : "none";
  }
};

const commonPrefixLength = (a: string, b: string): number => {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) index += 1;
  return index;
};

/** Typing speed: ~85 chars/s, but any single transition finishes fast. */
const typeDuration = (chars: number) => Math.min(900, Math.max(140, chars * 12));
/** Deleting reads best a little faster than typing. */
const deleteDuration = (chars: number) => Math.min(500, Math.max(110, chars * 5));

/**
 * Morphs a text tile's DOM from whatever it currently shows to targetHtml:
 * content past the common prefix deletes backwards, then the remainder of the
 * target types forward. prepare() runs after every full innerHTML write so the
 * caller can re-render math fields. The final state is always a clean rewrite
 * of targetHtml — no leftover inline display styles.
 */
export const animateTextTransition = async (
  element: HTMLElement,
  targetHtml: string,
  isStale: () => boolean,
  prepare: () => void
): Promise<void> => {
  const probe = element.ownerDocument.createElement("div");
  probe.innerHTML = targetHtml;
  const targetSignature = revealSignature(probe);
  const currentSignature = revealSignature(element);
  const prefix = commonPrefixLength(currentSignature, targetSignature);

  if (currentSignature.length > prefix) {
    const plan = planReveal(element);
    await animateFrames(deleteDuration(currentSignature.length - prefix), isStale, (t) => {
      applyBudget(plan, Math.round(currentSignature.length - (currentSignature.length - prefix) * t));
    });
    if (isStale()) return;
  }

  element.innerHTML = targetHtml;
  prepare();
  if (targetSignature.length > prefix) {
    const plan = planReveal(element);
    // Same tick as the innerHTML write, so the full target never paints early.
    applyBudget(plan, prefix);
    await animateFrames(typeDuration(targetSignature.length - prefix), isStale, (t) => {
      applyBudget(plan, Math.round(prefix + (targetSignature.length - prefix) * t));
    });
    if (isStale()) return;
  }
  element.innerHTML = targetHtml;
  prepare();
};
