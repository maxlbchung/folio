import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Smallest the proportional handle may get, so it stays grabbable on very long documents. */
const MIN_HANDLE = 24;

/**
 * Minimalist overlay scrollbar for window-scrolled views (editor and Home library): a thin
 * vertical line whose small handle maps scroll progress to position (top = scrolled up,
 * bottom = scrolled down). Rendered through a portal to `document.body` so the app-shell's
 * `zoom` (UI scale) doesn't skew the viewport-pixel math it shares with `window.scrollY`.
 */
export function WorkspaceScrollbar({ className }: { className?: string }) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startY: number; startTop: number; maxHandle: number; maxScroll: number } | null>(null);
  const frameRef = useRef(0);
  const [progress, setProgress] = useState(0);
  const [fraction, setFraction] = useState(1);
  const [scrollable, setScrollable] = useState(false);
  const [active, setActive] = useState(false);

  const measure = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      const total = document.documentElement.scrollHeight;
      const maxScroll = total - window.innerHeight;
      setScrollable(maxScroll > 1);
      setFraction(total > 0 ? Math.min(1, window.innerHeight / total) : 1);
      setProgress(maxScroll > 0 ? Math.min(1, Math.max(0, window.scrollY / maxScroll)) : 0);
    });
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const observer = new ResizeObserver(measure);
    observer.observe(document.documentElement);
    observer.observe(document.body);
    return () => {
      cancelAnimationFrame(frameRef.current);
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, [measure]);

  const scrollToHandleTop = (top: number, maxHandle: number, maxScroll: number) => {
    const fraction = maxHandle > 0 ? Math.min(1, Math.max(0, top / maxHandle)) : 0;
    window.scrollTo({ top: fraction * maxScroll });
  };

  const onHandlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (!track || event.button !== 0) return;
    // Keep the drag on the handle; don't let the track's click-to-jump also fire.
    event.stopPropagation();
    event.preventDefault();
    const maxHandle = track.clientHeight - event.currentTarget.offsetHeight;
    dragRef.current = {
      startY: event.clientY,
      startTop: progress * maxHandle,
      maxHandle,
      maxScroll: document.documentElement.scrollHeight - window.innerHeight
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setActive(true);
  };

  const onHandlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    scrollToHandleTop(drag.startTop + (event.clientY - drag.startY), drag.maxHandle, drag.maxScroll);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setActive(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (!track || event.button !== 0) return;
    const rect = track.getBoundingClientRect();
    const handleSize = handleRef.current?.offsetHeight ?? MIN_HANDLE;
    scrollToHandleTop(
      event.clientY - rect.top - handleSize / 2,
      track.clientHeight - handleSize,
      document.documentElement.scrollHeight - window.innerHeight
    );
  };

  const onHandleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    const page = window.innerHeight * 0.9;
    let target: number;
    switch (event.key) {
      case "ArrowUp": target = window.scrollY - 40; break;
      case "ArrowDown": target = window.scrollY + 40; break;
      case "PageUp": target = window.scrollY - page; break;
      case "PageDown": target = window.scrollY + page; break;
      case "Home": target = 0; break;
      case "End": target = maxScroll; break;
      default: return;
    }
    event.preventDefault();
    window.scrollTo({ top: Math.min(maxScroll, Math.max(0, target)) });
  };

  if (!scrollable) return null;

  return createPortal(
    <div
      className={`workspace-scrollbar ${className ?? ""} ${active ? "is-active" : ""}`}
      ref={trackRef}
      onPointerDown={onTrackPointerDown}
    >
      <div
        ref={handleRef}
        className="workspace-scrollbar__handle"
        style={{
          // Proportional handle: its share of the track mirrors the viewport's share of the page.
          top: `calc(${progress} * (100% - max(${MIN_HANDLE}px, ${(fraction * 100).toFixed(3)}%)))`,
          height: `max(${MIN_HANDLE}px, ${(fraction * 100).toFixed(3)}%)`
        }}
        role="scrollbar"
        aria-orientation="vertical"
        aria-label="Scroll document"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        tabIndex={0}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onHandleKeyDown}
      />
    </div>,
    document.body
  );
}
