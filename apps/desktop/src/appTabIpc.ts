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
  tabId?: string;
  appId: string;
  spaceId: string;
  threadId: string;
  route: string;
  state?: unknown;
} {
  const value = record(input);
  return {
    ...(value.tabId === undefined ? {} : { tabId: string(value, "tabId") }),
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

function finiteNumber(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Invalid App tab request.");
  }
  return value;
}

export function parseAppTabRendererRequest(input: unknown): {
  tabId: string;
  rendererId: number;
} {
  const value = record(input);
  return { tabId: string(value, "tabId"), rendererId: finiteNumber(value, "rendererId") };
}

export function parseAppTabIdRequest(input: unknown): { tabId: string } {
  return { tabId: string(record(input), "tabId") };
}

export function parseAppTabRouteRequest(input: unknown): {
  route: string;
  state?: unknown;
} {
  const value = record(input);
  return {
    route: string(value, "route"),
    ...(value.state === undefined ? {} : { state: value.state }),
  };
}

export function parseNavigateAppTabRequest(input: unknown): {
  tabId: string;
  route: string;
  state?: unknown;
} {
  const value = record(input);
  const navigation = parseAppTabRouteRequest(value);
  return {
    tabId: string(value, "tabId"),
    ...navigation,
  };
}

export function parseSetAppTabActiveRequest(input: unknown): {
  tabId: string;
  rendererId: number;
  active: boolean;
} {
  const value = record(input);
  if (typeof value.active !== "boolean") throw new Error("Invalid App tab active-state request.");
  return {
    tabId: string(value, "tabId"),
    rendererId: finiteNumber(value, "rendererId"),
    active: value.active,
  };
}
