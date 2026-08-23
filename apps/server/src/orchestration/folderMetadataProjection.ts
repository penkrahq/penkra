import type { OrchestrationEvent } from "@penkra/contracts";
import { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { ProjectionFolderRepositoryShape } from "../persistence/Services/ProjectionFolders.ts";
import type { ProjectionStateRepositoryShape } from "../persistence/Services/ProjectionState.ts";

export type FolderMetadataOrchestrationEvent = Extract<
  OrchestrationEvent,
  { type: "folder.created" | "folder.updated" | "folder.moved" | "folder.deleted" }
>;

export const FOLDER_METADATA_SNAPSHOT_PROJECTORS = [
  "projection.hot",
  "projection.folders",
  "projection.threads",
  "projection.thread-messages",
  "projection.thread-activities",
  "projection.thread-sessions",
] as const;

export const applyFolderMetadataProjection = (input: {
  readonly event: FolderMetadataOrchestrationEvent;
  readonly projectionFolderRepository: ProjectionFolderRepositoryShape;
}): Effect.Effect<void, ProjectionRepositoryError> =>
  Effect.gen(function* () {
    switch (input.event.type) {
      case "folder.created":
        yield* input.projectionFolderRepository.upsert({
          folderId: input.event.payload.folderId,
          title: input.event.payload.title,
          workspaceRoot: input.event.payload.workspaceRoot,
          defaultModelSelection: input.event.payload.defaultModelSelection,
          scripts: input.event.payload.scripts,
          iconDataUrl: input.event.payload.iconDataUrl ?? null,
          isPinned: input.event.payload.isPinned ?? false,
          spaceId: input.event.payload.spaceId,
          sidebarSortOrder: input.event.payload.sidebarSortOrder ?? 0,
          createdAt: input.event.payload.createdAt,
          updatedAt: input.event.payload.updatedAt,
          archivedAt: null,
          deletedAt: null,
        });
        break;

      case "folder.updated": {
        const existingRow = yield* input.projectionFolderRepository.getById({
          folderId: input.event.payload.folderId,
        });
        if (Option.isSome(existingRow)) {
          yield* input.projectionFolderRepository.upsert({
            ...existingRow.value,
            ...(input.event.payload.title !== undefined
              ? { title: input.event.payload.title }
              : {}),
            ...(input.event.payload.workspaceRoot !== undefined
              ? { workspaceRoot: input.event.payload.workspaceRoot }
              : {}),
            ...(input.event.payload.defaultModelSelection !== undefined
              ? { defaultModelSelection: input.event.payload.defaultModelSelection }
              : {}),
            ...(input.event.payload.scripts !== undefined
              ? { scripts: input.event.payload.scripts }
              : {}),
            ...(input.event.payload.iconDataUrl !== undefined
              ? { iconDataUrl: input.event.payload.iconDataUrl }
              : {}),
            ...(input.event.payload.isPinned !== undefined
              ? { isPinned: input.event.payload.isPinned }
              : {}),
            ...(input.event.payload.sidebarSortOrder !== undefined
              ? { sidebarSortOrder: input.event.payload.sidebarSortOrder }
              : {}),
            ...(input.event.payload.archivedAt !== undefined
              ? { archivedAt: input.event.payload.archivedAt }
              : {}),
            updatedAt: input.event.payload.updatedAt,
          });
        }
        break;
      }

      case "folder.moved": {
        const existingRow = yield* input.projectionFolderRepository.getById({
          folderId: input.event.payload.folderId,
        });
        if (Option.isSome(existingRow)) {
          yield* input.projectionFolderRepository.upsert({
            ...existingRow.value,
            spaceId: input.event.payload.spaceId,
            updatedAt: input.event.payload.updatedAt,
          });
        }
        break;
      }

      case "folder.deleted": {
        const existingRow = yield* input.projectionFolderRepository.getById({
          folderId: input.event.payload.folderId,
        });
        if (Option.isSome(existingRow)) {
          yield* input.projectionFolderRepository.upsert({
            ...existingRow.value,
            deletedAt: input.event.payload.deletedAt,
            updatedAt: input.event.payload.deletedAt,
          });
        }
        break;
      }
    }
  });

export const advanceFolderMetadataSnapshotState = (input: {
  readonly event: Pick<OrchestrationEvent, "sequence" | "occurredAt">;
  readonly projectionStateRepository: ProjectionStateRepositoryShape;
}): Effect.Effect<void, ProjectionRepositoryError> =>
  Effect.forEach(
    FOLDER_METADATA_SNAPSHOT_PROJECTORS,
    (projector) =>
      input.projectionStateRepository.upsert({
        projector,
        lastAppliedSequence: input.event.sequence,
        updatedAt: input.event.occurredAt,
      }),
    { concurrency: 1 },
  ).pipe(Effect.asVoid);
