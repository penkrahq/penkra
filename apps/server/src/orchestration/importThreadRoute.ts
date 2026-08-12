// FILE: importThreadRoute.ts
// Purpose: Fail-closed boundary while exact Connection-scoped native import is implemented.

import type { OrchestrationImportThreadInput } from "@penkra/contracts";
import type { FileSystem, Path } from "effect";
import { Data, Effect, Option } from "effect";

import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery";
import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry";
import type { ProviderServiceShape } from "../provider/Services/ProviderService";

class ImportThreadError extends Data.TaggedError("ImportThreadError")<{
  readonly message: string;
}> {}

export interface ImportThreadHandlerOptions {
  readonly fileSystem: FileSystem.FileSystem;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly path: Path.Path;
  readonly platform: NodeJS.Platform;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly providerAdapterRegistry: ProviderAdapterRegistryShape;
  readonly providerService: ProviderServiceShape;
}

/**
 * Native import remains a retained product feature, but the former route read
 * global provider homes and inferred the account from whichever login happened
 * to be active. Keep the callable boundary closed until the reviewed UI supplies
 * an explicit Connection and the server can preserve, verify, and atomically
 * bind the exact native generation.
 */
export function makeImportThreadHandler(options: ImportThreadHandlerOptions) {
  return Effect.fnUntraced(function* (body: OrchestrationImportThreadInput) {
    const thread = yield* options.projectionSnapshotQuery.getThreadDetailById(body.threadId);
    if (Option.isNone(thread)) {
      return yield* new ImportThreadError({ message: `Thread '${body.threadId}' was not found.` });
    }
    if (thread.value.session && thread.value.session.status !== "stopped") {
      return yield* new ImportThreadError({
        message: `Thread '${body.threadId}' already has an active provider session.`,
      });
    }
    return yield* new ImportThreadError({
      message: "Thread import is unavailable until its Connection-selection flow is finalized.",
    });
  });
}
