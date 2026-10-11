// FILE: admittedThreadRuntime.ts
// Purpose: Resolve a managed provider runtime after selection admission.
// Layer: Provider runtime preparation

import type {
  ModelSelection,
  ProviderConnectionId,
  ProviderKind,
  ThreadId,
} from "@penkra/contracts";
import { Effect, Option } from "effect";
import type { ThreadProviderBindingRepositoryShape } from "../persistence/Services/ThreadProviderBindings.ts";
import { ProviderAdapterValidationError } from "./Errors.ts";
import { claudeThreadHasConversation } from "./claudeThreadNativeState.ts";
import type { ProviderManagedLaunchContext } from "./Services/ProviderAdapter.ts";
import type { ProviderLaunchResolverShape } from "./Services/ProviderLaunchResolver.ts";
import type { ProviderTurnSelectionResolverShape } from "./Services/ProviderTurnSelectionResolver.ts";

export interface AdmittedThreadRuntimeDependencies {
  readonly stateDir: string;
  readonly threadProviderBindings: Pick<ThreadProviderBindingRepositoryShape, "getHarnessState">;
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
  const { threadProviderBindings, providerTurnSelectionResolver, providerLaunchResolver } =
    dependencies;
  if (input.connectionId === undefined) {
    return yield* new ProviderAdapterValidationError({
      provider: input.provider,
      operation: "thread.turn.start",
      issue: "The turn is missing its exact managed Connection binding.",
    });
  }
  const selection = yield* providerTurnSelectionResolver
    .resolveExisting({
      threadId: input.threadId,
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.connectionId !== undefined ? { connectionId: input.connectionId } : {}),
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterValidationError({
            provider: input.provider,
            operation: "thread.turn.start",
            issue: cause.message,
            cause,
          }),
      ),
    );
  if (selection.changed) {
    return yield* new ProviderAdapterValidationError({
      provider: selection.harness,
      operation: "thread.turn.start",
      issue: "A Connection change requires verified transactional switch admission.",
    });
  }
  const state = Option.getOrUndefined(
    yield* threadProviderBindings.getHarnessState(input.threadId),
  );
  if (!state || state.revision !== selection.stateRevision) {
    return yield* new ProviderAdapterValidationError({
      provider: selection.harness,
      operation: "thread.turn.start",
      issue: "The thread native state changed before managed runtime launch.",
    });
  }
  const resumeCursor = yield* Effect.try({
    try: () => JSON.parse(state.nativeStateLocatorJson) as unknown,
    catch: (cause) =>
      new ProviderAdapterValidationError({
        provider: selection.harness,
        operation: "thread.turn.start",
        issue: "The thread native-state locator is invalid.",
        cause,
      }),
  });
  const launch = yield* providerLaunchResolver
    .resolve({
      threadId: input.threadId,
      connectionId: selection.connectionId,
      internalProviderId: selection.internalProviderId,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterValidationError({
            provider: selection.harness,
            operation: "thread.turn.start",
            issue: cause.message,
            cause,
          }),
      ),
    );
  const missingClaudeConversation =
    selection.harness === "claudeAgent" &&
    state.providerSessionId !== null &&
    !(yield* Effect.tryPromise(() =>
      claudeThreadHasConversation(
        dependencies.stateDir,
        state.nativeStateGenerationId,
        state.providerSessionId!,
      ),
    ));
  const requiresReconstruction =
    missingClaudeConversation ||
    (state.providerSessionId === null &&
      typeof resumeCursor === "object" &&
      resumeCursor !== null &&
      (resumeCursor as { readonly penkraReconstruction?: unknown }).penkraReconstruction === true);
  return {
    bindingRevision: selection.bindingRevision,
    // A first binding owns an empty managed generation but has no native
    // session identity yet. Start fresh; JSON null is a persisted sentinel,
    // not a provider resume cursor.
    resumeCursor:
      state.providerSessionId === null || missingClaudeConversation ? undefined : resumeCursor,
    requiresReconstruction,
    managedLaunch: {
      binaryPath: launch.binaryPath,
      isolationKey: launch.isolationKey,
      profileRoot: launch.profileRoot,
      nativeStateRoot: launch.nativeStateRoot,
      childEnvironment: (baseEnv: NodeJS.ProcessEnv) => launch.childEnvironment(baseEnv),
    } satisfies ProviderManagedLaunchContext,
  };
});
