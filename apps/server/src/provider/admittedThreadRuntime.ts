// FILE: admittedThreadRuntime.ts
// Purpose: Resolve managed launch and resume from the canonical thread row.

import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type {
  ModelSelection,
  ProviderConnectionId,
  ProviderKind,
  ThreadId,
} from "@penkra/contracts";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { readThreadNativeState } from "../cleanCore/threadNativeState.ts";
import { ProviderAdapterValidationError } from "./Errors.ts";
import { claudeThreadHasConversation } from "./claudeThreadNativeState.ts";
import { findOneExactCodexRollout } from "./codexManagedNativeState.ts";
import { providerNativeStateRoot } from "./providerNativeStatePaths.ts";
import { providerNativeResumeCursor } from "./nativeResumeIdentity.ts";
import type { ProviderManagedLaunchContext } from "./Services/ProviderAdapter.ts";
import type { ProviderLaunchResolverShape } from "./Services/ProviderLaunchResolver.ts";
import type {
  ResolvedProviderTurnSelection,
  ProviderTurnSelectionResolverShape,
} from "./Services/ProviderTurnSelectionResolver.ts";

export interface AdmittedThreadRuntimeDependencies {
  readonly stateDir: string;
  readonly sql: SqlClient.SqlClient;
  readonly providerTurnSelectionResolver: Pick<
    ProviderTurnSelectionResolverShape,
    "resolveExisting"
  >;
  readonly providerLaunchResolver: Pick<ProviderLaunchResolverShape, "resolve">;
}

export const resolveAdmittedThreadRuntime = Effect.fnUntraced(function* (
  input: {
    readonly threadId: ThreadId;
    readonly provider: ProviderKind;
    readonly modelSelection: ModelSelection | undefined;
    readonly connectionId: ProviderConnectionId | null | undefined;
  },
  dependencies: AdmittedThreadRuntimeDependencies,
) {
  const validation = (issue: string, cause?: unknown) =>
    new ProviderAdapterValidationError({
      provider: input.provider,
      operation: "thread.turn.start",
      issue,
      ...(cause === undefined ? {} : { cause }),
    });
  if (input.connectionId === undefined)
    return yield* validation("The turn is missing its managed Connection selection.");
  const selection = yield* dependencies.providerTurnSelectionResolver
    .resolveExisting({
      threadId: input.threadId,
      ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
      connectionId: input.connectionId,
    })
    .pipe(Effect.mapError((cause) => validation(cause.message, cause)));
  if (selection.changed) return yield* validation("A Connection change requires turn admission.");
  return yield* resolveSelectedThreadRuntime(input, selection, dependencies);
});

/** Launch from the selection already authorized at turn admission. */
export const resolveSelectedThreadRuntime = Effect.fnUntraced(function* (
  input: { readonly threadId: ThreadId; readonly provider: ProviderKind },
  selection: ResolvedProviderTurnSelection,
  dependencies: Pick<
    AdmittedThreadRuntimeDependencies,
    "stateDir" | "sql" | "providerLaunchResolver"
  >,
) {
  const validation = (issue: string, cause?: unknown) =>
    new ProviderAdapterValidationError({
      provider: input.provider,
      operation: "thread.turn.start",
      issue,
      ...(cause === undefined ? {} : { cause }),
    });
  const row = yield* readThreadNativeState(input.threadId).pipe(
    Effect.provideService(SqlClient.SqlClient, dependencies.sql),
    Effect.mapError((cause) => validation("Could not read the thread's native state.", cause)),
  );
  if (
    Option.isNone(row) ||
    row.value.provider !== selection.harness ||
    row.value.connectionId !== selection.connectionId ||
    row.value.nativeStateId !== selection.nativeStateId
  ) {
    return yield* validation("The thread native state changed before managed runtime launch.");
  }
  const state = row.value;
  const hasConversation =
    state.nativeStateId === null || state.providerSessionId === null
      ? false
      : yield* Effect.tryPromise({
          try: async () => {
            const root = providerNativeStateRoot(dependencies.stateDir, state.nativeStateId!);
            try {
              if (!(await lstat(root)).isDirectory())
                throw new Error(`Native state is not a directory: ${root}`);
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
              throw cause;
            }
            if (selection.harness === "claudeAgent")
              return claudeThreadHasConversation(
                dependencies.stateDir,
                state.nativeStateId!,
                state.providerSessionId!,
              );
            if (selection.harness === "codex")
              return (
                (await findOneExactCodexRollout(
                  join(root, "codex-rollouts"),
                  state.providerSessionId!,
                )) !== null
              );
            return true;
          },
          catch: (cause) => validation("Could not read the thread's native conversation.", cause),
        });
  const launch = yield* dependencies.providerLaunchResolver
    .resolve({
      threadId: input.threadId,
      connectionId: selection.connectionId,
      internalProviderId: selection.internalProviderId,
    })
    .pipe(Effect.mapError((cause) => validation(cause.message, cause)));
  return {
    resumeCursor: hasConversation
      ? providerNativeResumeCursor(selection.harness, state.providerSessionId!)
      : undefined,
    requiresReconstruction: !hasConversation,
    managedLaunch: {
      connectionId: launch.connectionId,
      binaryPath: launch.binaryPath,
      isolationKey: launch.isolationKey,
      profileRoot: launch.profileRoot,
      nativeStateRoot: launch.nativeStateRoot,
      childEnvironment: (baseEnv: NodeJS.ProcessEnv) => launch.childEnvironment(baseEnv),
    } satisfies ProviderManagedLaunchContext,
  };
});
