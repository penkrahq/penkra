import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { Button } from "~/components/ui/button";
import { MinusIcon, PlusIcon } from "~/lib/icons";
import type { ExpandedImageItem } from "./ExpandedImagePreview";

type View = { scale: number; x: number; y: number };
type Point = { x: number; y: number };
const FIT: View = { scale: 1, x: 0, y: 0 };
// Operator preference: triple the original wheel/trackpad zoom sensitivity.
const WHEEL_ZOOM_SENSITIVITY = 3;

/** A fitted image with one transform owner for mouse, trackpad, touch and buttons. */
export function ImageViewport({
  image,
  onClose,
}: {
  image: ExpandedImageItem;
  onClose: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const suppressClick = useRef(false);
  const [view, setView] = useState<View>(FIT);

  const constrain = useCallback((next: View): View => {
    const viewport = viewportRef.current;
    const img = imageRef.current;
    if (!viewport || !img || !Number.isFinite(next.scale)) return FIT;
    const scale = Math.max(1, next.scale);
    const maxX = Math.max(0, (img.offsetWidth * scale - viewport.clientWidth) / 2);
    const maxY = Math.max(0, (img.offsetHeight * scale - viewport.clientHeight) / 2);
    return {
      scale,
      x: Math.max(-maxX, Math.min(maxX, next.x)),
      y: Math.max(-maxY, Math.min(maxY, next.y)),
    };
  }, []);

  const zoom = useCallback(
    (factor: number, anchor: Point = { x: 0, y: 0 }, pan: Point = { x: 0, y: 0 }) => {
      setView((previous) => {
        const scale = Math.max(1, previous.scale * factor);
        const ratio = scale / previous.scale;
        return constrain({
          scale,
          x: anchor.x - (anchor.x - previous.x) * ratio + pan.x,
          y: anchor.y - (anchor.y - previous.y) * ratio + pan.y,
        });
      });
    },
    [constrain],
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current!;
    const observer = new ResizeObserver(() => setView((previous) => constrain(previous)));
    observer.observe(viewport);
    observer.observe(imageRef.current!);
    // React's delegated wheel listener is passive; this viewer owns the gesture.
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? rect.height
          : event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? parseFloat(getComputedStyle(viewport).fontSize)
            : 1;
      // Sensitivity is in zoom space, so zoom-in and zoom-out stay symmetric.
      zoom(2 ** ((-event.deltaY * unit * WHEEL_ZOOM_SENSITIVITY) / rect.height), {
        x: event.clientX - rect.left - rect.width / 2,
        y: event.clientY - rect.top - rect.height / 2,
      });
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => {
      observer.disconnect();
      viewport.removeEventListener("wheel", wheel);
    };
  }, [constrain, zoom]);

  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // A new backdrop tap must still dismiss after a cancelled/lost gesture.
    if (pointers.current.size === 0) suppressClick.current = false;
    if (event.button !== 0 || (event.pointerType !== "touch" && event.target !== imageRef.current))
      return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    // Keep clicks targeted at the image after capture, never at the backdrop.
    (event.target === imageRef.current ? imageRef.current : event.currentTarget).setPointerCapture(
      event.pointerId,
    );
    event.preventDefault();
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const next = { x: event.clientX, y: event.clientY };
    if (next.x === previous.x && next.y === previous.y) return;
    suppressClick.current = true;
    const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1];
    pointers.current.set(event.pointerId, next);
    if (other) {
      const before = Math.hypot(previous.x - other.x, previous.y - other.y);
      const after = Math.hypot(next.x - other.x, next.y - other.y);
      const rect = event.currentTarget.getBoundingClientRect();
      zoom(
        before > 0 ? after / before : 1,
        {
          x: (previous.x + other.x) / 2 - rect.left - rect.width / 2,
          y: (previous.y + other.y) / 2 - rect.top - rect.height / 2,
        },
        { x: (next.x - previous.x) / 2, y: (next.y - previous.y) / 2 },
      );
    } else {
      setView((current) =>
        constrain({
          ...current,
          x: current.x + next.x - previous.x,
          y: current.y + next.y - previous.y,
        }),
      );
    }
  };
  const pointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <>
      <div
        className="absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-1 rounded-lg bg-black/75 p-1 text-white"
        role="group"
        aria-label="Image zoom"
      >
        <Button
          variant="ghost"
          size="icon"
          aria-label="Zoom out"
          disabled={view.scale === 1}
          onClick={() => zoom(1 / 2)}
        >
          <MinusIcon />
        </Button>
        <Button variant="ghost" size="sm" aria-label="Fit image" onClick={() => setView(FIT)}>
          Fit
        </Button>
        <Button variant="ghost" size="icon" aria-label="Zoom in" onClick={() => zoom(2)}>
          <PlusIcon />
        </Button>
      </div>
      <div
        ref={viewportRef}
        data-image-viewport
        className="relative grid min-h-0 w-full flex-1 touch-none place-items-center overflow-hidden"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerEnd}
        onPointerCancel={pointerEnd}
        onLostPointerCapture={pointerEnd}
        onClick={(event) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          if (event.target === event.currentTarget) onClose();
        }}
        onDoubleClick={(event) => {
          if (event.target === imageRef.current) {
            event.preventDefault();
            setView((current) => (current.scale === 1 ? { ...FIT, scale: 2 } : FIT));
          }
        }}
      >
        <img
          ref={imageRef}
          src={image.src}
          alt={image.name}
          draggable={false}
          onLoad={() => setView((current) => constrain(current))}
          className="block min-h-0 min-w-0 max-h-full max-w-full select-none rounded-lg border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] object-contain shadow-2xl"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            cursor: view.scale > 1 ? "grab" : "zoom-in",
          }}
        />
      </div>
    </>
  );
}
