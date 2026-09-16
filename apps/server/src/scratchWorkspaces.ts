// FILE: scratchWorkspaces.ts
// Purpose: Durable per-thread working directories for provider sessions that
//          do not have an explicitly selected project workspace. Surviving
//          legacy OS-temp workspaces are adopted on first use.
// Layer: Server filesystem utility
// Exports: ensureDurableThreadWorkspace

import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ThreadId } from "@penkra/contracts";
import { SCRATCH_WORKSPACES_DIRNAME } from "@penkra/shared/threadWorkspace";

function scratchWorkspaceSegment(threadId: ThreadId): string {
  const raw = String(threadId);
  const safePrefix = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^\.+/g, "")
    .slice(0, 64);
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return `${safePrefix || "thread"}-${digest}`;
}

export const DURABLE_THREAD_WORKSPACES_DIRNAME = "thread-workspaces";

export function ensureDurableThreadWorkspace(
  threadId: ThreadId,
  stateDir: string,
  options?: { readonly legacyScratchRoot?: string },
): string {
  const segment = scratchWorkspaceSegment(threadId);
  const workspaceRoot = path.join(stateDir, DURABLE_THREAD_WORKSPACES_DIRNAME);
  const workspaceDir = path.join(workspaceRoot, segment);
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  chmodSync(workspaceRoot, 0o700);
  chmodSync(workspaceDir, 0o700);

  // Old releases used os.tmpdir(). Copy rather than rename so migration also
  // works when the temp and state directories are on different volumes. The
  // operation is idempotent: durable files win if a prior migration was
  // interrupted, and the legacy source is removed only after a successful copy.
  const legacyScratchRoot =
    options?.legacyScratchRoot ?? path.join(tmpdir(), SCRATCH_WORKSPACES_DIRNAME);
  const legacyWorkspaceDir = path.join(legacyScratchRoot, segment);
  if (
    path.resolve(legacyWorkspaceDir) !== path.resolve(workspaceDir) &&
    existsSync(legacyWorkspaceDir)
  ) {
    cpSync(legacyWorkspaceDir, workspaceDir, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
    rmSync(legacyWorkspaceDir, { recursive: true, force: true });
  }

  return workspaceDir;
}
