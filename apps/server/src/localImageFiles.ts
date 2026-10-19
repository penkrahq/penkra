// Resolves local preview files and manages explicit grants for folder-file reads.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  LOCAL_IMAGE_ROUTE_PATH,
  isSupportedLocalPreviewFilePath,
} from "@penkra/shared/localPreviewFiles";

export { LOCAL_IMAGE_ROUTE_PATH };

export interface ResolvedLocalPreviewFile {
  readonly path: string;
  readonly fileName: string;
  readonly sizeBytes: number;
}

export interface LocalPreviewGrantResult {
  readonly grant: string;
  readonly expiresAt: string;
}

const LOCAL_PREVIEW_GRANT_TTL_MS = 2 * 60 * 1000;
const localPreviewGrantByToken = new Map<string, { realFilePath: string; expiresAtMs: number }>();

function pruneExpiredPreviewGrants(nowMs = Date.now()): void {
  for (const [token, grant] of localPreviewGrantByToken) {
    if (grant.expiresAtMs <= nowMs) localPreviewGrantByToken.delete(token);
  }
}

export function resolveLocalPreviewGrantRealPath(input: {
  readonly token: string | null | undefined;
}): string | null {
  const token = input.token?.trim();
  if (!token) return null;
  const nowMs = Date.now();
  pruneExpiredPreviewGrants(nowMs);
  const grant = localPreviewGrantByToken.get(token);
  return grant !== undefined && grant.expiresAtMs > nowMs ? grant.realFilePath : null;
}

export async function resolveLocalPreviewFile(input: {
  readonly requestedPath: string | null;
  readonly cwd: string | null;
  /** Explicit show-file operations also accept non-preview file formats. */
  readonly allowAnyFile?: boolean;
}): Promise<ResolvedLocalPreviewFile | null> {
  const requestedPath = input.requestedPath?.trim();
  if (
    !requestedPath ||
    requestedPath.includes("\0") ||
    (!input.allowAnyFile && !isSupportedLocalPreviewFilePath(requestedPath))
  )
    return null;

  const realFilePath = await fs
    .realpath(path.resolve(input.cwd ?? process.cwd(), requestedPath))
    .catch(() => null);
  if (!realFilePath || (!input.allowAnyFile && !isSupportedLocalPreviewFilePath(realFilePath)))
    return null;

  const stat = await fs.stat(realFilePath).catch(() => null);
  if (!stat?.isFile()) return null;
  return { path: realFilePath, fileName: path.basename(realFilePath), sizeBytes: stat.size };
}

export async function createLocalPreviewGrant(input: {
  readonly requestedPath: string;
}): Promise<LocalPreviewGrantResult> {
  const requestedPath = input.requestedPath.trim();
  if (!requestedPath || requestedPath.includes("\0") || !path.isAbsolute(requestedPath)) {
    throw new Error("Only absolute local files can be granted.");
  }
  const realFilePath = await fs.realpath(path.resolve(requestedPath)).catch(() => null);
  if (!realFilePath) throw new Error("Preview file not found.");
  const stat = await fs.stat(realFilePath).catch(() => null);
  if (!stat?.isFile()) throw new Error("Preview path is not a file.");

  const expiresAtMs = Date.now() + LOCAL_PREVIEW_GRANT_TTL_MS;
  const grant = crypto.randomUUID();
  localPreviewGrantByToken.set(grant, { realFilePath, expiresAtMs });
  pruneExpiredPreviewGrants();
  return { grant, expiresAt: new Date(expiresAtMs).toISOString() };
}
