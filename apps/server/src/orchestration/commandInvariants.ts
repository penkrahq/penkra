import type {
  OrchestrationCommand,
  OrchestrationLatestTurn,
  OrchestrationFolder,
  OrchestrationReadModel,
  OrchestrationSpace,
  OrchestrationSession,
  OrchestrationThread,
  FolderId,
  SpaceId,
  ThreadId,
} from "@penkra/contracts";
import { THREAD_NOT_ARCHIVED_INVARIANT_MARKER } from "@penkra/shared/errorMessages";
import { normalizeEntityName } from "@penkra/shared/entityNames";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

/**
 * True when the thread still has an in-flight / unsettled turn:
 * session mid-lifecycle ("starting"/"running"), a non-error session with an
 * activeTurnId, or a latestTurn still projected as "running".
 *
 * Runtime errors can retain the failed turn id for attribution even though the
 * session and turn are terminal, so an errored session's activeTurnId is stale.
 */
export function threadHasInFlightTurn(thread: {
  readonly session: Pick<OrchestrationSession, "status" | "activeTurnId"> | null;
  readonly latestTurn: Pick<OrchestrationLatestTurn, "state"> | null;
}): boolean {
  const session = thread.session;
  return (
    (session?.status !== "error" && session?.activeTurnId != null) ||
    session?.status === "starting" ||
    session?.status === "running" ||
    thread.latestTurn?.state === "running"
  );
}

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

export function findFolderById(
  readModel: OrchestrationReadModel,
  folderId: FolderId,
): OrchestrationFolder | undefined {
  return readModel.folders.find((folder) => folder.id === folderId);
}

export function findSpaceById(
  readModel: OrchestrationReadModel,
  spaceId: SpaceId,
): OrchestrationSpace | undefined {
  return readModel.spaces.find((space) => space.id === spaceId);
}

export function listActiveSpaces(
  readModel: OrchestrationReadModel,
): ReadonlyArray<OrchestrationSpace> {
  return readModel.spaces
    .filter((space) => space.deletedAt === null && space.archivedAt === null)
    .toSorted((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
}

export function requireSpace(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly spaceId: SpaceId;
}): Effect.Effect<OrchestrationSpace, OrchestrationCommandInvariantError> {
  const space = findSpaceById(input.readModel, input.spaceId);
  if (space && space.deletedAt === null && space.archivedAt === null) {
    return Effect.succeed(space);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      space
        ? `Space '${input.spaceId}' is archived or deleted and cannot handle command '${input.command.type}'.`
        : `Space '${input.spaceId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireSpaceAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly spaceId: SpaceId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  // Aggregate ids are durable event-stream identities, not recyclable row ids. A deleted
  // Space remains in the read model as a tombstone; recreating it would append a second
  // `space.created` lifecycle to the same aggregate and make replay semantics ambiguous.
  if (!findSpaceById(input.readModel, input.spaceId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Space '${input.spaceId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireSpaceNameAvailable(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly name: string;
  readonly excludeSpaceId?: SpaceId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const normalizedName = input.name.trim().toLowerCase();
  const conflict = input.readModel.spaces.find(
    (space) =>
      space.deletedAt === null &&
      space.archivedAt === null &&
      space.id !== input.excludeSpaceId &&
      space.name.trim().toLowerCase() === normalizedName,
  );
  if (!conflict) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(input.command.type, `A space named '${input.name}' already exists.`),
  );
}

export function requireFolderNameAvailable(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly name: string;
  readonly spaceId: SpaceId;
  readonly excludeFolderId?: FolderId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const normalizedName = normalizeEntityName(input.name);
  const conflict = input.readModel.folders.find(
    (folder) =>
      folder.deletedAt === null &&
      folder.spaceId === input.spaceId &&
      folder.id !== input.excludeFolderId &&
      normalizeEntityName(folder.title) === normalizedName,
  );
  if (!conflict) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `A folder named '${input.name}' already exists in this Space.`,
    ),
  );
}

export function listThreadsByFolderId(
  readModel: OrchestrationReadModel,
  folderId: FolderId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.folderId === folderId);
}

export function requireFolder(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly folderId: FolderId;
}): Effect.Effect<OrchestrationFolder, OrchestrationCommandInvariantError> {
  const folder = findFolderById(input.readModel, input.folderId);
  if (folder) {
    return Effect.succeed(folder);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Folder '${input.folderId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireFolderAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly folderId: FolderId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findFolderById(input.readModel, input.folderId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Folder '${input.folderId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireFolderHasNoThreads(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly folderId: FolderId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const remainingThreads = listThreadsByFolderId(input.readModel, input.folderId).filter(
    (thread) => thread.deletedAt === null,
  );
  if (remainingThreads.length === 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Folder '${input.folderId}' still has ${remainingThreads.length} thread${remainingThreads.length === 1 ? "" : "s"} and cannot be deleted.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread && thread.deletedAt === null) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      thread
        ? `Thread '${input.threadId}' was deleted and cannot handle command '${input.command.type}'.`
        : `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findThreadById(input.readModel, input.threadId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt != null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' ${THREAD_NOT_ARCHIVED_INVARIANT_MARKER} '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt == null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireNonNegativeInteger(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}
