import type {
  OrchestrationFolderShell,
  OrchestrationThreadShell,
  SpaceId,
} from "@penkra/contracts";
import { Effect, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ToolInputError, errorText } from "./toolInput.ts";

export function resolveThreadSpaceId(input: {
  readonly thread: Pick<OrchestrationThreadShell, "id" | "folderId">;
  readonly folder: Pick<OrchestrationFolderShell, "id" | "spaceId">;
}): SpaceId {
  return input.folder.spaceId;
}

export function requireThreadSpaceId(
  snapshotQuery: ProjectionSnapshotQueryShape,
  thread: Pick<OrchestrationThreadShell, "id" | "folderId">,
): Effect.Effect<SpaceId, ToolInputError> {
  return snapshotQuery.getFolderShellById(thread.folderId).pipe(
    Effect.mapError((error) => new ToolInputError(errorText(error))),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new ToolInputError(`Folder "${thread.folderId}" was not found.`)),
        onSome: (folder) =>
          Effect.try({
            try: () => resolveThreadSpaceId({ thread, folder }),
            catch: (error) => new ToolInputError(errorText(error)),
          }),
      }),
    ),
  );
}
