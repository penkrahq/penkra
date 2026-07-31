import { useCallback, useEffect, useRef } from "react";

const WHEEL_AXIS_LOCK_PX = 6;
const WHEEL_AXIS_DOMINANCE_RATIO = 1.15;
// Dead time between the last wheel event and the settle starting: with no
// finger-lift signal on Chromium 144, ending a gesture means waiting out a
// silence. Every millisecond here is a frozen viewport after the release, so
// this is as short as it can be without cutting a slow drag in half.
const WHEEL_GESTURE_IDLE_MS = 45;
// A deliberate flick commits a page even when it barely moved the viewport.
// Resting position alone — what `Math.round` gives — is why a short fast swipe
// used to fall back to the page it started on.
const WHEEL_FLICK_VELOCITY_PX_PER_MS = 0.45;
// How far a slow, deliberate drag has to travel before it commits. Half a page
// is 120px of finger travel, which is far too much to ask of a swipe that never
// intended to be a flick; a third of a page matches how a paged scroller feels.
const WHEEL_COMMIT_DISTANCE_RATIO = 0.35;
// Chromium's own `behavior: "smooth"` needs well over 500ms to cross one 240px
// page, which is the bulk of the "slow to complete" feel. Measured on 144.
const PAGE_SETTLE_MS = 240;

interface UseSpacePagerInput {
  activePageIndex: number;
  onActivePageIndexChange: (pageIndex: number) => void;
}

interface WheelGesture {
  axis: "pending" | "horizontal" | "vertical";
  lastEventTime: number;
  // Peak rather than final velocity: by the time the gesture goes idle the
  // momentum tail has already decayed to nothing, and Chromium 144 has no way
  // to tell us where the fingers actually lifted. The largest sample of the
  // gesture is the closest stand-in for lift-off speed.
  peakVelocityX: number;
  startPageIndex: number;
  totalX: number;
  totalY: number;
}

// `SnapEvent` is not in TypeScript's DOM lib as of 5.9. Only the inline-axis
// target matters here — the viewport scrolls on one axis.
interface SnapEventLike extends Event {
  snapTargetInline: Element | null;
}

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function normalizeWheelDelta(event: WheelEvent, pageWidth: number) {
  const scale =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? pageWidth
        : 1;
  return {
    x: event.deltaX * scale,
    y: event.deltaY * scale,
  };
}

function easeOutCubic(progress: number) {
  return 1 - (1 - progress) ** 3;
}

/**
 * Spaces page on a native scroll-snap container, so the gesture is handled by
 * the platform. Chromium can latch a gesture that begins over the nested
 * vertical projects scroller to that child, so horizontally locked wheel
 * gestures are bridged to this viewport. Native scrolling still owns the snap
 * settlement; the hook keeps `activePageIndex` in sync with the result.
 */
export function useSpacePager({ activePageIndex, onActivePageIndexChange }: UseSpacePagerInput) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const activePageIndexRef = useRef(activePageIndex);
  activePageIndexRef.current = activePageIndex;
  // Set while the viewport is being driven by hand — during a horizontal wheel
  // gesture and during the settle that follows it. The sync effect below must
  // not issue a competing scroll during that window.
  const scrollerDrivingRef = useRef(false);
  const settleFrameRef = useRef<number | null>(null);

  const resolvePageIndex = useCallback((viewport: HTMLDivElement) => {
    const pageWidth = viewport.clientWidth;
    if (pageWidth <= 0) return null;
    return Math.round(viewport.scrollLeft / pageWidth);
  }, []);

  const cancelSettle = useCallback(() => {
    if (settleFrameRef.current === null) return;
    cancelAnimationFrame(settleFrameRef.current);
    settleFrameRef.current = null;
  }, []);

  /**
   * Animates `scrollLeft` to a snap position with snapping suspended.
   *
   * Snapping has to stay off for the whole animation. Restoring
   * `scroll-snap-type: x mandatory` re-snaps the scroller *synchronously and
   * without animation*, so putting it back before the scroll lands teleports
   * the viewport to the nearest page instead of gliding to it.
   */
  const settleTo = useCallback(
    (viewport: HTMLDivElement, targetScrollLeft: number) => {
      cancelSettle();
      scrollerDrivingRef.current = true;
      viewport.style.scrollSnapType = "none";

      const finish = () => {
        settleFrameRef.current = null;
        viewport.scrollLeft = targetScrollLeft;
        // Back to the class-driven value; we are exactly on a snap position by
        // now, so the re-snap this triggers is a no-op.
        viewport.style.scrollSnapType = "";
        scrollerDrivingRef.current = false;
      };

      const from = viewport.scrollLeft;
      const distance = targetScrollLeft - from;
      if (Math.abs(distance) < 1 || prefersReducedMotion()) {
        finish();
        return;
      }

      const startTime = performance.now();
      const step = (now: number) => {
        const progress = Math.min(1, (now - startTime) / PAGE_SETTLE_MS);
        viewport.scrollLeft = from + distance * easeOutCubic(progress);
        if (progress < 1) {
          settleFrameRef.current = requestAnimationFrame(step);
          return;
        }
        finish();
      };
      settleFrameRef.current = requestAnimationFrame(step);
    },
    [cancelSettle],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let wheelGesture: WheelGesture | null = null;
    let wheelGestureTimer: number | null = null;

    const commitPageIndex = (pageIndex: number | null) => {
      if (pageIndex === null || pageIndex === activePageIndexRef.current) return;
      activePageIndexRef.current = pageIndex;
      onActivePageIndexChange(pageIndex);
    };

    const clearWheelGestureTimer = () => {
      if (wheelGestureTimer === null) return;
      window.clearTimeout(wheelGestureTimer);
      wheelGestureTimer = null;
    };

    /**
     * Where the gesture should come to rest. A gesture can only ever move one
     * page, so this is a yes/no on the page it was heading towards: commit if
     * the drag travelled far enough, or if it was thrown hard enough.
     */
    const resolveGestureTargetIndex = (gesture: WheelGesture) => {
      const pageWidth = viewport.clientWidth;
      const lastPageIndex = Math.max(0, viewport.children.length - 1);
      const progress = (viewport.scrollLeft - gesture.startPageIndex * pageWidth) / pageWidth;
      const dragged = Math.abs(progress) >= WHEEL_COMMIT_DISTANCE_RATIO;
      const flicked = Math.abs(gesture.peakVelocityX) >= WHEEL_FLICK_VELOCITY_PX_PER_MS;
      if (!dragged && !flicked) return gesture.startPageIndex;
      const direction = dragged ? Math.sign(progress) : Math.sign(gesture.peakVelocityX);
      return Math.min(lastPageIndex, Math.max(0, gesture.startPageIndex + direction));
    };

    const finishHorizontalWheelGesture = () => {
      const gesture = wheelGesture;
      wheelGesture = null;
      wheelGestureTimer = null;
      if (!gesture || viewport.clientWidth <= 0) {
        scrollerDrivingRef.current = false;
        viewport.style.scrollSnapType = "";
        return;
      }

      const targetIndex = resolveGestureTargetIndex(gesture);
      // Commit before animating: the destination is known now, and waiting for
      // the scroll to land is what left the incoming page `inert` mid-slide.
      commitPageIndex(targetIndex);
      settleTo(viewport, targetIndex * viewport.clientWidth);
    };

    const finishNonHorizontalWheelGesture = () => {
      wheelGesture = null;
      wheelGestureTimer = null;
    };

    const scheduleWheelGestureEnd = () => {
      clearWheelGestureTimer();
      wheelGestureTimer = window.setTimeout(
        wheelGesture?.axis === "horizontal"
          ? finishHorizontalWheelGesture
          : finishNonHorizontalWheelGesture,
        WHEEL_GESTURE_IDLE_MS,
      );
    };

    const onWheel = (event: WheelEvent) => {
      const pageWidth = viewport.clientWidth;
      if (pageWidth <= 0) return;

      const delta = normalizeWheelDelta(event, pageWidth);
      if (delta.x === 0 && delta.y === 0) {
        // Where Chromium marks the end of a gesture with an empty wheel event,
        // that is a real finger-lift signal and there is no reason to sit
        // through the idle timer. Harmless where it never arrives.
        if (wheelGesture?.axis === "horizontal") {
          clearWheelGestureTimer();
          finishHorizontalWheelGesture();
        }
        return;
      }

      wheelGesture ??= {
        axis: "pending",
        lastEventTime: event.timeStamp,
        peakVelocityX: 0,
        startPageIndex: Math.round(viewport.scrollLeft / pageWidth),
        totalX: 0,
        totalY: 0,
      };
      wheelGesture.totalX += delta.x;
      wheelGesture.totalY += delta.y;

      const elapsed = event.timeStamp - wheelGesture.lastEventTime;
      if (elapsed > 0) {
        const velocityX = delta.x / elapsed;
        if (Math.abs(velocityX) > Math.abs(wheelGesture.peakVelocityX)) {
          wheelGesture.peakVelocityX = velocityX;
        }
      }
      wheelGesture.lastEventTime = event.timeStamp;

      if (wheelGesture.axis === "pending") {
        const horizontalDistance = Math.abs(wheelGesture.totalX);
        const verticalDistance = Math.abs(wheelGesture.totalY);
        if (
          horizontalDistance >= WHEEL_AXIS_LOCK_PX &&
          horizontalDistance > verticalDistance * WHEEL_AXIS_DOMINANCE_RATIO
        ) {
          wheelGesture.axis = "horizontal";
          // A settle from a previous gesture is stale the moment a new one
          // starts; the fingers win.
          cancelSettle();
          scrollerDrivingRef.current = true;
          wheelGesture.startPageIndex = Math.round(viewport.scrollLeft / pageWidth);
          viewport.style.scrollSnapType = "none";
        } else if (
          verticalDistance >= WHEEL_AXIS_LOCK_PX &&
          verticalDistance > horizontalDistance * WHEEL_AXIS_DOMINANCE_RATIO
        ) {
          wheelGesture.axis = "vertical";
        }
      }

      scheduleWheelGestureEnd();
      if (wheelGesture.axis !== "horizontal") return;

      event.preventDefault();
      // One gesture, one page — including through the momentum tail. Without
      // this a hard flick coasts across several Spaces and the distance covered
      // depends entirely on how hard it was thrown; clamping is what makes a
      // hard flick feel resistant and land in the same place every time.
      const lastPageIndex = Math.max(0, viewport.children.length - 1);
      const lowerBound = Math.max(0, wheelGesture.startPageIndex - 1) * pageWidth;
      const upperBound = Math.min(lastPageIndex, wheelGesture.startPageIndex + 1) * pageWidth;
      viewport.scrollLeft = Math.min(
        upperBound,
        Math.max(lowerBound, viewport.scrollLeft + delta.x),
      );

      // Landing exactly on a page boundary means the clamp above absorbed the
      // rest of the throw. The momentum tail can still run for another half
      // second, and waiting it out to announce a page we have visibly already
      // arrived at is the difference between a flick feeling instant and
      // feeling stuck.
      const reachedIndex = Math.round(viewport.scrollLeft / pageWidth);
      if (
        reachedIndex !== wheelGesture.startPageIndex &&
        Math.abs(viewport.scrollLeft - reachedIndex * pageWidth) < 1
      ) {
        commitPageIndex(reachedIndex);
      }
    };

    // `scrollsnapchanging` fires as soon as the scroller commits to a target,
    // which is roughly half a second before the scroll settles (measured on
    // Chromium: 13ms vs 529ms for a two-page scroll). `scrollsnapchange` is
    // too late to drive the UI — by then the user has already arrived. This
    // covers the paths we do not drive by hand, such as touch and keyboard.
    // `scrollLeft` is still on the old page this early, so the destination has
    // to come from the event's snap target rather than the scroll position.
    const onSnapChanging = (event: Event) => {
      if (scrollerDrivingRef.current) return;
      const snapTarget = (event as SnapEventLike).snapTargetInline;
      if (!snapTarget) return;
      const pageIndex = Array.prototype.indexOf.call(viewport.children, snapTarget);
      if (pageIndex < 0) return;
      commitPageIndex(pageIndex);
    };

    // Correction pass: whatever the scroller actually landed on wins, in case
    // the gesture reversed after `scrollsnapchanging` announced a target.
    const onSnapChange = () => {
      if (scrollerDrivingRef.current) return;
      commitPageIndex(resolvePageIndex(viewport));
    };

    viewport.addEventListener("wheel", onWheel, { capture: true, passive: false });
    viewport.addEventListener("scrollsnapchanging", onSnapChanging);
    viewport.addEventListener("scrollsnapchange", onSnapChange);
    return () => {
      clearWheelGestureTimer();
      cancelSettle();
      viewport.style.scrollSnapType = "";
      scrollerDrivingRef.current = false;
      viewport.removeEventListener("wheel", onWheel, { capture: true });
      viewport.removeEventListener("scrollsnapchanging", onSnapChanging);
      viewport.removeEventListener("scrollsnapchange", onSnapChange);
    };
  }, [cancelSettle, onActivePageIndexChange, resolvePageIndex, settleTo]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (scrollerDrivingRef.current) return;
    const pageWidth = viewport.clientWidth;
    if (pageWidth <= 0) return;

    const target = activePageIndex * pageWidth;
    if (Math.abs(viewport.scrollLeft - target) < 1) return;
    settleTo(viewport, target);
  }, [activePageIndex, settleTo]);

  return { viewportRef };
}
