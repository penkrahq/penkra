import {
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  type ProviderConnectionId,
  type ProviderComposerCapabilities,
  ProviderGetCapabilityHealthInput,
  ProviderGetComposerCapabilitiesInput,
  ProviderListAgentsInput,
  ProviderListCommandsInput,
  ProviderListModelsInput,
  ProviderListPluginsInput,
  ProviderListSkillsInput,
  type ProviderListSkillsResult,
  ProviderReadPluginInput,
  type ProviderSkillDescriptor,
} from "@penkra/contracts";
import { Effect, Layer, Schema, SchemaIssue } from "effect";

import { ServerConfig } from "../../config.ts";
import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import { ProviderInstallationRepository } from "../../persistence/Services/ProviderInstallations.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { discoverEnabledAppSkills } from "../../appSkillsCatalog.ts";
import { ProviderValidationError } from "../Errors.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderLaunchResolver } from "../Services/ProviderLaunchResolver.ts";
import {
  ProviderDiscoveryService,
  type ProviderDiscoveryServiceShape,
} from "../Services/ProviderDiscoveryService.ts";
import {
  discoverSkillsCatalog,
  filterDisabledSkills,
  mergeSkillsIntoCatalog,
} from "../skillsCatalog.ts";
import {
  findConnectionAuthenticationMethod,
  getProviderConnectionManifest,
} from "../providerConnectionManifests.ts";

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) =>
  Schema.decodeUnknownEffect(input.schema)(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );

const discoveryInfrastructureError = (operation: string) => (cause: unknown) =>
  new ProviderValidationError({
    operation,
    issue: "Managed provider discovery is temporarily unavailable.",
    cause,
  });

const disabledCapabilitiesForProvider = (
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
  supportsThreadFork: false,
  supportsThreadImport: false,
});

const make = Effect.gen(function* () {
  const registry = yield* ProviderAdapterRegistry;
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const connections = yield* ProviderConnectionRepository;
  const installations = yield* ProviderInstallationRepository;
  const launchResolver = yield* ProviderLaunchResolver;

  const getComposerCapabilities: ProviderDiscoveryServiceShape["getComposerCapabilities"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.getComposerCapabilities",
        schema: ProviderGetComposerCapabilitiesInput,
        payload: input,
      });
      const adapter = yield* registry.getByProvider(parsed.provider);
      const capabilities = adapter.getComposerCapabilities
        ? yield* adapter.getComposerCapabilities()
        : disabledCapabilitiesForProvider(parsed.provider);
      // The unified Penkra skills catalog backs skill discovery for every
      // provider, including ones without native skill support.
      return {
        ...capabilities,
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
      };
    });

  const getCapabilityHealth: ProviderDiscoveryServiceShape["getCapabilityHealth"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.getCapabilityHealth",
        schema: ProviderGetCapabilityHealthInput,
        payload: input,
      });
      const adapter = yield* registry.getByProvider(parsed.provider);
      if (!adapter.getCapabilityHealth) {
        return { capabilities: [], source: "unsupported" };
      }
      if (!(yield* adapter.hasSession(ThreadId.makeUnsafe(parsed.threadId)))) {
        return { capabilities: [], source: "no-active-session" };
      }
      return yield* adapter.getCapabilityHealth(parsed);
    });

  const listSkills: ProviderDiscoveryServiceShape["listSkills"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.listSkills",
        schema: ProviderListSkillsInput,
        payload: input,
      });
      const adapter = yield* registry.getByProvider(parsed.provider);
      const manifest = getProviderConnectionManifest(parsed.provider);
      const hasExactLiveThread =
        parsed.threadId !== undefined &&
        (yield* adapter.hasSession(ThreadId.makeUnsafe(parsed.threadId)));
      const nativeResult: ProviderListSkillsResult | null =
        adapter.listSkills && (!manifest || hasExactLiveThread)
          ? yield* adapter
              .listSkills(parsed)
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning(
                    "provider-native skill discovery failed; serving the Penkra skills catalog only",
                    { provider: parsed.provider, error },
                  ).pipe(Effect.as(null)),
                ),
              )
          : null;
      const catalogSkills = yield* Effect.tryPromise(() =>
        discoverSkillsCatalog({
          cwd: parsed.cwd,
          homeDir: serverConfig.homeDir,
          penkraBaseDir: serverConfig.baseDir,
          provider: parsed.provider,
          ...(parsed.forceReload !== undefined ? { forceReload: parsed.forceReload } : {}),
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("penkra skills catalog discovery failed", {
            provider: parsed.provider,
            cause,
          }).pipe(Effect.as([] as ProviderSkillDescriptor[])),
        ),
      );
      const spaceId = parsed.spaceId;
      const appSkills = spaceId
        ? yield* Effect.tryPromise(() => discoverEnabledAppSkills(spaceId)).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("App skill discovery failed; serving filesystem skills only", {
                spaceId,
                cause,
              }).pipe(Effect.as([] as ProviderSkillDescriptor[])),
            ),
          )
        : [];
      const merged = mergeSkillsIntoCatalog({
        native: nativeResult?.skills ?? [],
        catalog: [...catalogSkills, ...appSkills],
      });
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
      );
      return {
        skills: filterDisabledSkills(merged, settings.skills.disabled),
        source: nativeResult?.source
          ? `${nativeResult.source}+penkra.catalog${appSkills.length > 0 ? "+penkra.apps" : ""}`
          : `penkra.catalog${appSkills.length > 0 ? "+penkra.apps" : ""}`,
        cached: nativeResult?.cached ?? false,
      } satisfies ProviderListSkillsResult;
    });

  const listCommands: ProviderDiscoveryServiceShape["listCommands"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.listCommands",
        schema: ProviderListCommandsInput,
        payload: input,
      });
      const adapter = yield* registry.getByProvider(parsed.provider);
      if (!adapter.listCommands) {
        return {
          commands: [],
          source: "unsupported",
          cached: false,
        };
      }
      if (
        getProviderConnectionManifest(parsed.provider) &&
        (parsed.threadId === undefined ||
          !(yield* adapter.hasSession(ThreadId.makeUnsafe(parsed.threadId))))
      ) {
        return { commands: [], source: "no-active-managed-session", cached: false };
      }
      return yield* adapter.listCommands(parsed);
    });

  const listPlugins: ProviderDiscoveryServiceShape["listPlugins"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.listPlugins",
        schema: ProviderListPluginsInput,
        payload: input,
      });
      const adapter = yield* registry.getByProvider(parsed.provider);
      if (!adapter.listPlugins) {
        return {
          marketplaces: [],
          marketplaceLoadErrors: [],
          remoteSyncError: null,
          featuredPluginIds: [],
          source: "unsupported",
          cached: false,
        };
      }
      if (
        getProviderConnectionManifest(parsed.provider) &&
        (parsed.threadId === undefined ||
          !(yield* adapter.hasSession(ThreadId.makeUnsafe(parsed.threadId))))
      ) {
        return {
          marketplaces: [],
          marketplaceLoadErrors: [],
          remoteSyncError: null,
          featuredPluginIds: [],
          source: "no-active-managed-session",
          cached: false,
        };
      }
      return yield* adapter.listPlugins(parsed);
    });

  const readPlugin: ProviderDiscoveryServiceShape["readPlugin"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.readPlugin",
        schema: ProviderReadPluginInput,
        payload: input,
      });
      const adapter = yield* registry.getByProvider(parsed.provider);
      if (!adapter.readPlugin) {
        return yield* new ProviderValidationError({
          operation: "ProviderDiscoveryService.readPlugin",
          issue: `Plugin discovery is unavailable for provider '${parsed.provider}'.`,
        });
      }
      if (
        getProviderConnectionManifest(parsed.provider) &&
        (parsed.threadId === undefined ||
          !(yield* adapter.hasSession(ThreadId.makeUnsafe(parsed.threadId))))
      ) {
        return yield* new ProviderValidationError({
          operation: "ProviderDiscoveryService.readPlugin",
          issue: "Plugin details require the thread's exact active Connection session.",
        });
      }
      return yield* adapter.readPlugin(parsed);
    });

  const listModels: ProviderDiscoveryServiceShape["listModels"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.listModels",
        schema: ProviderListModelsInput,
        payload: input,
      });
      const manifest = getProviderConnectionManifest(parsed.provider);
      // The enabled check is a short-circuit, not a precondition, and
      // ServerSettingsError is outside this operation's error channel. An
      // unreadable settings file falls back to discovering models, which is
      // what this call did before the gate existed.
      if (!manifest) {
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (settings !== null && !settings.providers[parsed.provider].enabled) {
          return {
            models: [],
            source: "disabled",
            cached: false,
          };
        }
      }
      const adapter = yield* registry.getByProvider(parsed.provider);
      if (!adapter.listModels) {
        return {
          models: [],
          source: "unsupported",
          cached: false,
        };
      }
      if (!manifest) return yield* adapter.listModels(parsed);

      const installation = (yield* installations
        .list()
        .pipe(
          Effect.mapError(discoveryInfrastructureError("ProviderDiscoveryService.listModels")),
        )).find(
        (candidate) => candidate.harness === parsed.provider && candidate.lifecycle === "active",
      );
      if (!installation) {
        return { models: [], source: "managed-installation-unavailable", cached: false };
      }
      const activeConnections = (yield* connections
        .list()
        .pipe(
          Effect.mapError(discoveryInfrastructureError("ProviderDiscoveryService.listModels")),
        )).filter(
        (connection) => connection.harness === parsed.provider && connection.lifecycle === "active",
      );
      const routes: Array<{
        connectionId: ProviderConnectionId | null;
        internalProviderId: string | null;
      }> = activeConnections.flatMap((connection) => {
        const method = findConnectionAuthenticationMethod(connection);
        if (!method) return [];
        return method.internalProviderIds.map((internalProviderId) => ({
          connectionId: connection.id,
          internalProviderId,
        }));
      });
      for (const internalProviderId of manifest.anonymous?.internalProviderIds ?? []) {
        routes.push({ connectionId: null, internalProviderId });
      }
      const results = yield* Effect.forEach(
        routes,
        (route) =>
          launchResolver
            .resolveProfile({
              harness: parsed.provider,
              connectionId: route.connectionId,
              installationId: installation.id,
              internalProviderId: route.internalProviderId,
              nativeStateIdentity: `discovery:${parsed.provider}:${route.connectionId ?? "anonymous"}`,
            })
            .pipe(
              Effect.mapError(discoveryInfrastructureError("ProviderDiscoveryService.listModels")),
              Effect.flatMap((managedLaunch) =>
                adapter.listModels!({
                  ...parsed,
                  managedLaunch,
                  internalProviderId: route.internalProviderId,
                }),
              ),
              Effect.map((result) => ({ route, result })),
              Effect.catch((cause) =>
                Effect.logWarning("Managed model discovery failed for one Connection route").pipe(
                  Effect.annotateLogs({
                    provider: parsed.provider,
                    connectionId: route.connectionId ?? "anonymous",
                    internalProviderId: route.internalProviderId ?? "first-party",
                    cause,
                  }),
                  Effect.as(null),
                ),
              ),
            ),
        { concurrency: 1 },
      );
      const models = new Map<
        string,
        {
          model: NonNullable<(typeof results)[number]>["result"]["models"][number];
          connectionIds: Set<(typeof routes)[number]["connectionId"]>;
        }
      >();
      for (const entry of results) {
        if (entry === null) continue;
        for (const model of entry.result.models) {
          const key = `${model.upstreamProviderId ?? ""}\u0000${model.slug}`;
          const existing = models.get(key);
          if (existing) {
            existing.connectionIds.add(entry.route.connectionId);
          } else {
            models.set(key, {
              model,
              connectionIds: new Set([entry.route.connectionId]),
            });
          }
        }
      }
      return {
        models: [...models.values()].map(({ model, connectionIds }) => ({
          ...model,
          availableConnectionIds: [...connectionIds],
        })),
        source: "managed-connections",
        cached:
          results.length > 0 &&
          results.every((entry) => entry === null || entry.result.cached === true),
      };
    });

  const listAgents: ProviderDiscoveryServiceShape["listAgents"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.listAgents",
        schema: ProviderListAgentsInput,
        payload: input,
      });
      const adapter = yield* registry.getByProvider(parsed.provider);
      if (!adapter.listAgents) {
        return {
          agents: [],
          source: "unsupported",
          cached: false,
        };
      }
      const manifest = getProviderConnectionManifest(parsed.provider);
      if (!manifest) return yield* adapter.listAgents(parsed);

      const installation = (yield* installations
        .list()
        .pipe(
          Effect.mapError(discoveryInfrastructureError("ProviderDiscoveryService.listAgents")),
        )).find(
        (candidate) => candidate.harness === parsed.provider && candidate.lifecycle === "active",
      );
      if (!installation) return { agents: [], source: "managed-installation-unavailable" };

      const activeConnections = (yield* connections
        .list()
        .pipe(
          Effect.mapError(discoveryInfrastructureError("ProviderDiscoveryService.listAgents")),
        )).filter(
        (connection) => connection.harness === parsed.provider && connection.lifecycle === "active",
      );
      const routes: Array<{
        connectionId: ProviderConnectionId | null;
        internalProviderId: string | null;
      }> = activeConnections.flatMap((connection) => {
        const method = findConnectionAuthenticationMethod(connection);
        if (!method) return [];
        return method.internalProviderIds.map((internalProviderId) => ({
          connectionId: connection.id,
          internalProviderId,
        }));
      });
      for (const internalProviderId of manifest.anonymous?.internalProviderIds ?? []) {
        routes.push({ connectionId: null, internalProviderId });
      }
      const results = yield* Effect.forEach(
        routes,
        (route) =>
          launchResolver
            .resolveProfile({
              harness: parsed.provider,
              connectionId: route.connectionId,
              installationId: installation.id,
              internalProviderId: route.internalProviderId,
              nativeStateIdentity: `agent-discovery:${parsed.provider}:${route.connectionId ?? "anonymous"}`,
            })
            .pipe(
              Effect.mapError(discoveryInfrastructureError("ProviderDiscoveryService.listAgents")),
              Effect.flatMap((managedLaunch) =>
                adapter.listAgents!({
                  ...parsed,
                  managedLaunch,
                  internalProviderId: route.internalProviderId,
                }),
              ),
              Effect.map((result) => ({ route, result })),
              Effect.catch((cause) =>
                Effect.logWarning("Managed agent discovery failed for one Connection route").pipe(
                  Effect.annotateLogs({
                    provider: parsed.provider,
                    connectionId: route.connectionId ?? "anonymous",
                    internalProviderId: route.internalProviderId ?? "first-party",
                    cause,
                  }),
                  Effect.as(null),
                ),
              ),
            ),
        { concurrency: 1 },
      );
      const agents = new Map<
        string,
        {
          agent: NonNullable<(typeof results)[number]>["result"]["agents"][number];
          connectionIds: Set<ProviderConnectionId | null>;
        }
      >();
      for (const entry of results) {
        if (entry === null) continue;
        for (const agent of entry.result.agents) {
          const key = `${agent.name}\u0000${agent.model ?? ""}`;
          const existing = agents.get(key);
          if (existing) existing.connectionIds.add(entry.route.connectionId);
          else {
            agents.set(key, {
              agent,
              connectionIds: new Set([entry.route.connectionId]),
            });
          }
        }
      }
      return {
        agents: [...agents.values()].map(({ agent, connectionIds }) => ({
          ...agent,
          availableConnectionIds: [...connectionIds],
        })),
        source: "managed-connections",
        cached:
          results.length > 0 &&
          results.every((entry) => entry === null || entry.result.cached === true),
      };
    });

  return {
    getCapabilityHealth,
    getComposerCapabilities,
    listCommands,
    listSkills,
    listPlugins,
    readPlugin,
    listModels,
    listAgents,
  } satisfies ProviderDiscoveryServiceShape;
});

export const ProviderDiscoveryServiceLive = Layer.effect(ProviderDiscoveryService, make);
