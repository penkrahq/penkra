import * as NodeServices from "@effect/platform-node/NodeServices";
import { Layer } from "effect";

import { AgentGatewayLive } from "./agentGateway/Layers/AgentGateway";
import { AgentGatewayOperationRepositoryLive } from "./agentGateway/Layers/AgentGatewayOperationRepository";
import { AgentGatewayCredentialsWithSecretsLive } from "./agentGateway/Layers/AgentGatewayCredentials";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion";
import { ThreadDeletionReactorLive } from "./orchestration/Layers/ThreadDeletionReactor";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer";

import { DevServerManagerLive } from "./devServerManager";
import { KeybindingsLive } from "./keybindings";
import { TextGenerationLayerLive } from "./textGeneration/runtimeLayer";
import { TerminalLayerLive } from "./terminal/runtimeLayer";
import { AuthControlPlaneLive } from "./auth/Layers/AuthControlPlane";
import { BootstrapCredentialServiceLive } from "./auth/Layers/BootstrapCredentialService";
import { ServerAuthLive } from "./auth/Layers/ServerAuth";
import { ServerAuthPolicyLive } from "./auth/Layers/ServerAuthPolicy";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore";
import { SessionCredentialServiceLive } from "./auth/Layers/SessionCredentialService";
import { ThreadPurgeLive } from "./threadPurge";
import { ServerLifecycleEventsLive } from "./serverLifecycleEvents";
import { ServerRuntimeStartupLive } from "./serverRuntimeStartup";
import { ServerSettingsLive } from "./serverSettings";
import { WorkspaceLayerLive } from "./workspace/runtimeLayer";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver";
import { ServerEnvironmentLive } from "./environment/Layers/ServerEnvironment";
import { ProjectionTurnRepositoryLive } from "./persistence/Layers/ProjectionTurns";
import { OrchestrationEventDeliveryRepositoryLive } from "./persistence/Layers/OrchestrationEventDeliveries";
import { ProviderRuntimeEventRepositoryLive } from "./persistence/Layers/ProviderRuntimeEvents";
import { ProviderInstallationRepositoryLive } from "./persistence/Layers/ProviderInstallations";
import { ProviderConnectionRepositoryLive } from "./persistence/Layers/ProviderConnections";
import { ProviderConnectionOperationRepositoryLive } from "./persistence/Layers/ProviderConnectionOperations";
import { ProviderConnectionLoginRepositoryLive } from "./persistence/Layers/ProviderConnectionLogins";
import { ThreadProviderBindingRepositoryLive } from "./persistence/Layers/ThreadProviderBindings";
import { ProviderThreadSwitchOperationRepositoryLive } from "./persistence/Layers/ProviderThreadSwitchOperations";
import { ProviderNativeForkOperationRepositoryLive } from "./persistence/Layers/ProviderNativeForkOperations";
import { ProviderNativeStateDeletionRepositoryLive } from "./persistence/Layers/ProviderNativeStateDeletions";
import { ProviderCredentialBrokerLive } from "./provider/providerCredentialBroker";
import { ProviderConnectionLifecycleLive } from "./provider/Layers/ProviderConnectionLifecycle";
import { ProviderConnectionLoginCoordinatorLive } from "./provider/Layers/ProviderConnectionLoginCoordinator";
import { ProviderLaunchResolverLive } from "./provider/Layers/ProviderLaunchResolver";
import { ProviderTurnSelectionResolverLive } from "./provider/Layers/ProviderTurnSelectionResolver";
import { ProviderNativeStateMaterializerLive } from "./provider/Layers/ProviderNativeStateMaterializer";
import { ProviderNativeContinuationVerifierLive } from "./provider/Layers/ProviderNativeContinuationVerifier";
import { ProviderNativeStateDeletionCoordinatorLive } from "./provider/Layers/ProviderNativeStateDeletionCoordinator";
import { ProviderThreadSwitchCoordinatorLive } from "./orchestration/Layers/ProviderThreadSwitchCoordinator";
import { ThreadDiagnosticsQueryLive } from "./diagnostics/Layers/ThreadDiagnosticsQuery";
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
    ProviderConnectionOperationRepositoryLive,
    ProviderConnectionLoginRepositoryLive,
    ThreadProviderBindingRepositoryLive,
    ProviderThreadSwitchOperationRepositoryLive,
    ProviderNativeForkOperationRepositoryLive,
    ProviderNativeStateDeletionRepositoryLive,
  );
  const providerConnectionLifecycleLayer = ProviderConnectionLifecycleLive.pipe(
    Layer.provideMerge(providerConnectionPersistenceLayer),
    Layer.provideMerge(ProviderCredentialBrokerLive),
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
    Layer.provideMerge(providerConnectionPersistenceLayer),
    Layer.provideMerge(ProviderInstallationRepositoryLive),
    Layer.provideMerge(OrchestrationLayerLive),
    Layer.provideMerge(providerLaunchResolverLayer),
  );

  const runtimeServicesLayer = Layer.mergeAll(OrchestrationLayerLive);
  const managedAttachmentCleanupLayer = ManagedAttachmentCleanupLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const providerNativeContinuationVerifierLayer = ProviderNativeContinuationVerifierLive.pipe(
    Layer.provideMerge(providerConnectionPersistenceLayer),
    Layer.provideMerge(providerLaunchResolverLayer),
    Layer.provideMerge(providerNativeStateMaterializerLayer),
  );
  const providerNativeStateDeletionCoordinatorLayer =
    ProviderNativeStateDeletionCoordinatorLive.pipe(
      Layer.provideMerge(providerConnectionPersistenceLayer),
      Layer.provideMerge(providerNativeStateMaterializerLayer),
    );
  const providerThreadSwitchCoordinatorLayer = ProviderThreadSwitchCoordinatorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(providerConnectionPersistenceLayer),
    Layer.provideMerge(providerTurnSelectionResolverLayer),
    Layer.provideMerge(providerNativeContinuationVerifierLayer),
    Layer.provideMerge(providerNativeStateMaterializerLayer),
    Layer.provideMerge(providerLaunchResolverLayer),
  );
  const providerCommandReactorLayer = ProviderCommandReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(OrchestrationEventDeliveryRepositoryLive),
    Layer.provideMerge(TextGenerationLayerLive),
    Layer.provideMerge(ServerSettingsLive),
    Layer.provideMerge(providerConnectionPersistenceLayer),
    Layer.provideMerge(providerLaunchResolverLayer),
    Layer.provideMerge(providerTurnSelectionResolverLayer),
    Layer.provideMerge(providerThreadSwitchCoordinatorLayer),
  );
  const orchestrationReactorLayer = OrchestrationReactorLive.pipe(
    Layer.provideMerge(runtimeIngestionLayer),
    Layer.provideMerge(providerCommandReactorLayer),
  );
  const threadDeletionReactorLayer = ThreadDeletionReactorLive.pipe(
    Layer.provideMerge(ThreadPurgeLive),
    Layer.provideMerge(OrchestrationLayerLive),
    Layer.provideMerge(TerminalLayerLive),
    Layer.provideMerge(providerNativeStateDeletionCoordinatorLayer),
  );
  // Shares the single memoized TerminalManager with the top-level TerminalLayerLive.
  const devServerManagerLayer = DevServerManagerLive.pipe(Layer.provide(TerminalLayerLive));
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
  const agentGatewayLayer = AgentGatewayLive.pipe(
    Layer.provideMerge(agentGatewayCredentialsLayer),
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(AgentGatewayOperationRepositoryLive),
    Layer.provideMerge(OrchestrationEventDeliveryRepositoryLive),
    Layer.provideMerge(ProviderRuntimeEventRepositoryLive),
    Layer.provideMerge(ThreadDiagnosticsQueryLive),
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
    AgentGatewayOperationRepositoryLive,
    ProviderInstallationRepositoryLive,
    providerConnectionPersistenceLayer,
    ProviderCredentialBrokerLive,
    providerConnectionLifecycleLayer,
    providerConnectionLoginCoordinatorLayer,
    providerLaunchResolverLayer,
    providerTurnSelectionResolverLayer,
    providerNativeStateMaterializerLayer,
    providerNativeStateDeletionCoordinatorLayer,
    providerNativeContinuationVerifierLayer,
    providerThreadSwitchCoordinatorLayer,
    providerHealthLayer,
    orchestrationReactorLayer,
    providerCommandReactorLayer,
    threadDeletionReactorLayer,
    devServerManagerLayer,
    TextGenerationLayerLive,
    TerminalLayerLive,
    KeybindingsLive,
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
