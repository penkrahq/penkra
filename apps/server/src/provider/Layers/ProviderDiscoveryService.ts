import {
  ThreadId,
  type ProviderComposerCapabilities,
  ProviderGetCapabilityHealthInput,
  ProviderGetComposerCapabilitiesInput,
  ProviderListModelsInput,
} from "@penkra/contracts";
import { Effect, Layer, Schema, SchemaIssue } from "effect";
import { filterProviderModelsForPicker } from "@penkra/shared/providerModelPresentation";
import { ServerConfig } from "../../config.ts";
import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import { ProviderInstallationRepository } from "../../persistence/Services/ProviderInstallations.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderValidationError } from "../Errors.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderLaunchResolver } from "../Services/ProviderLaunchResolver.ts";
import { ProviderCatalogService } from "../Services/ProviderCatalog.ts";
import {
  ProviderDiscoveryService,
  type ProviderDiscoveryServiceShape,
} from "../Services/ProviderDiscoveryService.ts";
import { providerModelDiscoveryStateIdentity } from "../providerDiscoveryStateIdentity.ts";
import { selectConnectivityProbeModel } from "../connectivityProbeModel.ts";
import { resolveDefaultConnection } from "../defaultConnection.ts";

const decodeInput = <S extends Schema.Top>(operation: string, schema: S, payload: unknown) =>
  Schema.decodeUnknownEffect(schema)(payload).pipe(
    Effect.mapError(
      (error) =>
        new ProviderValidationError({
          operation,
          issue: SchemaIssue.makeFormatterDefault()(error.issue),
          cause: error,
        }),
    ),
  );
const infrastructureError = (operation: string) => (cause: unknown) =>
  new ProviderValidationError({
    operation,
    issue: "Managed provider discovery is temporarily unavailable.",
    cause,
  });

const disabledCapabilities = (
  provider: ProviderComposerCapabilities["provider"],
): ProviderComposerCapabilities => ({
  provider,
  supportsSkillMentions: false,
  supportsSkillDiscovery: false,
  supportsNativeSlashCommandDiscovery: false,
  supportsPluginMentions: false,
  supportsPluginDiscovery: false,
  supportsRuntimeModelList: false,
  supportsThreadCompaction: false,
  supportsThreadImport: false,
});

const make = Effect.gen(function* () {
  const registry = yield* ProviderAdapterRegistry;
  const config = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  const connections = yield* ProviderConnectionRepository;
  const installations = yield* ProviderInstallationRepository;
  const resolver = yield* ProviderLaunchResolver;
  const catalogs = yield* ProviderCatalogService;

  const getComposerCapabilities: ProviderDiscoveryServiceShape["getComposerCapabilities"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInput(
        "ProviderDiscoveryService.getComposerCapabilities",
        ProviderGetComposerCapabilitiesInput,
        input,
      );
      const adapter = yield* registry.getByProvider(parsed.provider);
      const capabilities = adapter.getComposerCapabilities
        ? yield* adapter.getComposerCapabilities()
        : disabledCapabilities(parsed.provider);
      return { ...capabilities, supportsSkillMentions: true, supportsSkillDiscovery: true };
    });

  const getCapabilityHealth: ProviderDiscoveryServiceShape["getCapabilityHealth"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInput(
        "ProviderDiscoveryService.getCapabilityHealth",
        ProviderGetCapabilityHealthInput,
        input,
      );
      const adapter = yield* registry.getByProvider(parsed.provider);
      if (!adapter.getCapabilityHealth) return { capabilities: [], source: "unsupported" };
      if (!(yield* adapter.hasSession(ThreadId.make(parsed.threadId))))
        return { capabilities: [], source: "no-active-session" };
      return yield* adapter.getCapabilityHealth(parsed);
    });

  // The gateway's model-list operation formats the shared catalog; it never calls an adapter.
  const listModels: ProviderDiscoveryServiceShape["listModels"] = (input) =>
    Effect.gen(function* () {
      const operation = "ProviderDiscoveryService.listModels";
      const parsed = yield* decodeInput(operation, ProviderListModelsInput, input);
      const currentSettings = yield* settings.getSettings.pipe(
        Effect.mapError(infrastructureError(operation)),
      );
      const activeConnections = yield* connections
        .list()
        .pipe(Effect.mapError(infrastructureError(operation)));
      const connectionId = yield* Effect.try({
        try: () =>
          resolveDefaultConnection({
            provider: parsed.provider,
            ...(parsed.connectionId === undefined ? {} : { connectionId: parsed.connectionId }),
            settings: currentSettings,
            connections: activeConnections,
          }),
        catch: infrastructureError(operation),
      });
      const snapshot = yield* catalogs
        .get({ provider: parsed.provider, connectionId }, ["models"])
        .pipe(Effect.mapError(infrastructureError(operation)));
      if (snapshot.error !== null && snapshot.models === undefined)
        return yield* new ProviderValidationError({ operation, issue: snapshot.error });
      const catalog = {
        models: (snapshot.models ?? []).filter(
          (model) =>
            parsed.internalProviderId === undefined ||
            (model.upstreamProviderId ?? null) === parsed.internalProviderId,
        ),
        source: "provider-catalog",
        cached: true,
      };
      return parsed.presentation === "picker"
        ? filterProviderModelsForPicker(parsed.provider, catalog)
        : catalog;
    });

  const probeConnection: ProviderDiscoveryServiceShape["probeConnection"] = (input) =>
    Effect.gen(function* () {
      const adapter = yield* registry.getByProvider(input.provider);
      if (!adapter.probeTurnEndpoint) return false;
      const operation = "ProviderDiscoveryService.probeConnection";
      const installation = (yield* installations
        .list()
        .pipe(Effect.mapError(infrastructureError(operation)))).find(
        (candidate) => candidate.harness === input.provider && candidate.lifecycle === "active",
      );
      if (!installation) return false;
      const catalog = yield* listModels({
        provider: input.provider,
        connectionId: input.connectionId,
      });
      const selected = selectConnectivityProbeModel({
        models: catalog.models,
        connectionId: input.connectionId,
      });
      if (!selected) return false;
      const launch = yield* resolver
        .resolveProfile({
          harness: input.provider,
          connectionId: input.connectionId,
          installationId: installation.id,
          internalProviderId:
            input.provider === "opencode" ? selected.model.split("/", 1)[0]! : null,
          nativeStateIdentity: providerModelDiscoveryStateIdentity({
            provider: input.provider,
            connectionId: input.connectionId,
          }),
        })
        .pipe(Effect.mapError(infrastructureError(operation)));
      return yield* adapter.probeTurnEndpoint({
        cwd: config.stateDir,
        managedLaunch: launch,
        ...selected,
      });
    });

  return {
    probeConnection,
    getCapabilityHealth,
    getComposerCapabilities,
    listModels,
  } satisfies ProviderDiscoveryServiceShape;
});

export const ProviderDiscoveryServiceLive = Layer.effect(ProviderDiscoveryService, make);
