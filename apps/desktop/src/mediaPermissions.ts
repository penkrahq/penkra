// FILE: mediaPermissions.ts
// Purpose: Centralizes desktop media-permission policy and macOS microphone authorization.
// Layer: Desktop permission helper
// Exports: request validation and deterministic authorization helpers.

export interface MediaPermissionRequester {
  isDestroyed(): boolean;
  getURL?(): string;
}

export type MicrophoneAccessStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

// Electron marks its media fields as optional. Missing fields are acceptable only
// after the caller has proved that this is Penkra's own live main renderer.
export function shouldAllowMediaPermissionRequest(details: unknown): boolean {
  if (typeof details !== "object" || details === null) return true;
  const record = details as Record<string, unknown>;
  if (Array.isArray(record.mediaTypes) && record.mediaTypes.length > 0) {
    return record.mediaTypes.every((mediaType) => mediaType === "audio");
  }
  if (typeof record.mediaType === "string") {
    return record.mediaType === "audio";
  }
  return true;
}

function comparableOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

function hasTrustedMainFrameOrigin(
  requester: MediaPermissionRequester,
  details: unknown,
  requestingOrigin?: string,
): boolean {
  if (typeof details !== "object" || details === null) return true;
  const record = details as Record<string, unknown>;
  if (record.isMainFrame === false || typeof record.embeddingOrigin === "string") return false;

  const rendererOrigin = requester.getURL ? comparableOrigin(requester.getURL()) : null;
  if (!rendererOrigin) return true;
  const reportedOrigins = [requestingOrigin, record.requestingUrl, record.securityOrigin]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(comparableOrigin);
  return reportedOrigins.every((origin) => origin === rendererOrigin);
}

export function isTrustedMediaPermissionRequest(
  requester: MediaPermissionRequester | null,
  trustedRequester: MediaPermissionRequester | null,
  details: unknown,
  requestingOrigin?: string,
): boolean {
  if (!requester || requester !== trustedRequester || requester.isDestroyed()) return false;
  return (
    shouldAllowMediaPermissionRequest(details) &&
    hasTrustedMainFrameOrigin(requester, details, requestingOrigin)
  );
}

export async function resolveMicrophonePermissionRequest(input: {
  readonly status: MicrophoneAccessStatus;
  readonly askForAccess: () => Promise<boolean>;
}): Promise<boolean> {
  if (input.status === "granted") return true;
  if (input.status !== "not-determined") return false;
  try {
    return await input.askForAccess();
  } catch {
    return false;
  }
}
