import type { ThreadId } from "@penkra/contracts";
import { Effect, Option } from "effect";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";

/** Read the thread that owns its provider session; lookup failures propagate. */
export function resolveProviderSessionThread(
  projectionSnapshotQuery: ProjectionSnapshotQueryShape,
  threadId: ThreadId,
) {
  return projectionSnapshotQuery.getThreadDetailById(threadId).pipe(Effect.map(Option.getOrNull));
}
