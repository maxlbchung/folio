import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/** Smallest the proportional handle may get, so it stays grabbable on very long rows. */
const MIN_HANDLE = 24;

/**
 * Horizontal counterpart of WorkspaceScrollbar for container-scrolled rows (the pinned shelf).
 * The native bar is hidden on the scroller; this thin line + handle drives `scrollLeft` instead.
 * Unlike the window-level scrollbar it stays inside the zoomed app-shell, so pointer distances
 * (visual px) are converted into layout px via the track's rect/clientWidth ratio.
 */
export function RowScrollbar({ scrollerRef, watch, label }: {
  scrollerRef: RefObject<HTMLElement | null>;
  /** Any value that changes when the row's content does, to trigger a re-measure. */
  watch?: unknown;
  label: string;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startLeft: number; maxHandle: number; maxScroll: number; zoom: number } | null>(null);
  const frameRef = useRef(0);
  const [progress, setProgress] = useState(0);
  const [fraction, setFraction] = useState(1);
  const [scrollable, setScrollable] = useState(false);
  const [active, setActive] = useState(false);

  const measure = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      const el = scrollerRef.current;
      if (!el) return;
      const maxScroll = el.scrollWidth - el.clientWidth;
      setScrollable(maxScroll > 1);
      setFraction(el.scrollWidth > 0 ? Math.min(1, el.clientWidth / el.scrollWidth) : 1);
      setProgress(maxScroll > 0 ? Math.min(1, Math.max(0, el.scrollLeft / maxScroll)) : 0);
    });
  }, [scrollerRef]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frameRef.current);
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [measure, scrollerRef]);

  useEffect(() => { measure(); }, [watch, measure]);

  /** Visual px per layout px inside the zoomed shell (1 when UI scale is 100%). */
  const trackZoom = (track: HTMLDivElement): number => {
    const rect = track.getBoundingClientRect();
    return track.clientWidth > 0 ? rect.width / track.clientWidth : 1;
  };

  const scrollToHandleLeft = (left: number, maxHandle: number, maxScroll: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    const fraction = maxHandle > 0 ? Math.min(1, Math.max(0, left / maxHandle)) : 0;
    el.scrollLeft = fraction * maxScroll;
  };

  const onHandlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    const el = scrollerRef.current;
    if (!track || !el || event.button !== 0) return;
    // Keep the drag on the handle; don't let the track's click-to-jump also fire.
    event.stopPropagation();
    event.preventDefault();
    const maxHandle = track.clientWidth - event.currentTarget.offsetWidth;
    dragRef.current = {
      startX: event.clientX,
      startLeft: progress * maxHandle,
      maxHandle,
      maxScroll: el.scrollWidth - el.clientWidth,
      zoom: trackZoom(track)
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setActive(true);
  };

  const onHandlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    scrollToHandleLeft(drag.startLeft + (event.clientX - drag.startX) / drag.zoom, drag.maxHandle, drag.maxScroll);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setActive(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    const el = scrollerRef.current;
    if (!track || !el || event.button !== 0) return;
    const rect = track.getBoundingClientRect();
    const handleSize = handleRef.current?.offsetWidth ?? MIN_HANDLE;
    scrollToHandleLeft(
      (event.clientX - rect.left) / trackZoom(track) - handleSize / 2,
      track.clientWidth - handleSize,
      el.scrollWidth - el.clientWidth
    );
  };

  const onHandleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const el = scrollerRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    const page = el.clientWidth * 0.9;
    let target: number;
    switch (event.key) {
      case "ArrowLeft": target = el.scrollLeft - 40; break;
      case "ArrowRight": target = el.scrollLeft + 40; break;
      case "PageUp": target = el.scrollLeft - page; break;
      case "PageDown": target = el.scrollLeft + page; break;
      case "Home": target = 0; break;
      case "End": target = maxScroll; break;
      default: return;
    }
    event.preventDefault();
    el.scrollLeft = Math.min(maxScroll, Math.max(0, target));
  };

  if (!scrollable) return null;

  return (
    <div
      className={`row-scrollbar ${active ? "is-active" : ""}`}
      ref={trackRef}
      onPointerDown={onTrackPointerDown}
    >
      <div
        ref={handleRef}
        className="row-scrollbar__handle"
        style={{
          // Proportional handle: its share of the track mirrors the visible share of the row.
          left: `calc(${progress} * (100% - max(${MIN_HANDLE}px, ${(fraction * 100).toFixed(3)}%)))`,
          width: `max(${MIN_HANDLE}px, ${(fraction * 100).toFixed(3)}%)`
        }}
        role="scrollbar"
        aria-orientation="horizontal"
        aria-label={label}
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
    </div>
  );
}
