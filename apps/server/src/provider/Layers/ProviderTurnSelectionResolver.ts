// FILE: ProviderTurnSelectionResolver.ts
// Purpose: Fail-closed resolution of existing thread Connection/model selections.

import { Effect, Layer, Option } from "effect";
import type { ProviderConnectionId, ProviderInstallationId } from "@penkra/contracts";

import { ServerConfig } from "../../config.ts";
import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import { ProviderInstallationRepository } from "../../persistence/Services/ProviderInstallations.ts";
import { ThreadProviderBindingRepository } from "../../persistence/Services/ThreadProviderBindings.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderLaunchResolver } from "../Services/ProviderLaunchResolver.ts";
import {
  claudeAccountsMatch,
  readClaudeThreadAccount,
  rememberClaudeThreadAccount,
} from "../claudeThreadNativeState.ts";
import { parseOpenCodeModelSlug } from "../opencodeRuntime.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { resolveDefaultConnection } from "../defaultConnection.ts";
import { providerModelDiscoveryStateIdentity } from "../providerDiscoveryStateIdentity.ts";
import {
  findConnectionAuthenticationMethod,
  findManagedLoginMethod,
  findStaticCredentialMethod,
  getProviderConnectionManifest,
} from "../providerConnectionManifests.ts";
import {
  ProviderTurnSelectionResolutionError,
  ProviderTurnSelectionResolver,
  type ProviderTurnSelectionFailureCode,
  type ResolvedProviderTurnSelection,
  type ProviderTurnSelectionResolverShape,
} from "../Services/ProviderTurnSelectionResolver.ts";

const fail = (
  detail: string,
  code: ProviderTurnSelectionFailureCode = "selection_failed",
  cause?: unknown,
) =>
  Effect.fail(
    new ProviderTurnSelectionResolutionError({
      code,
      detail,
      ...(cause === undefined ? {} : { cause }),
    }),
  );

function internalProviderIdForModel(
  harness: string,
  modelId: string,
): Effect.Effect<string | null, ProviderTurnSelectionResolutionError> {
  if (harness === "opencode") {
    const parsed = parseOpenCodeModelSlug(modelId);
    return parsed === null
      ? fail(
          "OpenCode model IDs must include their provider prefix, exactly as `penkra models list` shows them (for example opencode-go/glm-5.3).",
          "model_unavailable",
        )
      : Effect.succeed(parsed.providerID);
  }
  return Effect.succeed(null);
}

export function claudeConnectionsShareAccount(
  previous: { readonly authenticationMethodId: string; readonly providerIdentityId: string | null },
  target: { readonly authenticationMethodId: string; readonly providerIdentityId: string | null },
): boolean {
  return claudeAccountsMatch(previous, target);
}

export const makeProviderTurnSelectionResolver = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const connections = yield* ProviderConnectionRepository;
  const installations = yield* ProviderInstallationRepository;
  const threads = yield* ThreadProviderBindingRepository;
  const projections = yield* ProjectionSnapshotQuery;
  const registry = yield* ProviderAdapterRegistry;
  const launchResolver = yield* ProviderLaunchResolver;
  const serverSettings = yield* ServerSettingsService;

  const requireAvailableModel = Effect.fnUntraced(function* (input: {
    readonly harness: Parameters<typeof getProviderConnectionManifest>[0];
    readonly connectionId: ProviderConnectionId | null;
    readonly installationId: ProviderInstallationId;
    readonly internalProviderId: string | null;
    readonly modelId: string;
    readonly allowRetiredInstallation?: boolean;
  }) {
    const adapter = yield* registry.getByProvider(input.harness).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderTurnSelectionResolutionError({
            detail: "Could not resolve the selected managed provider.",
            cause,
          }),
      ),
    );
    if (!adapter.listModels) return yield* fail("The managed provider has no model catalog.");
    const managedLaunch = yield* launchResolver
      .resolveProfile({
        harness: input.harness,
        connectionId: input.connectionId,
        installationId: input.installationId,
        internalProviderId: input.internalProviderId,
        nativeStateIdentity: providerModelDiscoveryStateIdentity({
          provider: input.harness,
          connectionId: input.connectionId,
        }),
        ...(input.allowRetiredInstallation === true ? { allowRetiredInstallation: true } : {}),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderTurnSelectionResolutionError({
              detail: cause.detail,
              cause,
            }),
        ),
      );
    const catalog = yield* adapter
      .listModels({
        provider: input.harness,
        managedLaunch,
        internalProviderId: input.internalProviderId,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderTurnSelectionResolutionError({
              detail: "Could not verify the selected model for this Connection.",
              cause,
            }),
        ),
      );
    const selectedModel = catalog.models.find((model) => model.slug === input.modelId);
    if (!selectedModel) {
      yield* Effect.logWarning("managed Connection model verification failed", {
        harness: input.harness,
        connectionId: input.connectionId,
        installationId: input.installationId,
        internalProviderId: input.internalProviderId,
        requestedModelId: input.modelId,
        availableModelIds: catalog.models.map((model) => model.slug),
        catalogSource: catalog.source,
        catalogCached: catalog.cached,
      });
      return yield* fail(
        "This model isn't available on the selected Connection.",
        "model_unavailable",
      );
    }
    return selectedModel;
  });

  const requireAuthorizedConnection = Effect.fnUntraced(function* (input: {
    readonly harness: Parameters<typeof getProviderConnectionManifest>[0];
    readonly connectionId: NonNullable<
      Parameters<ProviderTurnSelectionResolverShape["resolveInitial"]>[0]["connectionId"]
    >;
    readonly internalProviderId: string | null;
  }) {
    const connection = yield* connections.getRecord(input.connectionId).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderTurnSelectionResolutionError({
            detail: "Could not read the selected Connection.",
            cause,
          }),
      ),
    );
    if (Option.isNone(connection) || connection.value.lifecycle !== "active") {
      return yield* fail(
        "The selected Connection can't be used for this thread. Choose a Connection for the thread's provider.",
        "connection_unavailable",
      );
    }
    if (connection.value.harness !== input.harness) {
      return yield* fail(
        "The selected Connection can't be used for this thread. Choose a Connection for the thread's provider.",
        "provider_mismatch",
      );
    }
    const method = findConnectionAuthenticationMethod(connection.value);
    if (method === null || !method.authorizesInternalProvider(input.internalProviderId)) {
      return yield* fail(
        "The selected Connection doesn't have access to this model.",
        "connection_unauthorized",
      );
    }
    if (
      (findStaticCredentialMethod(connection.value) !== null &&
        (connection.value.credentialRef === null || connection.value.profileRef !== null)) ||
      (findManagedLoginMethod(connection.value) !== null &&
        (connection.value.credentialRef !== null || connection.value.profileRef === null))
    ) {
      return yield* fail(
        "The selected Connection's sign-in method doesn't work with this model.",
        "connection_unauthorized",
      );
    }
    return connection.value;
  });

  const requireActiveInstallation = (
    harness: Parameters<typeof getProviderConnectionManifest>[0],
  ) =>
    installations.list().pipe(
      Effect.mapError(
        (cause) =>
          new ProviderTurnSelectionResolutionError({
            detail: "Could not read managed provider installations.",
            cause,
          }),
      ),
      Effect.flatMap((entries) => {
        const installation = entries.find(
          (entry) => entry.harness === harness && entry.lifecycle === "active",
        );
        return installation
          ? Effect.succeed(installation)
          : fail("No active managed installation exists for this harness.");
      }),
    );

  const resolveNewThreadConnection: ProviderTurnSelectionResolverShape["resolveNewThreadConnection"] =
    (input) =>
      Effect.gen(function* () {
        const harness = input.modelSelection.provider;
        const manifest = getProviderConnectionManifest(harness);
        if (manifest === null) {
          return yield* fail("The thread harness has no enabled managed adapter.");
        }
        yield* requireActiveInstallation(harness);
        const internalProviderId = yield* internalProviderIdForModel(
          harness,
          input.modelSelection.model,
        );
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderTurnSelectionResolutionError({
                detail: "Could not read the default Connection.",
                cause,
              }),
          ),
        );
        const entries = yield* connections.list().pipe(
          Effect.mapError(
            (cause) =>
              new ProviderTurnSelectionResolutionError({
                detail: "Could not read Connections.",
                cause,
              }),
          ),
        );
        const requestedConnectionId = yield* Effect.try({
          try: () =>
            resolveDefaultConnection({
              provider: harness,
              settings,
              connections: entries,
              ...(input.connectionId !== undefined ? { connectionId: input.connectionId } : {}),
            }),
          catch: (cause) =>
            new ProviderTurnSelectionResolutionError({
              detail: cause instanceof Error ? cause.message : "Could not resolve the Connection.",
              cause,
            }),
        });
        if (requestedConnectionId === null) {
          if (manifest.anonymous?.authorizesInternalProvider(internalProviderId)) return null;
          return yield* fail("This model needs a signed-in Connection.", "connection_unauthorized");
        }
        yield* requireAuthorizedConnection({
          harness,
          connectionId: requestedConnectionId,
          internalProviderId,
        });
        return requestedConnectionId;
      });

  const resolveInitial: ProviderTurnSelectionResolverShape["resolveInitial"] = (input) =>
    Effect.gen(function* () {
      const thread = yield* projections.getThreadShellById(input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderTurnSelectionResolutionError({
              detail: "Could not read the thread's initial provider selection.",
              cause,
            }),
        ),
      );
      if (Option.isNone(thread)) {
        yield* Effect.logWarning("initial provider admission could not find thread projection", {
          threadId: input.threadId,
        });
        return yield* fail("The thread does not exist.");
      }
      const modelSelection = input.modelSelection ?? thread.value.modelSelection;
      if (modelSelection.provider !== thread.value.modelSelection.provider) {
        return yield* fail(
          "This thread uses a different provider. To use another provider, start a new thread.",
          "provider_mismatch",
        );
      }
      const harness = modelSelection.provider;
      const manifest = getProviderConnectionManifest(harness);
      if (manifest === null)
        return yield* fail("The thread harness has no enabled managed adapter.");
      const internalProviderId = yield* internalProviderIdForModel(harness, modelSelection.model);
      const activeInstallation = yield* requireActiveInstallation(harness);

      const connectionId =
        input.connectionId === undefined
          ? yield* resolveNewThreadConnection({
              modelSelection,
            })
          : input.connectionId;

      let connectionLabel: string | null = null;
      if (connectionId === null) {
        if (!manifest.anonymous?.authorizesInternalProvider(internalProviderId)) {
          return yield* fail("This model needs a signed-in Connection.", "connection_unauthorized");
        }
      } else {
        const connection = yield* requireAuthorizedConnection({
          harness,
          connectionId,
          internalProviderId,
        });
        connectionLabel = connection.label;
      }
      const availableModel = yield* requireAvailableModel({
        harness,
        connectionId,
        installationId: activeInstallation.id,
        internalProviderId,
        modelId: modelSelection.model,
      });

      yield* Effect.logInfo("initial provider admission resolved exact route", {
        threadId: input.threadId,
        harness,
        requestedConnectionId: input.connectionId === undefined ? "omitted" : input.connectionId,
        connectionId,
        installationId: activeInstallation.id,
        modelId: modelSelection.model,
        folderId: thread.value.folderId,
      });

      const selection = {
        threadId: input.threadId,
        harness,
        connectionId,
        connectionLabel,
        previousConnectionId: null,
        previousModelId: null,
        previousInstallationId: null,
        installationId: activeInstallation.id,
        internalProviderId,
        modelId: modelSelection.model,
        modelLabel: availableModel.name,
        stateRevision: 0,
        bindingRevision: 0,
        changed: false,
        requiresNativeStateMaterialization: false,
      } satisfies ResolvedProviderTurnSelection;
      return {
        selection,
        initialization: {
          generation: {
            id: input.nativeStateGenerationId,
            ownerThreadId: input.threadId,
            harness,
            adapterSchemaVersion: "managed-native-state-v1",
            stateManifestJson: JSON.stringify({
              format: "managed-native-state-v1",
              initial: true,
            }),
            createdAt: input.createdAt,
          },
          threadId: input.threadId,
          providerSessionId: null,
          nativeStateLocatorJson: "null",
          connectionId,
          installationId: activeInstallation.id,
          internalProviderId,
          modelId: modelSelection.model,
          createdAt: input.createdAt,
        },
      };
    });

  const resolveExisting: ProviderTurnSelectionResolverShape["resolveExisting"] = (input) =>
    Effect.gen(function* () {
      const state = yield* threads.getHarnessState(input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderTurnSelectionResolutionError({
              detail: "Could not read the thread's native state.",
              cause,
            }),
        ),
      );
      const binding = yield* threads.getRuntimeBinding(input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderTurnSelectionResolutionError({
              detail: "Could not read the thread's runtime binding.",
              cause,
            }),
        ),
      );
      if (Option.isNone(state) || Option.isNone(binding)) {
        return yield* fail("This thread has no provider set.", "thread_binding_missing");
      }

      const manifest = getProviderConnectionManifest(state.value.harness);
      if (manifest === null) {
        return yield* fail("The thread harness has no enabled managed adapter.");
      }
      if (
        input.modelSelection !== undefined &&
        input.modelSelection.provider !== state.value.harness
      ) {
        return yield* fail(
          "This thread uses a different provider. To use another provider, start a new thread.",
          "provider_mismatch",
        );
      }

      const modelId = input.modelSelection?.model ?? binding.value.modelId;
      if (modelId === null) {
        return yield* fail("This thread has no model set.", "model_unavailable");
      }
      const internalProviderId = yield* internalProviderIdForModel(state.value.harness, modelId);
      const connectionId =
        input.connectionId === undefined ? binding.value.connectionId : input.connectionId;
      const selectionChanged =
        connectionId !== binding.value.connectionId ||
        internalProviderId !== binding.value.internalProviderId ||
        modelId !== binding.value.modelId;

      if (selectionChanged) {
        if (input.bindingRevision === undefined) {
          return yield* new ProviderTurnSelectionResolutionError({
            code: "binding_revision_required",
            detail:
              "Changing this thread's model or Connection needs its current settings version. Reload the thread and try again.",
            reason: "binding-revision-required",
          });
        }
        if (input.bindingRevision !== binding.value.revision) {
          return yield* new ProviderTurnSelectionResolutionError({
            code: "binding_revision_stale",
            detail:
              "This thread's model or Connection changed while the message was being sent. Check the thread's current settings and send again.",
            reason: "binding-revision-stale",
          });
        }
      } else if (
        input.bindingRevision !== undefined &&
        input.bindingRevision !== binding.value.revision
      ) {
        return yield* new ProviderTurnSelectionResolutionError({
          code: "binding_revision_stale",
          detail:
            "This thread's model or Connection changed while the message was being sent. Check the thread's current settings and send again.",
          reason: "binding-revision-stale",
        });
      }

      const installation = yield* installations.getRecord(binding.value.installationId).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderTurnSelectionResolutionError({
              detail: "Could not read the thread's managed installation.",
              cause,
            }),
        ),
      );
      if (
        Option.isNone(installation) ||
        (installation.value.lifecycle !== "active" && installation.value.lifecycle !== "retired") ||
        installation.value.harness !== state.value.harness
      ) {
        return yield* fail("The thread's exact managed installation is unavailable.");
      }
      // Existing threads stay on the exact installation that already owns their
      // native state. Provider updates are admitted for new threads; they do not
      // silently turn the next message on an old thread into a migration.
      const targetInstallation = selectionChanged
        ? yield* requireActiveInstallation(state.value.harness)
        : installation.value;
      const installationChanged = targetInstallation.id !== binding.value.installationId;
      const changed = selectionChanged || installationChanged;
      const requiresNativeStateMaterialization =
        connectionId !== binding.value.connectionId ||
        internalProviderId !== binding.value.internalProviderId ||
        (installationChanged && state.value.providerSessionId !== null);

      let connectionLabel: string | null = null;
      let claudeAccountTransition: ResolvedProviderTurnSelection["claudeAccountTransition"];
      if (connectionId === null) {
        if (!manifest.anonymous?.authorizesInternalProvider(internalProviderId)) {
          return yield* fail("This model needs a signed-in Connection.", "connection_unauthorized");
        }
      } else {
        const connection = yield* requireAuthorizedConnection({
          harness: state.value.harness,
          connectionId,
          internalProviderId,
        });
        connectionLabel = connection.label;
        if (state.value.harness === "claudeAgent") {
          // An ordinary resume must still use the recorded account. An explicit
          // revision-checked Connection change is carried into the switch saga,
          // which changes ownership only after the new binding commits.
          const recorded = yield* Effect.tryPromise({
            try: () => readClaudeThreadAccount(config.stateDir, input.threadId),
            catch: (cause) =>
              new ProviderTurnSelectionResolutionError({
                detail: "Could not read the Thread's Claude account.",
                cause,
              }),
          });
          const explicitConnectionSwitch =
            input.connectionId !== undefined &&
            connectionId !== binding.value.connectionId &&
            binding.value.connectionId !== null;
          if (recorded !== null && !claudeConnectionsShareAccount(recorded, connection)) {
            if (!explicitConnectionSwitch) {
              return yield* fail(
                "This thread's Claude conversation belongs to a different Claude account. Use a Connection signed in to that account, or start a new thread.",
                "connection_unauthorized",
              );
            }
            claudeAccountTransition = {
              source: recorded,
              target: {
                authenticationMethodId: connection.authenticationMethodId,
                providerIdentityId: connection.providerIdentityId,
              },
            };
          }
          if (explicitConnectionSwitch && recorded === null) {
            const previous = yield* connections.getRecord(binding.value.connectionId).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderTurnSelectionResolutionError({
                    detail: "Could not verify the Claude subscription account.",
                    cause,
                  }),
              ),
            );
            if (Option.isNone(previous)) {
              return yield* fail(
                "This thread's Claude conversation belongs to a different Claude account. Use a Connection signed in to that account, or start a new thread.",
                "connection_unauthorized",
              );
            }
            if (!claudeConnectionsShareAccount(previous.value, connection)) {
              claudeAccountTransition = {
                source: {
                  authenticationMethodId: previous.value.authenticationMethodId,
                  providerIdentityId: previous.value.providerIdentityId,
                },
                target: {
                  authenticationMethodId: connection.authenticationMethodId,
                  providerIdentityId: connection.providerIdentityId,
                },
              };
            }
          }
          if (recorded === null) {
            // For pre-upgrade Threads, verify the source Connection before
            // assigning ownership. A rejected switch must not claim the Thread.
            yield* Effect.tryPromise({
              try: () =>
                rememberClaudeThreadAccount({
                  stateDir: config.stateDir,
                  threadId: input.threadId,
                  account: {
                    authenticationMethodId:
                      claudeAccountTransition?.source.authenticationMethodId ??
                      connection.authenticationMethodId,
                    providerIdentityId:
                      claudeAccountTransition?.source.providerIdentityId ??
                      connection.providerIdentityId,
                  },
                }),
              catch: (cause) =>
                new ProviderTurnSelectionResolutionError({
                  detail: "Could not record the Thread's Claude account.",
                  cause,
                }),
            });
          }
        }
      }
      let modelLabel = modelId;
      if (changed) {
        const availableModel = yield* requireAvailableModel({
          harness: state.value.harness,
          connectionId,
          installationId: targetInstallation.id,
          internalProviderId,
          modelId,
        });
        modelLabel = availableModel.name;
      }

      return {
        threadId: input.threadId,
        harness: state.value.harness,
        connectionId,
        connectionLabel,
        previousConnectionId: binding.value.connectionId,
        previousModelId: binding.value.modelId,
        previousInstallationId: binding.value.installationId,
        installationId: targetInstallation.id,
        internalProviderId,
        modelId,
        modelLabel,
        stateRevision: state.value.revision,
        bindingRevision: binding.value.revision,
        changed,
        requiresNativeStateMaterialization,
        ...(claudeAccountTransition === undefined ? {} : { claudeAccountTransition }),
      };
    });

  return {
    resolveNewThreadConnection,
    resolveInitial,
    resolveExisting,
  } satisfies ProviderTurnSelectionResolverShape;
});

export const ProviderTurnSelectionResolverLive = Layer.effect(
  ProviderTurnSelectionResolver,
  makeProviderTurnSelectionResolver,
);
