import { TurnDispatchLive } from "./cleanCore/turnDispatch.ts";
import { ProviderAuthCircuitsLive } from "./provider/providerAuthCircuit.ts";
import { ThreadLifecycleLive } from "./cleanCore/threadLifecycle.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Layer } from "effect";

import { ThreadSenderLive } from "./cleanCore/ThreadSender.ts";
import { AgentGatewayLive } from "./agentGateway/Layers/AgentGateway";
import { AgentGatewayCredentialsWithSecretsLive } from "./agentGateway/Layers/AgentGatewayCredentials";
import { ThreadReadsLive } from "./cleanCore/ThreadReads.ts";
import { ManagedAttachmentRepositoryLive } from "./persistence/Layers/ManagedAttachments.ts";
import { TextGenerationLayerLive } from "./textGeneration/runtimeLayer";
import { AuthControlPlaneLive } from "./auth/Layers/AuthControlPlane";
import { BootstrapCredentialServiceLive } from "./auth/Layers/BootstrapCredentialService";
import { ServerAuthLive } from "./auth/Layers/ServerAuth";
import { ServerAuthPolicyLive } from "./auth/Layers/ServerAuthPolicy";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore";
import { SessionCredentialServiceLive } from "./auth/Layers/SessionCredentialService";
import { ServerLifecycleEventsLive } from "./serverLifecycleEvents";
import { ServerRuntimeStartupLive } from "./serverRuntimeStartup";
import { ServerSettingsLive } from "./serverSettings";
import { WorkspaceLayerLive } from "./workspace/runtimeLayer";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver";
import { ServerEnvironmentLive } from "./environment/Layers/ServerEnvironment";
import { ProviderInstallationRepositoryLive } from "./persistence/Layers/ProviderInstallations";
import { ProviderConnectionRepositoryLive } from "./persistence/Layers/ProviderConnections";
import { ConnectionRateLimitsLive } from "./providerUsage/ConnectionRateLimits";
import { ProviderUsageLive } from "./providerUsage/ProviderUsage.ts";
import { ProviderConnectionLoginRepositoryLive } from "./persistence/Layers/ProviderConnectionLogins";
import { ProviderCredentialBrokerLive } from "./provider/providerCredentialBroker";
import { ProviderConnectionLifecycleLive } from "./provider/Layers/ProviderConnectionLifecycle";
import { ProviderConnectionLoginCoordinatorLive } from "./provider/Layers/ProviderConnectionLoginCoordinator";
import { ProviderLaunchResolverLive } from "./provider/Layers/ProviderLaunchResolver";
import { ProviderTurnSelectionResolverLive } from "./provider/Layers/ProviderTurnSelectionResolver";
import { ProviderNativeStateMaterializerLive } from "./provider/Layers/ProviderNativeStateMaterializer";
import { ProviderThreadSwitchCoordinatorLive } from "./orchestration/Layers/ProviderThreadSwitchCoordinator";
import { ManagedAttachmentCleanupLive } from "./managedAttachmentCleanup";
import { ProviderHealthLive } from "./provider/Layers/ProviderHealth";
import { makeServerProviderLayer } from "./provider/runtimeLayer";
import { WorkspaceWatcherLive } from "./workspaceWatcher";

export { makeServerProviderLayer } from "./provider/runtimeLayer";

export function makeServerRuntimeServicesLayer(
  options: {
    readonly agentGatewayCredentialsLayer?: typeof AgentGatewayCredentialsWithSecretsLive;
  } = {},
) {
  const agentGatewayCredentialsLayer =
    options.agentGatewayCredentialsLayer ?? AgentGatewayCredentialsWithSecretsLive;
  const providerHealthLayer = ProviderHealthLive.pipe(Layer.provideMerge(ServerSettingsLive));
  const providerConnectionPersistenceLayer = Layer.mergeAll(
    ProviderConnectionRepositoryLive,
    ConnectionRateLimitsLive,
    ProviderConnectionLoginRepositoryLive,
  );
  const providerConnectionLifecycleLayer = ProviderConnectionLifecycleLive.pipe(
    Layer.provideMerge(providerConnectionPersistenceLayer),
    Layer.provideMerge(ProviderCredentialBrokerLive),
  );
  const providerUsageLayer = ProviderUsageLive.pipe(
    Layer.provideMerge(providerConnectionPersistenceLayer),
    Layer.provideMerge(ProviderInstallationRepositoryLive),
  );
  const providerConnectionLoginCoordinatorLayer = ProviderConnectionLoginCoordinatorLive.pipe(
    Layer.provideMerge(providerConnectionPersistenceLayer),
    Layer.provideMerge(ProviderInstallationRepositoryLive),
    Layer.provideMerge(ProviderCredentialBrokerLive),
  );
  const providerNativeStateMaterializerLayer = ProviderNativeStateMaterializerLive.pipe(
    Layer.provideMerge(providerConnectionPersistenceLayer),
  );
  const providerLaunchResolverLayer = ProviderLaunchResolverLive.pipe(
    Layer.provideMerge(providerConnectionPersistenceLayer),
    Layer.provideMerge(ProviderInstallationRepositoryLive),
    Layer.provideMerge(ProviderCredentialBrokerLive),
  );
  const providerTurnSelectionResolverLayer = ProviderTurnSelectionResolverLive.pipe(
    Layer.provideMerge(ServerSettingsLive),
    Layer.provideMerge(providerConnectionPersistenceLayer),
    Layer.provideMerge(ProviderInstallationRepositoryLive),
    Layer.provideMerge(ThreadReadsLive),
    Layer.provideMerge(providerLaunchResolverLayer),
  );

  const runtimeServicesLayer = Layer.mergeAll(
    ThreadReadsLive,
    ManagedAttachmentRepositoryLive,
    ProviderAuthCircuitsLive,
  );
  const managedAttachmentCleanupLayer = ManagedAttachmentCleanupLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const turnDispatchLayer = TurnDispatchLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(providerLaunchResolverLayer),
    Layer.provideMerge(ServerSettingsLive),
    Layer.provideMerge(ProviderAuthCircuitsLive),
  );
  const providerThreadSwitchCoordinatorLayer = ProviderThreadSwitchCoordinatorLive.pipe(
    Layer.provideMerge(turnDispatchLayer),
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(providerConnectionPersistenceLayer),
    Layer.provideMerge(providerTurnSelectionResolverLayer),
    Layer.provideMerge(providerNativeStateMaterializerLayer),
    Layer.provideMerge(providerLaunchResolverLayer),
  );
  const sessionCredentialLayer = SessionCredentialServiceLive.pipe(
    Layer.provide(ServerSecretStoreLive),
  );
  const authControlPlaneLayer = AuthControlPlaneLive.pipe(
    Layer.provide(BootstrapCredentialServiceLive),
    Layer.provide(sessionCredentialLayer),
  );
  const serverAuthLayer = ServerAuthLive.pipe(
    Layer.provide(ServerAuthPolicyLive),
    Layer.provide(BootstrapCredentialServiceLive),
    Layer.provide(sessionCredentialLayer),
    Layer.provide(authControlPlaneLayer),
  );
  const authServicesLayer = Layer.mergeAll(
    ServerAuthPolicyLive,
    ServerSecretStoreLive,
    BootstrapCredentialServiceLive,
    sessionCredentialLayer,
    authControlPlaneLayer,
    serverAuthLayer,
  );
  const workspaceWatcherLayer = WorkspaceWatcherLive.pipe(Layer.provideMerge(runtimeServicesLayer));
  const threadSenderLayer = ThreadSenderLive.pipe(
    Layer.provideMerge(providerThreadSwitchCoordinatorLayer),
  );
  const threadLifecycleLayer = ThreadLifecycleLive.pipe(
    Layer.provideMerge(threadSenderLayer),
    Layer.provideMerge(providerThreadSwitchCoordinatorLayer),
  );
  const agentGatewayLayer = AgentGatewayLive.pipe(
    Layer.provideMerge(threadLifecycleLayer),
    Layer.provideMerge(threadSenderLayer),
    Layer.provideMerge(agentGatewayCredentialsLayer),
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(ServerSettingsLive),
    Layer.provideMerge(providerHealthLayer),
    Layer.provideMerge(providerTurnSelectionResolverLayer),
    Layer.provideMerge(providerThreadSwitchCoordinatorLayer),
  );

  return Layer.mergeAll(
    workspaceWatcherLayer,
    agentGatewayCredentialsLayer,
    agentGatewayLayer,
    managedAttachmentCleanupLayer,
    ProviderInstallationRepositoryLive,
    providerConnectionPersistenceLayer,
    providerUsageLayer,
    ProviderCredentialBrokerLive,
    providerConnectionLifecycleLayer,
    providerConnectionLoginCoordinatorLayer,
    providerLaunchResolverLayer,
    providerTurnSelectionResolverLayer,
    providerNativeStateMaterializerLayer,
    providerThreadSwitchCoordinatorLayer,
    providerHealthLayer,
    TextGenerationLayerLive,
    ServerSettingsLive,
    ServerEnvironmentLive,
    authServicesLayer,
    ServerLifecycleEventsLive,
    ServerRuntimeStartupLive,
    WorkspaceLayerLive,
    ProjectFaviconResolverLive,
  ).pipe(Layer.provideMerge(NodeServices.layer));
}

/**
 * Compose the two top-level server graphs around one credential layer. Provider
 * adapters issue tokens from this registry and the HTTP gateway verifies those
 * same tokens, so constructing them independently would break scoped MCP.
 */
export function makeServerApplicationLayers() {
  const agentGatewayCredentialsLayer = AgentGatewayCredentialsWithSecretsLive;
  return {
    runtimeServicesLayer: makeServerRuntimeServicesLayer({
      agentGatewayCredentialsLayer,
    }),
    providerLayer: makeServerProviderLayer({ agentGatewayCredentialsLayer }),
  } as const;
}
