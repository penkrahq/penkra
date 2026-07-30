import { animate, type AnimationPlaybackControls } from "motion";
import { useCallback, useEffect, useRef } from "react";

import {
  applySpacePagerEngagement,
  normalizeWheelDelta,
  resolveSpacePagerDestination,
  resolveSpacePagerSettleTransition,
} from "./spacePagerPhysics";

const AXIS_LOCK_PX = 6;
const AXIS_DOMINANCE_RATIO = 1.15;
const WHEEL_IDLE_MS = 48;
const MOMENTUM_GUARD_IDLE_MS = 110;

interface WheelGesture {
  deceleratingEvents: number;
  distance: number;
  lastDeltaMagnitude: number;
  lastEventAt: number;
  originPosition: number;
  startedAt: number;
  totalX: number;
  totalY: number;
  velocity: number;
}

interface UseSpacePagerInput {
  activePageIndex: number;
  onActivePageIndexChange: (pageIndex: number) => void;
  pageCount: number;
}

function createWheelGesture(timestamp: number): WheelGesture {
  return {
    deceleratingEvents: 0,
    distance: 0,
    lastDeltaMagnitude: 0,
    lastEventAt: timestamp,
    originPosition: 0,
    startedAt: timestamp,
    totalX: 0,
    totalY: 0,
    velocity: 0,
  };
}

export function useSpacePager({
  activePageIndex,
  onActivePageIndexChange,
  pageCount,
}: UseSpacePagerInput) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const settleAnimationRef = useRef<AnimationPlaybackControls | null>(null);
  const settlingPageIndexRef = useRef<number | null>(null);
  const wheelEndTimerRef = useRef<number | null>(null);
  const momentumGuardTimerRef = useRef<number | null>(null);
  const gestureRef = useRef<WheelGesture | null>(null);
  const horizontalIntentRef = useRef<"pending" | "locked" | "vertical">("pending");
  const momentumGuardRef = useRef<{ direction: number; magnitude: number } | null>(null);
  const trackPositionRef = useRef(0);
  const pageWidthRef = useRef(0);
  const activePageIndexRef = useRef(activePageIndex);
  activePageIndexRef.current = activePageIndex;

  const setTrackPosition = useCallback(
    (position: number) => {
      const width = pageWidthRef.current;
      const minimum = width > 0 ? -(pageCount - 1) * width : position;
      const boundedPosition = Math.min(0, Math.max(minimum, position));
      trackPositionRef.current = boundedPosition;
      if (trackRef.current) {
        trackRef.current.style.transform = `translate3d(${boundedPosition}px, 0, 0)`;
      }
      return boundedPosition;
    },
    [pageCount],
  );

  const cancelSettle = useCallback(() => {
    if (settleAnimationRef.current !== null) {
      settleAnimationRef.current.stop();
      settleAnimationRef.current = null;
    }
    settlingPageIndexRef.current = null;
  }, []);

  const settleTrack = useCallback(
    (target: number, pageIndex: number) => {
      cancelSettle();
      settlingPageIndexRef.current = pageIndex;
      if (
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        setTrackPosition(target);
        return;
      }

      const transition = resolveSpacePagerSettleTransition(
        trackPositionRef.current,
        target,
        pageWidthRef.current,
      );
      if (transition.visualDuration === 0) {
        setTrackPosition(target);
        return;
      }
      settleAnimationRef.current = animate(trackPositionRef.current, target, {
        ...transition,
        onComplete: () => {
          setTrackPosition(target);
          settleAnimationRef.current = null;
          settlingPageIndexRef.current = null;
        },
        onUpdate: setTrackPosition,
      });
    },
    [cancelSettle, setTrackPosition],
  );

  const clearWheelEndTimer = useCallback(() => {
    if (wheelEndTimerRef.current !== null) {
      window.clearTimeout(wheelEndTimerRef.current);
      wheelEndTimerRef.current = null;
    }
  }, []);

  const finishGesture = useCallback(
    (guardMomentum: boolean) => {
      const gesture = gestureRef.current;
      const width = pageWidthRef.current;
      if (!gesture || width <= 0) return;

      clearWheelEndTimer();
      gestureRef.current = null;
      horizontalIntentRef.current = "pending";

      const dragDistance = applySpacePagerEngagement(gesture.distance);
      const destination = resolveSpacePagerDestination({
        activePageIndex: activePageIndexRef.current,
        dragDistance,
        pageCount,
        pageWidth: width,
        velocity: gesture.velocity,
      });

      if (guardMomentum) {
        momentumGuardRef.current = {
          direction: Math.sign(gesture.distance),
          magnitude: gesture.lastDeltaMagnitude,
        };
      }
      if (destination !== activePageIndexRef.current) {
        activePageIndexRef.current = destination;
        onActivePageIndexChange(destination);
      }
      settleTrack(-destination * width, destination);
    },
    [clearWheelEndTimer, onActivePageIndexChange, pageCount, settleTrack],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const resetMomentumGuardTimer = () => {
      if (momentumGuardTimerRef.current !== null) {
        window.clearTimeout(momentumGuardTimerRef.current);
      }
      momentumGuardTimerRef.current = window.setTimeout(() => {
        momentumGuardRef.current = null;
        momentumGuardTimerRef.current = null;
      }, MOMENTUM_GUARD_IDLE_MS);
    };

    const onWheel = (event: WheelEvent) => {
      const width = pageWidthRef.current || viewport.clientWidth;
      if (width <= 0) return;

      const delta = normalizeWheelDelta(event, width);
      const horizontalMagnitude = Math.abs(delta.x);
      if (horizontalMagnitude === 0) return;

      const timestamp = performance.now();
      const momentumGuard = momentumGuardRef.current;
      if (momentumGuard) {
        const direction = Math.sign(delta.x);
        const isNewGesture =
          direction !== momentumGuard.direction ||
          horizontalMagnitude > Math.max(4, momentumGuard.magnitude * 1.4);
        if (!isNewGesture) {
          event.preventDefault();
          momentumGuard.magnitude = horizontalMagnitude;
          resetMomentumGuardTimer();
          return;
        }
        momentumGuardRef.current = null;
      }

      let gesture = gestureRef.current;
      if (!gesture) {
        gesture = createWheelGesture(timestamp);
        gestureRef.current = gesture;
        horizontalIntentRef.current = "pending";
      }

      gesture.totalX += delta.x;
      gesture.totalY += delta.y;

      if (horizontalIntentRef.current === "pending") {
        const totalHorizontal = Math.abs(gesture.totalX);
        const totalVertical = Math.abs(gesture.totalY);
        if (
          totalHorizontal >= AXIS_LOCK_PX &&
          totalHorizontal > totalVertical * AXIS_DOMINANCE_RATIO
        ) {
          horizontalIntentRef.current = "locked";
          gesture.distance = gesture.totalX;
          gesture.originPosition = trackPositionRef.current;
          cancelSettle();
        } else if (
          totalVertical >= AXIS_LOCK_PX &&
          totalVertical > totalHorizontal * AXIS_DOMINANCE_RATIO
        ) {
          horizontalIntentRef.current = "vertical";
          gestureRef.current = null;
          return;
        } else {
          return;
        }
      }
      if (horizontalIntentRef.current !== "locked") return;

      event.preventDefault();
      const elapsed = Math.max(1, timestamp - gesture.lastEventAt);
      const instantaneousVelocity = gesture.lastDeltaMagnitude === 0 ? 0 : delta.x / elapsed;
      gesture.velocity = gesture.velocity * 0.72 + instantaneousVelocity * 0.28;
      if (gesture.distance !== gesture.totalX) {
        gesture.distance += delta.x;
      }

      const previousMagnitude = gesture.lastDeltaMagnitude;
      const sameDirection = Math.sign(delta.x) === Math.sign(gesture.distance);
      if (
        sameDirection &&
        previousMagnitude > 2 &&
        horizontalMagnitude < previousMagnitude * 0.92
      ) {
        gesture.deceleratingEvents += 1;
      } else if (horizontalMagnitude >= previousMagnitude) {
        gesture.deceleratingEvents = 0;
      }
      gesture.lastDeltaMagnitude = horizontalMagnitude;
      gesture.lastEventAt = timestamp;

      const engagedDistance = applySpacePagerEngagement(gesture.distance);
      const firstPage = activePageIndexRef.current === 0;
      const lastPage = activePageIndexRef.current >= pageCount - 1;
      const isPastBoundary =
        (firstPage && engagedDistance < 0) || (lastPage && engagedDistance > 0);
      const displayedDistance = isPastBoundary ? 0 : engagedDistance;
      setTrackPosition(gesture.originPosition - displayedDistance);

      clearWheelEndTimer();
      wheelEndTimerRef.current = window.setTimeout(() => finishGesture(false), WHEEL_IDLE_MS);

      const momentumHasStarted =
        timestamp - gesture.startedAt > 55 &&
        gesture.deceleratingEvents >= 3 &&
        Math.abs(engagedDistance) > 16;
      if (momentumHasStarted) {
        finishGesture(true);
        resetMomentumGuardTimer();
      }
    };

    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [cancelSettle, clearWheelEndTimer, finishGesture, pageCount, setTrackPosition]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      pageWidthRef.current = viewport.clientWidth;
      cancelSettle();
      setTrackPosition(-activePageIndexRef.current * viewport.clientWidth);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [cancelSettle, setTrackPosition]);

  useEffect(() => {
    if (gestureRef.current) return;
    if (settlingPageIndexRef.current === activePageIndex) return;
    const width = pageWidthRef.current;
    if (width > 0) settleTrack(-activePageIndex * width, activePageIndex);
  }, [activePageIndex, settleTrack]);

  useEffect(
    () => () => {
      cancelSettle();
      clearWheelEndTimer();
      if (momentumGuardTimerRef.current !== null) {
        window.clearTimeout(momentumGuardTimerRef.current);
      }
    },
    [cancelSettle, clearWheelEndTimer],
  );

  return { trackRef, viewportRef };
}
