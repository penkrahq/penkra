// FILE: appHostedSurfaceLayout.ts
// Purpose: Validates stable edge constraints for host-owned surfaces inside App frames.
// Layer: Desktop App capability boundary

export interface AppHostedSurfaceInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export function parseAppHostedSurfaceInsets(value: unknown): AppHostedSurfaceInsets | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Browser surface layout must be insets or null.");
  }
  const record = value as Record<string, unknown>;
  const entries = [record.top, record.right, record.bottom, record.left];
  if (
    !entries.every(
      (candidate) => typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0,
    )
  ) {
    throw new Error("Browser surface insets must be finite non-negative numbers.");
  }
  return {
    top: record.top as number,
    right: record.right as number,
    bottom: record.bottom as number,
    left: record.left as number,
  };
}
