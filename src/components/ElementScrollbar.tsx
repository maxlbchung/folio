import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/** Smallest the proportional handle may get, so it stays grabbable on very long content. */
const MIN_HANDLE = 24;

/**
 * Vertical counterpart of RowScrollbar for container-scrolled elements (the
 * Inkjet transcript). The native bar is hidden on the scroller; this thin line
 * + handle drives `scrollTop` instead. It stays inside the zoomed app-shell,
 * so pointer distances (visual px) are converted into layout px via the
 * track's rect/clientHeight ratio. Position the track with the extra class.
 */
export function ElementScrollbar({ scrollerRef, watch, label, className }: {
  scrollerRef: RefObject<HTMLElement | null>;
  /** Any value that changes when the content does, to trigger a re-measure. */
  watch?: unknown;
  label: string;
  className?: string;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startY: number; startTop: number; maxHandle: number; maxScroll: number; zoom: number } | null>(null);
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
      const maxScroll = el.scrollHeight - el.clientHeight;
      setScrollable(maxScroll > 1);
      setFraction(el.scrollHeight > 0 ? Math.min(1, el.clientHeight / el.scrollHeight) : 1);
      setProgress(maxScroll > 0 ? Math.min(1, Math.max(0, el.scrollTop / maxScroll)) : 0);
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
    return track.clientHeight > 0 ? rect.height / track.clientHeight : 1;
  };

  const scrollToHandleTop = (top: number, maxHandle: number, maxScroll: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    const fraction = maxHandle > 0 ? Math.min(1, Math.max(0, top / maxHandle)) : 0;
    el.scrollTop = fraction * maxScroll;
  };

  const onHandlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    const el = scrollerRef.current;
    if (!track || !el || event.button !== 0) return;
    // Keep the drag on the handle; don't let the track's click-to-jump also fire.
    event.stopPropagation();
    event.preventDefault();
    const maxHandle = track.clientHeight - event.currentTarget.offsetHeight;
    dragRef.current = {
      startY: event.clientY,
      startTop: progress * maxHandle,
      maxHandle,
      maxScroll: el.scrollHeight - el.clientHeight,
      zoom: trackZoom(track)
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setActive(true);
  };

  const onHandlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    scrollToHandleTop(drag.startTop + (event.clientY - drag.startY) / drag.zoom, drag.maxHandle, drag.maxScroll);
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
    const handleSize = handleRef.current?.offsetHeight ?? MIN_HANDLE;
    scrollToHandleTop(
      (event.clientY - rect.top) / trackZoom(track) - handleSize / 2,
      track.clientHeight - handleSize,
      el.scrollHeight - el.clientHeight
    );
  };

  const onHandleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const el = scrollerRef.current;
    if (!el) return;
    const maxScroll = el.scrollHeight - el.clientHeight;
    const page = el.clientHeight * 0.9;
    let target: number;
    switch (event.key) {
      case "ArrowUp": target = el.scrollTop - 40; break;
      case "ArrowDown": target = el.scrollTop + 40; break;
      case "PageUp": target = el.scrollTop - page; break;
      case "PageDown": target = el.scrollTop + page; break;
      case "Home": target = 0; break;
      case "End": target = maxScroll; break;
      default: return;
    }
    event.preventDefault();
    el.scrollTop = Math.min(maxScroll, Math.max(0, target));
  };

  if (!scrollable) return null;

  return (
    <div
      className={`element-scrollbar ${className ?? ""} ${active ? "is-active" : ""}`}
      ref={trackRef}
      onPointerDown={onTrackPointerDown}
    >
      <div
        ref={handleRef}
        className="element-scrollbar__handle"
        style={{
          // Proportional handle: its share of the track mirrors the visible share of the content.
          top: `calc(${progress} * (100% - max(${MIN_HANDLE}px, ${(fraction * 100).toFixed(3)}%)))`,
          height: `max(${MIN_HANDLE}px, ${(fraction * 100).toFixed(3)}%)`
        }}
        role="scrollbar"
        aria-orientation="vertical"
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
