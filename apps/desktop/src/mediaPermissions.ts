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
  trustedRequester: MediaPermissionRequester,
  details: unknown,
  requestingOrigin?: string,
  requireExplicitEvidence = false,
): boolean {
  if (typeof details !== "object" || details === null) return true;
  const record = details as Record<string, unknown>;
  // Electron 40 reports embeddingOrigin for Penkra's packaged custom-scheme
  // main document even though its API documentation describes that field as a
  // cross-origin subframe signal. isMainFrame is the authoritative frame check;
  // every reported URL is still required to match the live renderer below.
  if (record.isMainFrame === false) return false;

  const rendererOrigin = trustedRequester.getURL
    ? comparableOrigin(trustedRequester.getURL())
    : null;
  if (!rendererOrigin) return !requireExplicitEvidence;
  const reportedOrigins = [
    requestingOrigin,
    record.requestingUrl,
    record.securityOrigin,
    record.embeddingOrigin,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(comparableOrigin);
  return (
    (!requireExplicitEvidence || reportedOrigins.length > 0) &&
    reportedOrigins.every((origin) => origin === rendererOrigin)
  );
}

function explicitlyReportsAudioOnly(details: unknown): boolean {
  if (typeof details !== "object" || details === null) return false;
  const record = details as Record<string, unknown>;
  if (Array.isArray(record.mediaTypes) && record.mediaTypes.length > 0) {
    return record.mediaTypes.every((mediaType) => mediaType === "audio");
  }
  return record.mediaType === "audio";
}

// Electron documents that permission checks may omit WebContents. In that
// case, accept only a fully evidenced audio-only main-frame check whose
// reported origin matches Penkra's live renderer. Permission requests retain
// the stricter object-identity requirement below.
export function isTrustedMediaPermissionCheck(
  requester: MediaPermissionRequester | null,
  trustedRequester: MediaPermissionRequester | null,
  details: unknown,
  requestingOrigin?: string,
): boolean {
  if (!trustedRequester || trustedRequester.isDestroyed()) return false;
  if (requester) {
    return isTrustedMediaPermissionRequest(requester, trustedRequester, details, requestingOrigin);
  }
  if (typeof details !== "object" || details === null) return false;
  const record = details as Record<string, unknown>;
  return (
    record.isMainFrame === true &&
    explicitlyReportsAudioOnly(details) &&
    hasTrustedMainFrameOrigin(trustedRequester, details, requestingOrigin, true)
  );
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
    hasTrustedMainFrameOrigin(trustedRequester, details, requestingOrigin)
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
