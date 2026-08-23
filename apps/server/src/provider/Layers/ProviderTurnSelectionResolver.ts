// FILE: ProviderTurnSelectionResolver.ts
// Purpose: Fail-closed resolution of existing thread Connection/model selections.

import { Effect, Layer, Option } from "effect";
import type { ProviderConnectionId, ProviderInstallationId } from "@penkra/contracts";

import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import { ProviderInstallationRepository } from "../../persistence/Services/ProviderInstallations.ts";
import { ThreadProviderBindingRepository } from "../../persistence/Services/ThreadProviderBindings.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderLaunchResolver } from "../Services/ProviderLaunchResolver.ts";
import { parseOpenCodeModelSlug } from "../opencodeRuntime.ts";
import {
  findConnectionAuthenticationMethod,
  findManagedLoginMethod,
  findStaticCredentialMethod,
  getProviderConnectionManifest,
} from "../providerConnectionManifests.ts";
import {
  ProviderTurnSelectionResolutionError,
  ProviderTurnSelectionResolver,
  type ResolvedProviderTurnSelection,
  type ProviderTurnSelectionResolverShape,
} from "../Services/ProviderTurnSelectionResolver.ts";

const fail = (detail: string, cause?: unknown) =>
  Effect.fail(
    new ProviderTurnSelectionResolutionError({
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
      ? fail("The OpenCode model must include its exact internal provider ID.")
      : Effect.succeed(parsed.providerID);
  }
  return Effect.succeed(null);
}

export const makeProviderTurnSelectionResolver = Effect.gen(function* () {
  const connections = yield* ProviderConnectionRepository;
  const installations = yield* ProviderInstallationRepository;
  const threads = yield* ThreadProviderBindingRepository;
  const projections = yield* ProjectionSnapshotQuery;
  const registry = yield* ProviderAdapterRegistry;
  const launchResolver = yield* ProviderLaunchResolver;

  const requireAvailableModel = Effect.fnUntraced(function* (input: {
    readonly harness: Parameters<typeof getProviderConnectionManifest>[0];
    readonly connectionId: ProviderConnectionId | null;
    readonly installationId: ProviderInstallationId;
    readonly internalProviderId: string | null;
    readonly modelId: string;
    readonly nativeStateIdentity: string;
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
        nativeStateIdentity: input.nativeStateIdentity,
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
      return yield* fail("The selected model is unavailable for this Connection.");
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
    if (
      Option.isNone(connection) ||
      connection.value.lifecycle !== "active" ||
      connection.value.harness !== input.harness
    ) {
      return yield* fail("The selected Connection is unavailable for this thread.");
    }
    const method = findConnectionAuthenticationMethod(connection.value);
    if (method === null || !method.authorizesInternalProvider(input.internalProviderId)) {
      return yield* fail("The selected Connection cannot authorize this model route.");
    }
    if (
      (findStaticCredentialMethod(connection.value) !== null &&
        (connection.value.credentialRef === null || connection.value.profileRef !== null)) ||
      (findManagedLoginMethod(connection.value) !== null &&
        (connection.value.credentialRef !== null || connection.value.profileRef === null))
    ) {
      return yield* fail("The selected Connection credential backend is incompatible.");
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
        const selected = yield* connections.list().pipe(
          Effect.mapError(
            (cause) =>
              new ProviderTurnSelectionResolutionError({
                detail: "Could not read available Connections.",
                cause,
              }),
          ),
          Effect.map((entries) => {
            const connection = entries.find((entry) => {
              if (entry.harness !== harness || entry.lifecycle !== "active") return false;
              const method = findConnectionAuthenticationMethod(entry);
              return method?.authorizesInternalProvider(internalProviderId) === true;
            });
            return connection ? { connectionId: connection.id } : undefined;
          }),
        );
        if (selected) {
          const selectedConnection = yield* connections.getRecord(selected.connectionId).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderTurnSelectionResolutionError({
                  detail: "Could not read the selected Connection.",
                  cause,
                }),
            ),
          );
          const selectedMethod = Option.isSome(selectedConnection)
            ? findConnectionAuthenticationMethod(selectedConnection.value)
            : null;
          if (
            Option.isSome(selectedConnection) &&
            selectedConnection.value.lifecycle === "active" &&
            selectedConnection.value.harness === harness &&
            selectedMethod?.authorizesInternalProvider(internalProviderId) === true
          ) {
            yield* requireAuthorizedConnection({
              harness,
              connectionId: selected.connectionId,
              internalProviderId,
            });
            return selected.connectionId;
          }
          if (manifest.anonymous?.authorizesInternalProvider(internalProviderId)) return null;
          return yield* fail("The selected Connection cannot authorize this model route.");
        }
        if (manifest.anonymous?.authorizesInternalProvider(internalProviderId)) return null;
        return yield* fail(`No compatible Connection is available for this harness.`);
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
        return yield* fail("The first message cannot change the thread's provider harness.");
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
          return yield* fail("The selected model route requires a Connection.");
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
        nativeStateIdentity: input.nativeStateGenerationId,
      });

      yield* Effect.logInfo("initial provider admission resolved exact route", {
        threadId: input.threadId,
        harness,
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
        return yield* fail("The thread has no committed provider binding.");
      }

      const manifest = getProviderConnectionManifest(state.value.harness);
      if (manifest === null) {
        return yield* fail("The thread harness has no enabled managed adapter.");
      }
      if (
        input.modelSelection !== undefined &&
        input.modelSelection.provider !== state.value.harness
      ) {
        return yield* fail("A started thread cannot change its provider harness.");
      }

      const modelId = input.modelSelection?.model ?? binding.value.modelId;
      if (modelId === null) {
        return yield* fail("The thread has no exact model binding.");
      }
      const internalProviderId = yield* internalProviderIdForModel(state.value.harness, modelId);
      const connectionId =
        input.connectionId === undefined ? binding.value.connectionId : input.connectionId;
      const selectionChanged =
        connectionId !== binding.value.connectionId ||
        internalProviderId !== binding.value.internalProviderId ||
        modelId !== binding.value.modelId;
      const activeInstallation = yield* requireActiveInstallation(state.value.harness);
      const installationChanged = activeInstallation.id !== binding.value.installationId;
      const changed = selectionChanged || installationChanged;
      const requiresNativeStateMaterialization =
        connectionId !== binding.value.connectionId ||
        internalProviderId !== binding.value.internalProviderId ||
        (installationChanged && state.value.providerSessionId !== null);

      if (selectionChanged) {
        if (input.bindingRevision === undefined) {
          return yield* new ProviderTurnSelectionResolutionError({
            detail: "Changing a thread selection requires its exact binding revision.",
            reason: "binding-revision-required",
          });
        }
        if (input.bindingRevision !== binding.value.revision) {
          return yield* new ProviderTurnSelectionResolutionError({
            detail: "The thread binding changed before this selection was accepted.",
            reason: "binding-revision-stale",
          });
        }
      } else if (
        input.bindingRevision !== undefined &&
        input.bindingRevision !== binding.value.revision
      ) {
        return yield* new ProviderTurnSelectionResolutionError({
          detail: "The supplied thread binding revision is stale.",
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

      let connectionLabel: string | null = null;
      if (connectionId === null) {
        if (!manifest.anonymous?.authorizesInternalProvider(internalProviderId)) {
          return yield* fail("The selected model route requires a Connection.");
        }
      } else {
        const connection = yield* requireAuthorizedConnection({
          harness: state.value.harness,
          connectionId,
          internalProviderId,
        });
        connectionLabel = connection.label;
      }
      let modelLabel = modelId;
      if (changed) {
        const availableModel = yield* requireAvailableModel({
          harness: state.value.harness,
          connectionId,
          installationId: activeInstallation.id,
          internalProviderId,
          modelId,
          nativeStateIdentity: state.value.nativeStateGenerationId,
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
        installationId: activeInstallation.id,
        internalProviderId,
        modelId,
        modelLabel,
        stateRevision: state.value.revision,
        bindingRevision: binding.value.revision,
        changed,
        requiresNativeStateMaterialization,
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
