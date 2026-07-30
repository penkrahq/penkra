export const SPACE_PAGER_ACTIVATION_PX = 8;
export const SPACE_PAGER_RAMP_PX = 34;
export const SPACE_PAGER_COMMIT_RATIO = 0.3;
export const SPACE_PAGER_PROJECTED_COMMIT_RATIO = 0.38;
export const SPACE_PAGER_PROJECTION_MS = 140;
export const SPACE_PAGER_SETTLE_TRANSITION = {
  bounce: 0,
  type: "spring",
  visualDuration: 0.3,
} as const;

const INITIAL_GAIN = 0.22;
const MIN_FLING_VELOCITY_PX_PER_MS = 0.24;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function smoothstep(value: number) {
  const progress = clamp(value, 0, 1);
  return progress * progress * (3 - 2 * progress);
}

/**
 * Keeps the first part of a horizontal gesture deliberate, then smoothly
 * approaches direct 1:1 tracking. The returned distance is always smaller
 * than the input distance and has no discontinuity at the activation point.
 */
export function applySpacePagerEngagement(distance: number) {
  const direction = Math.sign(distance);
  const activatedDistance = Math.max(0, Math.abs(distance) - SPACE_PAGER_ACTIVATION_PX);
  if (activatedDistance === 0) return 0;

  const rampProgress = activatedDistance / SPACE_PAGER_RAMP_PX;
  const gain = INITIAL_GAIN + (1 - INITIAL_GAIN) * smoothstep(rampProgress);
  return direction * activatedDistance * gain;
}

export interface SpacePagerDestinationInput {
  activePageIndex: number;
  dragDistance: number;
  pageCount: number;
  pageWidth: number;
  velocity: number;
}

/**
 * Resolves at most one page for each gesture. A deliberate drag can commit by
 * distance; a shorter flick can commit from its projected velocity.
 */
export function resolveSpacePagerDestination({
  activePageIndex,
  dragDistance,
  pageCount,
  pageWidth,
  velocity,
}: SpacePagerDestinationInput) {
  if (pageCount < 1 || pageWidth <= 0) return 0;

  const finalIndex = pageCount - 1;
  const projectedDistance = dragDistance + velocity * SPACE_PAGER_PROJECTION_MS;
  const distanceCommits = Math.abs(dragDistance) >= pageWidth * SPACE_PAGER_COMMIT_RATIO;
  const velocityCommits =
    Math.abs(velocity) >= MIN_FLING_VELOCITY_PX_PER_MS &&
    Math.abs(projectedDistance) >= pageWidth * SPACE_PAGER_PROJECTED_COMMIT_RATIO;

  if (!distanceCommits && !velocityCommits) return clamp(activePageIndex, 0, finalIndex);

  const direction = Math.sign(distanceCommits ? dragDistance : projectedDistance);
  return clamp(activePageIndex + direction, 0, finalIndex);
}

export function normalizeWheelDelta(event: WheelEvent, pageWidth: number) {
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
