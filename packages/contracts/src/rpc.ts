import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { OpenInEditorInput } from "./editor";
import { FilesystemBrowseInput, FilesystemBrowseResult } from "./filesystem";
import { KeybindingRule } from "./keybindings";
import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationEvent,
  OrchestrationImportThreadInput,
  OrchestrationImportThreadResult,
  OrchestrationRpcSchemas,
  OrchestrationShellStreamItem,
  OrchestrationThreadStreamItem,
} from "./orchestration";
import { ProviderCompactThreadInput } from "./provider";
import {
  CreateStaticProviderConnectionInput,
  BeginProviderConnectionLoginInput,
  GetProviderConnectionLoginInput,
  ProviderConnectionLoginSnapshot,
  ProviderConnection,
  ProviderConnectionsSnapshot,
  ProviderConnectionsSnapshotInput,
  TerminateProviderConnectionInput,
  ThreadProviderBindingSnapshot,
  ThreadProviderBindingSnapshotInput,
} from "./providerConnections";
import {
  ProviderGetComposerCapabilitiesInput,
  ProviderComposerCapabilities,
  ProviderGetCapabilityHealthInput,
  ProviderGetCapabilityHealthResult,
  ProviderListAgentsInput,
  ProviderListAgentsResult,
  ProviderListCommandsInput,
  ProviderListCommandsResult,
  ProviderListModelsInput,
  ProviderListModelsResult,
  ProviderListPluginsInput,
  ProviderListPluginsResult,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
  ProviderSkillsCatalogInput,
  ProviderSkillsCatalogResult,
  ProviderReadPluginInput,
  ProviderReadPluginResult,
} from "./providerDiscovery";
import {
  ProjectCreateLocalFilePreviewGrantInput,
  ProjectCreateLocalFilePreviewGrantResult,
  ProjectDevServerEvent,
  ProjectDiscoverScriptsInput,
  ProjectDiscoverScriptsResult,
  ProjectListDevServersResult,
  ProjectListDirectoriesInput,
  ProjectListDirectoriesResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectRunDevServerInput,
  ProjectRunDevServerResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectSearchLocalEntriesInput,
  ProjectSearchLocalEntriesResult,
  ProjectStopDevServerInput,
  ProjectStopDevServerResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
  ProjectWorkspaceChangeEvent,
} from "./project";
import {
  ServerConfig,
  ServerConfigStreamEvent,
  ServerDiagnosticsResult,
  ServerGetEnvironmentResult,
  ServerGetProviderUsageSnapshotInput,
  ServerGetProviderUsageSnapshotResult,
  ServerListProviderUsageInput,
  ServerListProviderUsageResult,
  ServerLifecycleStreamEvent,
  ServerGetSettingsResult,
  ServerListLocalServersResult,
  ServerListWorktreesResult,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerProviderUpdateResult,
  ServerRefreshProvidersResult,
  ServerStopLocalServerInput,
  ServerStopLocalServerResult,
  ServerUpdateSettingsInput,
  ServerUpdateSettingsResult,
  ServerSpaceNavigationState,
  ServerUpdateSpaceNavigationStateInput,
  ServerUpsertKeybindingResult,
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
} from "./server";
import {
  TerminalAckOutputInput,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal";
import { WS_METHODS } from "./ws";
import {
  WS_BOOTSTRAP_METHOD,
  WsBootstrapNegotiateInput,
  WsBootstrapNegotiateResult,
  WsCompatibilityError,
} from "./wsCompatibility";

export class WsRpcError extends Schema.TaggedErrorClass<WsRpcError>()("WsRpcError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
  code: Schema.optional(Schema.String),
  retryable: Schema.optional(Schema.Boolean),
  retryAfterMs: Schema.optional(Schema.Number),
}) {}

export const WsBootstrapNegotiateRpc = Rpc.make(WS_BOOTSTRAP_METHOD, {
  payload: WsBootstrapNegotiateInput,
  success: WsBootstrapNegotiateResult,
  error: WsCompatibilityError,
});

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: WsRpcError,
  },
);

export const WsOrchestrationImportThreadRpc = Rpc.make(ORCHESTRATION_WS_METHODS.importThread, {
  payload: OrchestrationImportThreadInput,
  success: OrchestrationImportThreadResult,
  error: WsRpcError,
});

export const WsOrchestrationGetSnapshotRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getSnapshot, {
  payload: OrchestrationRpcSchemas.getSnapshot.input,
  success: OrchestrationRpcSchemas.getSnapshot.output,
  error: WsRpcError,
});

export const WsOrchestrationGetShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getShellSnapshot,
  {
    payload: OrchestrationRpcSchemas.getShellSnapshot.input,
    success: OrchestrationRpcSchemas.getShellSnapshot.output,
    error: WsRpcError,
  },
);

export const WsOrchestrationRepairStateRpc = Rpc.make(ORCHESTRATION_WS_METHODS.repairState, {
  payload: OrchestrationRpcSchemas.repairState.input,
  success: OrchestrationRpcSchemas.repairState.output,
  error: WsRpcError,
});

export const WsOrchestrationGetThreadDetailSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot,
  {
    payload: OrchestrationRpcSchemas.getThreadDetailSnapshot.input,
    success: OrchestrationRpcSchemas.getThreadDetailSnapshot.output,
    error: WsRpcError,
  },
);

export const WsOrchestrationReplayEventsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.replayEvents, {
  payload: OrchestrationRpcSchemas.replayEvents.input,
  success: OrchestrationRpcSchemas.replayEvents.output,
  error: WsRpcError,
});

export const WsOrchestrationListProviderDeliveryBlockersRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.listProviderDeliveryBlockers,
  {
    payload: OrchestrationRpcSchemas.listProviderDeliveryBlockers.input,
    success: OrchestrationRpcSchemas.listProviderDeliveryBlockers.output,
    error: WsRpcError,
  },
);

export const WsOrchestrationReconcileProviderDeliveryRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.reconcileProviderDelivery,
  {
    payload: OrchestrationRpcSchemas.reconcileProviderDelivery.input,
    success: OrchestrationRpcSchemas.reconcileProviderDelivery.output,
    error: WsRpcError,
  },
);

export const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationShellStreamItem,
  error: WsRpcError,
  stream: true,
});

export const WsOrchestrationUnsubscribeShellRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.unsubscribeShell,
  {
    payload: OrchestrationRpcSchemas.unsubscribeShell.input,
    success: Schema.Void,
    error: WsRpcError,
  },
);

export const WsOrchestrationSubscribeThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.subscribeThread,
  {
    payload: OrchestrationRpcSchemas.subscribeThread.input,
    success: OrchestrationThreadStreamItem,
    error: WsRpcError,
    stream: true,
  },
);

export const WsOrchestrationSubscribeDomainEventsRpc = Rpc.make(
  WS_METHODS.subscribeOrchestrationDomainEvents,
  {
    payload: Schema.Struct({}),
    success: OrchestrationEvent,
    error: WsRpcError,
    stream: true,
  },
);

export const WsOrchestrationUnsubscribeThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.unsubscribeThread,
  {
    payload: OrchestrationRpcSchemas.unsubscribeThread.input,
    success: Schema.Void,
    error: WsRpcError,
  },
);

export const WsFoldersListDirectoriesRpc = Rpc.make(WS_METHODS.projectsListDirectories, {
  payload: ProjectListDirectoriesInput,
  success: ProjectListDirectoriesResult,
  error: WsRpcError,
});

export const WsFoldersDiscoverScriptsRpc = Rpc.make(WS_METHODS.projectsDiscoverScripts, {
  payload: ProjectDiscoverScriptsInput,
  success: ProjectDiscoverScriptsResult,
  error: WsRpcError,
});

export const WsFoldersSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: WsRpcError,
});

export const WsFoldersSearchLocalEntriesRpc = Rpc.make(WS_METHODS.projectsSearchLocalEntries, {
  payload: ProjectSearchLocalEntriesInput,
  success: ProjectSearchLocalEntriesResult,
  error: WsRpcError,
});

export const WsFoldersReadFileRpc = Rpc.make(WS_METHODS.projectsReadFile, {
  payload: ProjectReadFileInput,
  success: ProjectReadFileResult,
  error: WsRpcError,
});

export const WsFoldersCreateLocalFilePreviewGrantRpc = Rpc.make(
  WS_METHODS.projectsCreateLocalFilePreviewGrant,
  {
    payload: ProjectCreateLocalFilePreviewGrantInput,
    success: ProjectCreateLocalFilePreviewGrantResult,
    error: WsRpcError,
  },
);

export const WsFoldersWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: WsRpcError,
});

export const WsFoldersRunDevServerRpc = Rpc.make(WS_METHODS.projectsRunDevServer, {
  payload: ProjectRunDevServerInput,
  success: ProjectRunDevServerResult,
  error: WsRpcError,
});

export const WsFoldersStopDevServerRpc = Rpc.make(WS_METHODS.projectsStopDevServer, {
  payload: ProjectStopDevServerInput,
  success: ProjectStopDevServerResult,
  error: WsRpcError,
});

export const WsFoldersListDevServersRpc = Rpc.make(WS_METHODS.projectsListDevServers, {
  payload: Schema.Struct({}),
  success: ProjectListDevServersResult,
  error: WsRpcError,
});

export const WsSubscribeProjectDevServerEventsRpc = Rpc.make(
  WS_METHODS.subscribeProjectDevServerEvents,
  {
    payload: Schema.Struct({}),
    success: ProjectDevServerEvent,
    error: WsRpcError,
    stream: true,
  },
);

export const WsSubscribeProjectWorkspaceChangesRpc = Rpc.make(
  WS_METHODS.subscribeProjectWorkspaceChanges,
  {
    payload: Schema.Struct({}),
    success: ProjectWorkspaceChangeEvent,
    error: WsRpcError,
    stream: true,
  },
);

export const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: WsRpcError,
});

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: OpenInEditorInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: WsRpcError,
});

export const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsTerminalAckOutputRpc = Rpc.make(WS_METHODS.terminalAckOutput, {
  payload: TerminalAckOutputInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: WsRpcError,
});

export const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  error: WsRpcError,
  stream: true,
});

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: WsRpcError,
});

export const WsServerGetEnvironmentRpc = Rpc.make(WS_METHODS.serverGetEnvironment, {
  payload: Schema.Struct({}),
  success: ServerGetEnvironmentResult,
  error: WsRpcError,
});

export const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerGetSettingsResult,
  error: WsRpcError,
});

export const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: ServerUpdateSettingsInput,
  success: ServerUpdateSettingsResult,
  error: WsRpcError,
});

export const WsServerGetSpaceNavigationStateRpc = Rpc.make(
  WS_METHODS.serverGetSpaceNavigationState,
  {
    payload: Schema.Struct({}),
    success: ServerSpaceNavigationState,
    error: WsRpcError,
  },
);

export const WsServerUpdateSpaceNavigationStateRpc = Rpc.make(
  WS_METHODS.serverUpdateSpaceNavigationState,
  {
    payload: ServerUpdateSpaceNavigationStateInput,
    success: ServerSpaceNavigationState,
    error: WsRpcError,
  },
);

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({}),
  success: ServerRefreshProvidersResult,
  error: WsRpcError,
});

export const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdateResult,
  error: ServerProviderUpdateError,
});

export const WsServerListLocalServersRpc = Rpc.make(WS_METHODS.serverListLocalServers, {
  payload: Schema.Struct({}),
  success: ServerListLocalServersResult,
  error: WsRpcError,
});

export const WsServerStopLocalServerRpc = Rpc.make(WS_METHODS.serverStopLocalServer, {
  payload: ServerStopLocalServerInput,
  success: ServerStopLocalServerResult,
  error: WsRpcError,
});

export const WsServerGetProviderUsageSnapshotRpc = Rpc.make(
  WS_METHODS.serverGetProviderUsageSnapshot,
  {
    payload: ServerGetProviderUsageSnapshotInput,
    success: ServerGetProviderUsageSnapshotResult,
    error: WsRpcError,
  },
);

export const WsServerListProviderUsageRpc = Rpc.make(WS_METHODS.serverListProviderUsage, {
  payload: ServerListProviderUsageInput,
  success: ServerListProviderUsageResult,
  error: WsRpcError,
});

export const WsServerGetDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerDiagnosticsResult,
  error: WsRpcError,
});

export const WsServerTranscribeVoiceRpc = Rpc.make(WS_METHODS.serverTranscribeVoice, {
  payload: ServerVoiceTranscriptionInput,
  success: ServerVoiceTranscriptionResult,
  error: WsRpcError,
});

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: KeybindingRule,
  success: ServerUpsertKeybindingResult,
  error: WsRpcError,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: WsRpcError,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: WsRpcError,
  stream: true,
});

export const WsSubscribeServerProviderStatusesRpc = Rpc.make(
  WS_METHODS.subscribeServerProviderStatuses,
  {
    payload: Schema.Struct({}),
    success: ServerRefreshProvidersResult,
    error: WsRpcError,
    stream: true,
  },
);

export const WsSubscribeServerSettingsRpc = Rpc.make(WS_METHODS.subscribeServerSettings, {
  payload: Schema.Struct({}),
  success: Schema.Struct({ settings: ServerGetSettingsResult }),
  error: WsRpcError,
  stream: true,
});

export const WsProviderGetComposerCapabilitiesRpc = Rpc.make(
  WS_METHODS.providerGetComposerCapabilities,
  {
    payload: ProviderGetComposerCapabilitiesInput,
    success: ProviderComposerCapabilities,
    error: WsRpcError,
  },
);

export const WsProviderGetCapabilityHealthRpc = Rpc.make(WS_METHODS.providerGetCapabilityHealth, {
  payload: ProviderGetCapabilityHealthInput,
  success: ProviderGetCapabilityHealthResult,
  error: WsRpcError,
});

export const WsProviderCompactThreadRpc = Rpc.make(WS_METHODS.providerCompactThread, {
  payload: ProviderCompactThreadInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsProviderListCommandsRpc = Rpc.make(WS_METHODS.providerListCommands, {
  payload: ProviderListCommandsInput,
  success: ProviderListCommandsResult,
  error: WsRpcError,
});

export const WsProviderListSkillsRpc = Rpc.make(WS_METHODS.providerListSkills, {
  payload: ProviderListSkillsInput,
  success: ProviderListSkillsResult,
  error: WsRpcError,
});

export const WsProviderListSkillsCatalogRpc = Rpc.make(WS_METHODS.providerListSkillsCatalog, {
  payload: ProviderSkillsCatalogInput,
  success: ProviderSkillsCatalogResult,
  error: WsRpcError,
});

export const WsProviderListPluginsRpc = Rpc.make(WS_METHODS.providerListPlugins, {
  payload: ProviderListPluginsInput,
  success: ProviderListPluginsResult,
  error: WsRpcError,
});

export const WsProviderReadPluginRpc = Rpc.make(WS_METHODS.providerReadPlugin, {
  payload: ProviderReadPluginInput,
  success: ProviderReadPluginResult,
  error: WsRpcError,
});

export const WsProviderListModelsRpc = Rpc.make(WS_METHODS.providerListModels, {
  payload: ProviderListModelsInput,
  success: ProviderListModelsResult,
  error: WsRpcError,
});

export const WsProviderListAgentsRpc = Rpc.make(WS_METHODS.providerListAgents, {
  payload: ProviderListAgentsInput,
  success: ProviderListAgentsResult,
  error: WsRpcError,
});

export const WsProviderGetConnectionsRpc = Rpc.make(WS_METHODS.providerGetConnections, {
  payload: ProviderConnectionsSnapshotInput,
  success: ProviderConnectionsSnapshot,
  error: WsRpcError,
});
export const WsProviderGetThreadBindingRpc = Rpc.make(WS_METHODS.providerGetThreadBinding, {
  payload: ThreadProviderBindingSnapshotInput,
  success: ThreadProviderBindingSnapshot,
  error: WsRpcError,
});
export const WsProviderCreateStaticConnectionRpc = Rpc.make(
  WS_METHODS.providerCreateStaticConnection,
  { payload: CreateStaticProviderConnectionInput, success: ProviderConnection, error: WsRpcError },
);
export const WsProviderBeginConnectionLoginRpc = Rpc.make(WS_METHODS.providerBeginConnectionLogin, {
  payload: BeginProviderConnectionLoginInput,
  success: ProviderConnectionLoginSnapshot,
  error: WsRpcError,
});
export const WsProviderGetConnectionLoginRpc = Rpc.make(WS_METHODS.providerGetConnectionLogin, {
  payload: GetProviderConnectionLoginInput,
  success: ProviderConnectionLoginSnapshot,
  error: WsRpcError,
});
export const WsProviderCancelConnectionLoginRpc = Rpc.make(
  WS_METHODS.providerCancelConnectionLogin,
  {
    payload: GetProviderConnectionLoginInput,
    success: ProviderConnectionLoginSnapshot,
    error: WsRpcError,
  },
);
export const WsProviderTerminateConnectionRpc = Rpc.make(WS_METHODS.providerTerminateConnection, {
  payload: TerminateProviderConnectionInput,
  success: ProviderConnection,
  error: WsRpcError,
});
export const WsBootstrapRpcGroup = RpcGroup.make(WsBootstrapNegotiateRpc);

export const WsFeatureRpcGroup = RpcGroup.make(
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationImportThreadRpc,
  WsOrchestrationGetSnapshotRpc,
  WsOrchestrationGetShellSnapshotRpc,
  WsOrchestrationGetThreadDetailSnapshotRpc,
  WsOrchestrationRepairStateRpc,
  WsOrchestrationReplayEventsRpc,
  WsOrchestrationListProviderDeliveryBlockersRpc,
  WsOrchestrationReconcileProviderDeliveryRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationUnsubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
  WsOrchestrationUnsubscribeThreadRpc,
  WsOrchestrationSubscribeDomainEventsRpc,
  WsFoldersDiscoverScriptsRpc,
  WsFoldersListDirectoriesRpc,
  WsFoldersSearchEntriesRpc,
  WsFoldersSearchLocalEntriesRpc,
  WsFoldersReadFileRpc,
  WsFoldersCreateLocalFilePreviewGrantRpc,
  WsFoldersWriteFileRpc,
  WsFoldersRunDevServerRpc,
  WsFoldersStopDevServerRpc,
  WsFoldersListDevServersRpc,
  WsSubscribeProjectDevServerEventsRpc,
  WsSubscribeProjectWorkspaceChangesRpc,
  WsFilesystemBrowseRpc,
  WsShellOpenInEditorRpc,
  WsTerminalOpenRpc,
  WsTerminalWriteRpc,
  WsTerminalAckOutputRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalEventsRpc,
  WsServerGetConfigRpc,
  WsServerGetEnvironmentRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerGetSpaceNavigationStateRpc,
  WsServerUpdateSpaceNavigationStateRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpdateProviderRpc,
  WsServerListLocalServersRpc,
  WsServerStopLocalServerRpc,
  WsServerGetProviderUsageSnapshotRpc,
  WsServerListProviderUsageRpc,
  WsServerGetDiagnosticsRpc,
  WsServerTranscribeVoiceRpc,
  WsServerUpsertKeybindingRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerProviderStatusesRpc,
  WsSubscribeServerSettingsRpc,
  WsProviderGetComposerCapabilitiesRpc,
  WsProviderGetCapabilityHealthRpc,
  WsProviderCompactThreadRpc,
  WsProviderListCommandsRpc,
  WsProviderListSkillsRpc,
  WsProviderListSkillsCatalogRpc,
  WsProviderListPluginsRpc,
  WsProviderReadPluginRpc,
  WsProviderListModelsRpc,
  WsProviderListAgentsRpc,
  WsProviderGetConnectionsRpc,
  WsProviderGetThreadBindingRpc,
  WsProviderCreateStaticConnectionRpc,
  WsProviderBeginConnectionLoginRpc,
  WsProviderGetConnectionLoginRpc,
  WsProviderCancelConnectionLoginRpc,
  WsProviderTerminateConnectionRpc,
);

/** @deprecated Use WsFeatureRpcGroup. Bootstrap is intentionally a separate endpoint/group. */
export const WsRpcGroup = WsFeatureRpcGroup;
