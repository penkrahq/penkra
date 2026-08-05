import type {
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  SpaceId,
} from "@penkra/contracts";
import { Effect, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ToolInputError, errorText } from "./toolInput.ts";

export function resolveThreadSpaceId(input: {
  readonly thread: Pick<OrchestrationThreadShell, "id" | "projectId" | "spaceId">;
  readonly project: Pick<OrchestrationProjectShell, "id" | "spaceId">;
}): SpaceId {
  const directSpaceId = input.thread.spaceId ?? null;
  const projectSpaceId = input.project.spaceId ?? null;

  if (directSpaceId !== null && projectSpaceId !== null && directSpaceId !== projectSpaceId) {
    throw new ToolInputError(
      `Thread "${input.thread.id}" belongs to Space "${directSpaceId}" but its parent project "${input.project.id}" belongs to Space "${projectSpaceId}".`,
    );
  }

  const spaceId = directSpaceId ?? projectSpaceId;
  if (spaceId === null) {
    throw new ToolInputError(
      `Neither Thread "${input.thread.id}" nor its parent project "${input.project.id}" is assigned to a Space.`,
    );
  }
  return spaceId;
}

export function requireThreadSpaceId(
  snapshotQuery: ProjectionSnapshotQueryShape,
  thread: Pick<OrchestrationThreadShell, "id" | "projectId" | "spaceId">,
): Effect.Effect<SpaceId, ToolInputError> {
  return snapshotQuery.getProjectShellById(thread.projectId).pipe(
    Effect.mapError((error) => new ToolInputError(errorText(error))),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new ToolInputError(`Project "${thread.projectId}" was not found.`)),
        onSome: (project) =>
          Effect.try({
            try: () => resolveThreadSpaceId({ thread, project }),
            catch: (error) => new ToolInputError(errorText(error)),
          }),
      }),
    ),
  );
}
