// FILE: projectCreateRecovery.ts
// Purpose: Centralizes duplicate `folder.create` error parsing and recovery helpers.
// Exports: duplicate-create error guards plus snapshot matching for import recovery.

import type { OrchestrationReadModel } from "@penkra/contracts";
import { workspaceRootsEqual } from "@penkra/shared/threadWorkspace";

const DUPLICATE_PROJECT_CREATE_ERROR_PREFIX =
  "Orchestration command invariant failed (folder.create): Project '";
const DEFAULT_RECOVERY_MAX_ATTEMPTS = 6;
const DEFAULT_RECOVERY_DELAY_MS = 50;

export interface DuplicateProjectCreateRecoveryCandidate {
  readonly id: string;
  readonly workspaceRoot: string | null;
  readonly deletedAt?: string | null | undefined;
}

interface SnapshotWithFolders<T extends DuplicateProjectCreateRecoveryCandidate> {
  readonly folders: readonly T[];
}

interface ProjectLookupInput {
  readonly folderId?: string | null | undefined;
  readonly workspaceRoot?: string | null | undefined;
}

function isRecoverableActiveProject(project: DuplicateProjectCreateRecoveryCandidate): boolean {
  return (project.deletedAt ?? null) === null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Generic retry-with-backoff loop shared by every duplicate-create recovery flow: poll
// `loadSnapshot` with linear backoff, then fall back to `repairSnapshot` once before giving up.
// This is the single source of the 6-attempt / 50ms-backoff shape used across recovery helpers.
export async function waitForSnapshotMatch<TSnapshot, TMatch>(input: {
  readonly loadSnapshot: () => Promise<TSnapshot | null>;
  readonly findMatch: (snapshot: TSnapshot) => TMatch | null;
  readonly repairSnapshot?: (() => Promise<TSnapshot | null>) | undefined;
  readonly maxAttempts?: number | undefined;
  readonly delayMs?: number | undefined;
}): Promise<{ match: TMatch | null; snapshot: TSnapshot | null }> {
  let latestSnapshot: TSnapshot | null = null;
  const maxAttempts = input.maxAttempts ?? DEFAULT_RECOVERY_MAX_ATTEMPTS;
  const delayMs = input.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const snapshot = await input.loadSnapshot();
    if (snapshot) {
      latestSnapshot = snapshot;
      const match = input.findMatch(snapshot);
      if (match) {
        return { match, snapshot };
      }
    }

    if (attempt < maxAttempts) {
      await wait(delayMs * attempt);
    }
  }

  if (input.repairSnapshot) {
    const repairedSnapshot = await input.repairSnapshot();
    if (repairedSnapshot) {
      latestSnapshot = repairedSnapshot;
      const repairedMatch = input.findMatch(repairedSnapshot);
      if (repairedMatch) {
        return { match: repairedMatch, snapshot: repairedSnapshot };
      }
    }
  }

  return { match: null, snapshot: latestSnapshot };
}

// Shared machinery behind hidden-container candidate helpers used by home-chat
// project recovery: normalizes the cwd/workspaceRoot field naming difference between local store
// folders and shell-snapshot rows, and finds a candidate by id via a caller-supplied predicate.
export interface ContainerCandidateFields {
  readonly cwd?: string | null | undefined;
  readonly workspaceRoot?: string | null | undefined;
}

export function resolveContainerCandidateCwd(
  candidate: ContainerCandidateFields | null | undefined,
): string {
  return candidate?.cwd ?? candidate?.workspaceRoot ?? "";
}

export function findContainerCandidateById<T extends { readonly id?: string | undefined }>(
  folders: readonly T[],
  folderId: string,
  isContainerCandidate: (project: T) => boolean,
): T | null {
  return (
    folders.find((project) => project.id === folderId && isContainerCandidate(project)) ?? null
  );
}

// Parses the invariant text so the UI can recover existing folders instead of failing imports.
export function isDuplicateProjectCreateError(message: string): boolean {
  if (!message.startsWith(DUPLICATE_PROJECT_CREATE_ERROR_PREFIX)) {
    return false;
  }

  const duplicateMarkerIndex = message.indexOf("' already uses workspace root '");
  return duplicateMarkerIndex > DUPLICATE_PROJECT_CREATE_ERROR_PREFIX.length;
}

export function extractDuplicateProjectCreateFolderId(message: string): string | null {
  if (!isDuplicateProjectCreateError(message)) {
    return null;
  }

  const duplicateMarkerIndex = message.indexOf("' already uses workspace root '");
  return message.slice(DUPLICATE_PROJECT_CREATE_ERROR_PREFIX.length, duplicateMarkerIndex) || null;
}

export function findRecoverableProject<T extends DuplicateProjectCreateRecoveryCandidate>(
  input: ProjectLookupInput & {
    readonly folders: readonly T[];
  },
): T | null {
  if (input.folderId) {
    const projectById = input.folders.find(
      (project) => isRecoverableActiveProject(project) && project.id === input.folderId,
    );
    if (projectById) {
      return projectById;
    }
  }

  if (!input.workspaceRoot) {
    return null;
  }

  const workspaceRoot = input.workspaceRoot;
  return (
    input.folders.find(
      (project) =>
        isRecoverableActiveProject(project) &&
        project.workspaceRoot !== null &&
        workspaceRootsEqual(project.workspaceRoot, workspaceRoot),
    ) ?? null
  );
}

// Prefers the explicit duplicate id, then falls back to workspace-root matching for older clients.
export function findRecoverableProjectForDuplicateCreate<
  T extends DuplicateProjectCreateRecoveryCandidate,
>(input: {
  readonly message: string;
  readonly folders: readonly T[];
  readonly workspaceRoot: string;
}): T | null {
  if (!isDuplicateProjectCreateError(input.message)) {
    return null;
  }

  return findRecoverableProject({
    folders: input.folders,
    folderId: extractDuplicateProjectCreateFolderId(input.message),
    workspaceRoot: input.workspaceRoot,
  });
}

export async function waitForRecoverableProjectInReadModel<
  TSnapshot extends SnapshotWithFolders<DuplicateProjectCreateRecoveryCandidate> =
    OrchestrationReadModel,
>(
  input: ProjectLookupInput & {
    readonly loadSnapshot: () => Promise<TSnapshot | null>;
    readonly repairSnapshot?: (() => Promise<TSnapshot | null>) | undefined;
    readonly maxAttempts?: number | undefined;
    readonly delayMs?: number | undefined;
  },
): Promise<{
  project: TSnapshot["folders"][number] | null;
  snapshot: TSnapshot | null;
}> {
  const { match, snapshot } = await waitForSnapshotMatch<TSnapshot, TSnapshot["folders"][number]>({
    loadSnapshot: input.loadSnapshot,
    repairSnapshot: input.repairSnapshot,
    maxAttempts: input.maxAttempts,
    delayMs: input.delayMs,
    findMatch: (candidateSnapshot) =>
      findRecoverableProject({
        folders: candidateSnapshot.folders,
        folderId: input.folderId,
        workspaceRoot: input.workspaceRoot,
      }) as TSnapshot["folders"][number] | null,
  });

  return { project: match, snapshot };
}

// Retries snapshot reads briefly so freshly restored folders can be reused by the first-send flow.
export async function waitForRecoverableProjectForDuplicateCreate<
  TSnapshot extends SnapshotWithFolders<DuplicateProjectCreateRecoveryCandidate>,
>(input: {
  readonly message: string;
  readonly workspaceRoot: string;
  readonly loadSnapshot: () => Promise<TSnapshot | null>;
  readonly repairSnapshot?: (() => Promise<TSnapshot | null>) | undefined;
  readonly maxAttempts?: number | undefined;
  readonly delayMs?: number | undefined;
}): Promise<{
  project: TSnapshot["folders"][number] | null;
  snapshot: TSnapshot | null;
}> {
  const { match, snapshot } = await waitForSnapshotMatch<TSnapshot, TSnapshot["folders"][number]>({
    loadSnapshot: input.loadSnapshot,
    repairSnapshot: input.repairSnapshot,
    maxAttempts: input.maxAttempts,
    delayMs: input.delayMs,
    findMatch: (candidateSnapshot) =>
      findRecoverableProjectForDuplicateCreate({
        message: input.message,
        folders: candidateSnapshot.folders,
        workspaceRoot: input.workspaceRoot,
      }) as TSnapshot["folders"][number] | null,
  });

  return { project: match, snapshot };
}
