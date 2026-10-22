import { ConnectionRateLimitsLive } from "../providerUsage/ConnectionRateLimits.ts";
import { ProviderAuthCircuitsLive } from "./providerAuthCircuit.ts";
import { Effect, Layer } from "effect";

import { AgentGatewayCredentialsWithSecretsLive } from "../agentGateway/Layers/AgentGatewayCredentials";
import { ServerConfig } from "../config";
import { ServerSettingsLive } from "../serverSettings";
import { makeClaudeAdapterLive } from "./Layers/ClaudeAdapter";
import { makeCodexAdapterLive } from "./Layers/CodexAdapter";
import { makeEventNdjsonLogger } from "./Layers/EventNdjsonLogger";
import { makeOpenCodeAdapterLive } from "./Layers/OpenCodeAdapter";
import { ProviderAdapterRegistryLive } from "./Layers/ProviderAdapterRegistry";
import { ProviderDiscoveryServiceLive } from "./Layers/ProviderDiscoveryService";
import { ProviderCatalogLive } from "./Layers/ProviderCatalog.ts";
import { makeManagedProviderServiceLive } from "./Layers/ProviderService";
import { ProviderSessionDirectoryLive } from "./Layers/ProviderSessionDirectory";
import { ProviderConnectionRepositoryLive } from "../persistence/Layers/ProviderConnections";
import { ProviderInstallationRepositoryLive } from "../persistence/Layers/ProviderInstallations";
import { ProviderCredentialBrokerLive } from "./providerCredentialBroker";
import { ProviderLaunchResolverLive } from "./Layers/ProviderLaunchResolver";

export function makeServerProviderLayer(
  options: {
    readonly agentGatewayCredentialsLayer?: typeof AgentGatewayCredentialsWithSecretsLive;
  } = {},
) {
  return Effect.gen(function* () {
    const { logProviderEvents, providerEventLogPath } = yield* ServerConfig;
    const nativeEventLogger = logProviderEvents
      ? yield* makeEventNdjsonLogger(providerEventLogPath, {
          stream: "native",
        })
      : undefined;
    const canonicalEventLogger = logProviderEvents
      ? yield* makeEventNdjsonLogger(providerEventLogPath, {
          stream: "canonical",
        })
      : undefined;
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive;
    // Share the gateway registry across native adapters and HTTP ingress.
    const agentGatewayCredentialsLayer =
      options.agentGatewayCredentialsLayer ?? AgentGatewayCredentialsWithSecretsLive;
    const codexAdapterLayer = makeCodexAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    ).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const claudeAdapterLayer = makeClaudeAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    ).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const openCodeAdapterLayer = makeOpenCodeAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : {},
    ).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const adapterRegistryLayer = ProviderAdapterRegistryLive.pipe(
      Layer.provide(codexAdapterLayer),
      Layer.provide(claudeAdapterLayer),
      Layer.provide(openCodeAdapterLayer),
      Layer.provideMerge(providerSessionDirectoryLayer),
    );
    const providerServiceLayer = makeManagedProviderServiceLive(
      canonicalEventLogger ? { canonicalEventLogger } : undefined,
    ).pipe(
      Layer.provide(ConnectionRateLimitsLive),
      Layer.provide(ProviderAuthCircuitsLive),
      Layer.provide(adapterRegistryLayer),
      Layer.provide(agentGatewayCredentialsLayer),
      Layer.provide(providerSessionDirectoryLayer),
      Layer.provide(
        ProviderLaunchResolverLive.pipe(
          Layer.provideMerge(ProviderConnectionRepositoryLive),
          Layer.provideMerge(ProviderInstallationRepositoryLive),
          Layer.provideMerge(ProviderCredentialBrokerLive),
        ),
      ),
    );
    const providerCatalogLayer = ProviderCatalogLive.pipe(
      Layer.provide(adapterRegistryLayer),
      Layer.provide(ProviderConnectionRepositoryLive),
      Layer.provide(ProviderInstallationRepositoryLive),
      Layer.provide(
        ProviderLaunchResolverLive.pipe(
          Layer.provideMerge(ProviderConnectionRepositoryLive),
          Layer.provideMerge(ProviderInstallationRepositoryLive),
          Layer.provideMerge(ProviderCredentialBrokerLive),
        ),
      ),
      Layer.provide(ServerSettingsLive),
    );
    const providerDiscoveryLayer = ProviderDiscoveryServiceLive.pipe(
      Layer.provide(adapterRegistryLayer),
      Layer.provide(providerCatalogLayer),
      Layer.provide(ProviderConnectionRepositoryLive),
      Layer.provide(ProviderInstallationRepositoryLive),
      Layer.provide(
        ProviderLaunchResolverLive.pipe(
          Layer.provideMerge(ProviderConnectionRepositoryLive),
          Layer.provideMerge(ProviderInstallationRepositoryLive),
          Layer.provideMerge(ProviderCredentialBrokerLive),
        ),
      ),
      // Skill toggles live in server settings; the shared ServerSettingsLive
      // layer is memoized so this reuses the instance built at the top level.
      Layer.provide(ServerSettingsLive),
    );
    return Layer.mergeAll(
      providerServiceLayer,
      providerDiscoveryLayer,
      providerCatalogLayer,
      adapterRegistryLayer,
      providerSessionDirectoryLayer,
    );
  }).pipe(Layer.unwrap);
}
