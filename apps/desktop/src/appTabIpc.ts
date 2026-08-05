// FILE: appTabIpc.ts
// Purpose: Validates trusted-shell requests for isolated App-tab lifecycle operations.
// Layer: Desktop IPC boundary

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Invalid App tab request.");
  }
  return input as Record<string, unknown>;
}

function string(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Invalid App tab request.");
  }
  return value;
}

export function parseOpenAppTabRequest(input: unknown): {
  appId: string;
  spaceId: string;
  threadId: string;
  route: string;
  state?: unknown;
} {
  const value = record(input);
  return {
    appId: string(value, "appId"),
    spaceId: string(value, "spaceId"),
    threadId: string(value, "threadId"),
    route: string(value, "route"),
    ...(value.state === undefined ? {} : { state: value.state }),
  };
}

export function parseOpenAppFromAppsRequest(input: unknown): { appId: string } {
  return { appId: string(record(input), "appId") };
}

export function parseAppTabIdRequest(input: unknown): { tabId: string } {
  return { tabId: string(record(input), "tabId") };
}

export function parseNavigateAppTabRequest(input: unknown): {
  tabId: string;
  route: string;
  state?: unknown;
} {
  const value = record(input);
  return {
    tabId: string(value, "tabId"),
    route: string(value, "route"),
    ...(value.state === undefined ? {} : { state: value.state }),
  };
}

export function parseSetAppTabVisibleRequest(input: unknown): {
  tabId: string;
  visible: boolean;
} {
  const value = record(input);
  if (typeof value.visible !== "boolean") throw new Error("Invalid App tab visibility request.");
  return { tabId: string(value, "tabId"), visible: value.visible };
}

export function parseSetAppTabBoundsRequest(input: unknown): {
  tabId: string;
  bounds: { x: number; y: number; width: number; height: number };
} {
  const value = record(input);
  const bounds = record(value.bounds);
  for (const key of ["x", "y", "width", "height"] as const) {
    if (typeof bounds[key] !== "number" || !Number.isFinite(bounds[key])) {
      throw new Error("Invalid App tab bounds request.");
    }
  }
  return {
    tabId: string(value, "tabId"),
    bounds: {
      x: bounds.x as number,
      y: bounds.y as number,
      width: bounds.width as number,
      height: bounds.height as number,
    },
  };
}

/**
 * DOM rectangles are expressed in the shell renderer's CSS pixels. Electron
 * View bounds are expressed in the BrowserWindow content view's native DIPs.
 * Page zoom changes the relationship between those coordinate spaces without
 * changing the window, so the trusted desktop boundary must scale the complete
 * rectangle before positioning a host-owned App view.
 */
export function appTabCssBoundsToNativeBounds(
  bounds: { x: number; y: number; width: number; height: number },
  zoomFactor: number,
): { x: number; y: number; width: number; height: number } {
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) {
    throw new Error("Invalid App tab zoom factor.");
  }
  return {
    x: bounds.x * zoomFactor,
    y: bounds.y * zoomFactor,
    width: bounds.width * zoomFactor,
    height: bounds.height * zoomFactor,
  };
}
