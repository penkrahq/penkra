// FILE: ProviderTurnSelectionResolver.ts
// Purpose: Fail-closed resolution of existing thread Connection/model selections.

import { Effect, Layer, Option } from "effect";
import type { ProviderConnectionId, ProviderInstallationId } from "@penkra/contracts";

import { ServerConfig } from "../../config.ts";
import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import { ProviderInstallationRepository } from "../../persistence/Services/ProviderInstallations.ts";
import { readThreadNativeState } from "../../cleanCore/threadNativeState.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProviderCatalogService } from "../Services/ProviderCatalog.ts";
import {
  claudeAccountsMatch,
  readClaudeThreadAccount,
  rememberClaudeThreadAccount,
} from "../claudeThreadNativeState.ts";
import { parseOpenCodeModelSlug } from "../opencodeRuntime.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { resolveDefaultConnection } from "../defaultConnection.ts";
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
  const sql = yield* SqlClient.SqlClient;
  const providerCatalog = yield* ProviderCatalogService;
  const serverSettings = yield* ServerSettingsService;

  const requireAvailableModel = Effect.fnUntraced(function* (input: {
    readonly harness: Parameters<typeof getProviderConnectionManifest>[0];
    readonly connectionId: ProviderConnectionId | null;
    readonly installationId: ProviderInstallationId;
    readonly internalProviderId: string | null;
    readonly modelId: string;
  }) {
    const catalog = yield* providerCatalog
      .get({ provider: input.harness, connectionId: input.connectionId }, ["models"])
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderTurnSelectionResolutionError({
              detail: "Could not verify the selected model for this Connection.",
              cause,
            }),
        ),
      );
    if (catalog.error !== null && catalog.models === undefined)
      return yield* fail(
        "Could not verify the selected model for this Connection.",
        "selection_failed",
        catalog.error,
      );
    const selectedModel = catalog.models?.find((model) => model.slug === input.modelId);
    if (!selectedModel) {
      yield* Effect.logWarning("managed Connection model verification failed", {
        harness: input.harness,
        connectionId: input.connectionId,
        installationId: input.installationId,
        internalProviderId: input.internalProviderId,
        requestedModelId: input.modelId,
        availableModelIds: catalog.models?.map((model) => model.slug) ?? [],
        catalogVersion: catalog.version,
        catalogError: catalog.error,
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
    readonly connectionId: ProviderConnectionId;
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
    installations.getActiveRecord(harness).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderTurnSelectionResolutionError({
            detail: "Could not read managed provider installations.",
            cause,
          }),
      ),
      Effect.flatMap((installation) =>
        Option.isSome(installation)
          ? Effect.succeed(installation.value)
          : fail("No active managed installation exists for this harness."),
      ),
    );

  const authorizeAccount = Effect.fnUntraced(function* (
    input: Parameters<ProviderTurnSelectionResolverShape["authorizeConnection"]>[0],
  ) {
    const manifest = getProviderConnectionManifest(input.harness);
    if (manifest === null) return yield* fail("The thread harness has no enabled managed adapter.");
    if (input.modelSelection.provider !== input.harness) {
      return yield* fail(
        "This thread uses a different provider. To use another provider, start a new thread.",
        "provider_mismatch",
      );
    }
    const installation = yield* requireActiveInstallation(input.harness);
    const internalProviderId = yield* internalProviderIdForModel(
      input.harness,
      input.modelSelection.model,
    );
    if (input.connectionId === null) {
      if (!manifest.anonymous?.authorizesInternalProvider(internalProviderId))
        return yield* fail("This model needs a signed-in Connection.", "connection_unauthorized");
      return { installation, internalProviderId, connection: null };
    }
    const connection = yield* requireAuthorizedConnection({
      harness: input.harness,
      connectionId: input.connectionId,
      internalProviderId,
    });
    return { installation, internalProviderId, connection };
  });

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

  const resolveExisting: ProviderTurnSelectionResolverShape["resolveExisting"] = (input) =>
    Effect.gen(function* () {
      const state = yield* readThreadNativeState(input.threadId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(
          (cause) =>
            new ProviderTurnSelectionResolutionError({
              detail: "Could not read the thread's native state.",
              cause,
            }),
        ),
      );
      if (Option.isNone(state))
        return yield* fail("The thread does not exist.", "thread_binding_missing");

      const modelId = input.modelSelection?.model ?? state.value.model;
      const connectionId =
        input.connectionId === undefined ? state.value.connectionId : input.connectionId;
      const selectionChanged =
        connectionId !== state.value.connectionId || modelId !== state.value.model;

      const account = yield* authorizeAccount({
        harness: state.value.provider,
        modelSelection: input.modelSelection ?? { provider: state.value.provider, model: modelId },
        connectionId,
      });
      const targetInstallation = account.installation;
      const internalProviderId = account.internalProviderId;
      const changed = selectionChanged;
      const requiresNativeStateMaterialization =
        connectionId !== state.value.connectionId &&
        state.value.nativeStateId !== null &&
        state.value.providerSessionId !== null;

      let connectionLabel: string | null = null;
      if (account.connection !== null) {
        const connection = account.connection;
        connectionLabel = connection.label;
        if (
          state.value.provider === "claudeAgent" &&
          state.value.nativeStateId !== null &&
          state.value.providerSessionId !== null
        ) {
          const nativeStateId = state.value.nativeStateId;
          // An ordinary resume must still use the recorded account. An explicit
          // Connection change is committed with the copied native folder at admission.
          const recorded = yield* Effect.tryPromise({
            try: () => readClaudeThreadAccount(config.stateDir, nativeStateId),
            catch: (cause) =>
              new ProviderTurnSelectionResolutionError({
                detail: "Could not read the Thread's Claude account.",
                cause,
              }),
          });
          const explicitConnectionSwitch =
            input.connectionId !== undefined &&
            connectionId !== state.value.connectionId &&
            state.value.connectionId !== null;
          if (recorded !== null && !claudeConnectionsShareAccount(recorded, connection)) {
            if (!explicitConnectionSwitch) {
              return yield* fail(
                "This thread's Claude conversation belongs to a different Claude account. Use a Connection signed in to that account, or start a new thread.",
                "connection_unauthorized",
              );
            }
          }
          if (recorded === null && !explicitConnectionSwitch) {
            // For pre-upgrade Threads, verify the source Connection before
            // assigning ownership. A rejected switch must not claim the Thread.
            yield* Effect.tryPromise({
              try: () =>
                rememberClaudeThreadAccount({
                  stateDir: config.stateDir,
                  nativeStateId,
                  account: {
                    authenticationMethodId: connection.authenticationMethodId,
                    providerIdentityId: connection.providerIdentityId,
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
          harness: state.value.provider,
          connectionId,
          installationId: targetInstallation.id,
          internalProviderId,
          modelId,
        });
        modelLabel = availableModel.name;
      }

      return {
        threadId: input.threadId,
        harness: state.value.provider,
        connectionId,
        connectionLabel,
        previousConnectionId: state.value.connectionId,
        previousModelId: state.value.model,
        installationId: targetInstallation.id,
        internalProviderId,
        modelId,
        modelLabel,
        nativeStateId: state.value.nativeStateId,
        providerSessionId: state.value.providerSessionId,
        changed,
        requiresNativeStateMaterialization,
      };
    });

  return {
    authorizeConnection: (
      input: Parameters<ProviderTurnSelectionResolverShape["authorizeConnection"]>[0],
    ) => authorizeAccount(input).pipe(Effect.asVoid),
    resolveNewThreadConnection,
    resolveExisting,
  } satisfies ProviderTurnSelectionResolverShape;
});

export const ProviderTurnSelectionResolverLive = Layer.effect(
  ProviderTurnSelectionResolver,
  makeProviderTurnSelectionResolver,
);
