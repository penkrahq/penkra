import { CleanCoreGetBootstrapResult } from "./cleanCore";
import {
  CleanCoreListArchivedNavigationResult,
  CleanCoreListArchivedThreadsInput,
  CleanCoreListArchivedThreadsResult,
  CleanCoreRestoreThreadInput,
} from "./cleanCore";
import { Schema } from "effect";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { OpenInEditorInput } from "./editor";
import { FilesystemBrowseInput, FilesystemBrowseResult } from "./filesystem";
import {
  ORCHESTRATION_WS_METHODS,
  OrchestrationImportThreadInput,
  OrchestrationImportThreadResult,
  OrchestrationThreadShell,
} from "./orchestration";
import { ProviderCompactThreadInput } from "./provider";
import {
  ProviderCatalogScope,
  ProviderCatalogSnapshot,
  ProviderGetCatalogInput,
} from "./providerCatalog";
import {
  CreateStaticProviderConnectionInput,
  BeginProviderConnectionLoginInput,
  GetProviderConnectionLoginInput,
  ProviderConnectionLoginSnapshot,
  ProviderConnection,
  ProviderConnectionsSnapshot,
  ProviderConnectionsSnapshotInput,
  RetryProviderAuthConnectionInput,
  TerminateProviderConnectionInput,
} from "./providerConnections";
import {
  ProviderGetComposerCapabilitiesInput,
  ProviderComposerCapabilities,
  ProviderGetCapabilityHealthInput,
  ProviderGetCapabilityHealthResult,
  ProviderSkillsCatalogInput,
  ProviderSkillsCatalogResult,
} from "./providerDiscovery";
import {
  ProjectCreateLocalFilePreviewGrantInput,
  ProjectCreateLocalFilePreviewGrantResult,
  ProjectListDirectoriesInput,
  ProjectListDirectoriesResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectSearchLocalEntriesInput,
  ProjectSearchLocalEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
  ProjectWorkspaceChangeEvent,
} from "./project";
import {
  ServerConfig,
  ServerConfigStreamEvent,
  ServerGetEnvironmentResult,
  ServerListProviderUsageInput,
  ServerListProviderUsageResult,
  ServerProviderUsageChange,
  ServerLifecycleStreamEvent,
  ServerGetSettingsResult,
  ServerRefreshProvidersResult,
  ServerUpdateSettingsInput,
  ServerUpdateSettingsResult,
  ServerSpaceNavigationState,
  ServerUpdateSpaceNavigationStateInput,
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
} from "./server";
import {
  CleanCoreThreadRuntimeInput,
  CleanCoreThreadRuntime,
  CleanCoreInterruptResult,
  CleanCoreAnswerThreadQuestionInput,
  CleanCoreGetThreadDraftInput,
  CleanCoreListThreadItemsPageInput,
  CleanCoreListThreadItemsPageResult,
  CleanCoreListTurnItemsInput,
  CleanCoreListTurnItemsResult,
  CleanCoreCreateThreadInput,
  CleanCoreGetFolderAppTabsInput,
  CleanCoreUpdateFolderAppTabsInput,
  CleanCoreFolderAppTabsResult,
  CleanCoreCreateAndSendThreadInput,
  CleanCoreCreateAndSendThreadResponse,
  CleanCoreThreadSummary,
  CleanCoreUserSendMessageInput,
  CleanCoreSendAdmission,
  CleanCoreQueuedMessageInput,
  CleanCoreQueuedMessageResult,
  CleanCoreEditQueuedMessageInput,
  CleanCoreSavePromptInput,
  SavedRestoreDraftNotEmptyError,
  QueuedEditDraftNotEmptyError,
  CleanCoreGetThreadShellInput,
  CleanCoreGetNavigationResult,
  CleanCoreUpdateNavigationInput,
  CleanCoreGetFoldersInput,
  CleanCoreGetFoldersResult,
  CleanCoreListThreadsInput,
  CleanCoreSearchThreadsInput,
  CleanCoreCreateThreadResponse,
  CleanCoreListThreadsResult,
  CleanCoreSearchThreadsResult,
  CleanCoreUpdateThreadInput,
  CleanCoreSetThreadDraftInput,
  CleanCoreSubscribeThreadInput,
  CleanCoreThreadChange,
  CleanCoreSidebarChange,
  CleanCoreThreadDraft,
} from "./cleanCore";
import { WS_METHODS } from "./ws";
import {
  WS_BOOTSTRAP_METHOD,
  WsBootstrapNegotiateInput,
  WsBootstrapNegotiateResult,
  WsCompatibilityError,
} from "./wsCompatibility";

export class WsRpcError extends Schema.TaggedError<WsRpcError>()("WsRpcError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
  code: Schema.optional(Schema.String),
  retryable: Schema.optional(Schema.Boolean),
  retryAfterMs: Schema.optional(Schema.Number),
}) {}

export const WsBootstrapNegotiateRpc = Rpc.make(WS_BOOTSTRAP_METHOD, {
  payload: WsBootstrapNegotiateInput,
  success: WsBootstrapNegotiateResult,
  error: WsCompatibilityError,
});

export const WsOrchestrationImportThreadRpc = Rpc.make(ORCHESTRATION_WS_METHODS.importThread, {
  payload: OrchestrationImportThreadInput,
  success: OrchestrationImportThreadResult,
  error: WsRpcError,
});

export const WsFoldersListDirectoriesRpc = Rpc.make(WS_METHODS.projectsListDirectories, {
  payload: ProjectListDirectoriesInput,
  success: ProjectListDirectoriesResult,
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

export const RemotePairingRequest = Schema.Struct({
  requestId: Schema.String.check(Schema.isUUID()),
  phoneDeviceId: Schema.String,
  phoneName: Schema.String,
  phoneModel: Schema.String,
  code: Schema.String,
});
export type RemotePairingRequest = typeof RemotePairingRequest.Type;
export const WsRemoteSubscribePairingRpc = Rpc.make(WS_METHODS.remoteSubscribePairing, {
  payload: Schema.Struct({}),
  success: Schema.Struct({ request: Schema.NullOr(RemotePairingRequest) }),
  error: WsRpcError,
  stream: true,
});
export const WsRemoteAnswerPairingRpc = Rpc.make(WS_METHODS.remoteAnswerPairing, {
  payload: Schema.Struct({
    requestId: Schema.String.check(Schema.isUUID()),
    allow: Schema.Boolean,
  }),
  success: Schema.Struct({ accepted: Schema.Boolean }),
  error: WsRpcError,
});
export const RemotePhone = Schema.Struct({
  deviceId: Schema.String.check(Schema.isUUID()),
  name: Schema.String,
  connected: Schema.Boolean,
  lastConnectedAt: Schema.NullOr(Schema.String),
});
export type RemotePhone = typeof RemotePhone.Type;
export const WsRemoteListDevicesRpc = Rpc.make(WS_METHODS.remoteListDevices, {
  payload: Schema.Struct({}),
  success: Schema.Array(RemotePhone),
  error: WsRpcError,
});
export const WsRemoteRemoveDeviceRpc = Rpc.make(WS_METHODS.remoteRemoveDevice, {
  payload: Schema.Struct({ deviceId: Schema.String.check(Schema.isUUID()) }),
  success: Schema.Void,
  error: WsRpcError,
});
export const WsRemoteSubscribeDevicesRpc = Rpc.make(WS_METHODS.remoteSubscribeDevices, {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
  error: WsRpcError,
  stream: true,
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

export const WsServerListProviderUsageRpc = Rpc.make(WS_METHODS.serverListProviderUsage, {
  payload: ServerListProviderUsageInput,
  success: ServerListProviderUsageResult,
  error: WsRpcError,
});
export const WsServerSubscribeProviderUsageRpc = Rpc.make(WS_METHODS.serverSubscribeProviderUsage, {
  payload: Schema.Struct({}),
  success: ServerProviderUsageChange,
  error: WsRpcError,
  stream: true,
});

export const WsServerTranscribeVoiceRpc = Rpc.make(WS_METHODS.serverTranscribeVoice, {
  payload: ServerVoiceTranscriptionInput,
  success: ServerVoiceTranscriptionResult,
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

export const WsProviderListSkillsCatalogRpc = Rpc.make(WS_METHODS.providerListSkillsCatalog, {
  payload: ProviderSkillsCatalogInput,
  success: ProviderSkillsCatalogResult,
  error: WsRpcError,
});

export const WsProviderGetCatalogRpc = Rpc.make(WS_METHODS.providerGetCatalog, {
  payload: ProviderGetCatalogInput,
  success: ProviderCatalogSnapshot,
  error: WsRpcError,
});

export const WsProviderReloadCatalogRpc = Rpc.make(WS_METHODS.providerReloadCatalog, {
  payload: ProviderCatalogScope,
  success: ProviderCatalogSnapshot,
  error: WsRpcError,
});

export const WsProviderGetConnectionsRpc = Rpc.make(WS_METHODS.providerGetConnections, {
  payload: ProviderConnectionsSnapshotInput,
  success: ProviderConnectionsSnapshot,
  error: WsRpcError,
});
export const WsProviderRetryAuthConnectionRpc = Rpc.make(WS_METHODS.providerRetryAuthConnection, {
  payload: RetryProviderAuthConnectionInput,
  success: Schema.Void,
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
export const WsProviderSubscribeConnectionLoginRpc = Rpc.make(
  WS_METHODS.providerSubscribeConnectionLogin,
  {
    payload: GetProviderConnectionLoginInput,
    success: ProviderConnectionLoginSnapshot,
    error: WsRpcError,
    stream: true,
  },
);

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
export const WsCleanCoreGetThreadRpc = Rpc.make(WS_METHODS.cleanCoreGetThread, {
  payload: CleanCoreGetThreadShellInput,
  success: Schema.NullOr(CleanCoreThreadSummary),
  error: WsRpcError,
});
export const WsCleanCoreSendMessageRpc = Rpc.make(WS_METHODS.cleanCoreSendMessage, {
  payload: CleanCoreUserSendMessageInput,
  success: CleanCoreSendAdmission,
  error: WsRpcError,
});
export const WsCleanCoreSteerQueuedRpc = Rpc.make(WS_METHODS.cleanCoreSteerQueued, {
  payload: CleanCoreQueuedMessageInput,
  success: CleanCoreSendAdmission,
  error: WsRpcError,
});
export const WsCleanCoreCancelQueuedMessageRpc = Rpc.make(WS_METHODS.cleanCoreCancelQueuedMessage, {
  payload: CleanCoreQueuedMessageInput,
  success: CleanCoreQueuedMessageResult,
  error: WsRpcError,
});
export const WsCleanCoreEditQueuedMessageRpc = Rpc.make(WS_METHODS.cleanCoreEditQueuedMessage, {
  payload: CleanCoreEditQueuedMessageInput,
  success: CleanCoreQueuedMessageResult,
  error: Schema.Union([WsRpcError, QueuedEditDraftNotEmptyError]),
});
export const WsCleanCoreSavePromptRpc = Rpc.make(WS_METHODS.cleanCoreSavePrompt, {
  payload: CleanCoreSavePromptInput,
  success: CleanCoreQueuedMessageResult,
  error: WsRpcError,
});
export const WsCleanCoreRestoreSavedPromptRpc = Rpc.make(WS_METHODS.cleanCoreRestoreSavedPrompt, {
  payload: CleanCoreEditQueuedMessageInput,
  success: CleanCoreQueuedMessageResult,
  error: Schema.Union([WsRpcError, SavedRestoreDraftNotEmptyError]),
});
export const WsCleanCoreDeleteSavedPromptRpc = Rpc.make(WS_METHODS.cleanCoreDeleteSavedPrompt, {
  payload: CleanCoreQueuedMessageInput,
  success: CleanCoreQueuedMessageResult,
  error: WsRpcError,
});
export const WsCleanCoreGetNavigationRpc = Rpc.make(WS_METHODS.cleanCoreGetNavigation, {
  payload: Schema.Struct({}),
  success: CleanCoreGetNavigationResult,
  error: WsRpcError,
});
export const WsCleanCoreUpdateNavigationRpc = Rpc.make(WS_METHODS.cleanCoreUpdateNavigation, {
  payload: CleanCoreUpdateNavigationInput,
  success: CleanCoreGetNavigationResult,
  error: WsRpcError,
});

export const WsCleanCoreGetFoldersRpc = Rpc.make(WS_METHODS.cleanCoreGetFolders, {
  payload: CleanCoreGetFoldersInput,
  success: CleanCoreGetFoldersResult,
  error: WsRpcError,
});
export const WsCleanCoreGetBootstrapRpc = Rpc.make(WS_METHODS.cleanCoreGetBootstrap, {
  payload: Schema.Struct({}),
  success: CleanCoreGetBootstrapResult,
  error: WsRpcError,
});
export const WsCleanCoreGetThreadShellRpc = Rpc.make(WS_METHODS.cleanCoreGetThreadShell, {
  payload: CleanCoreGetThreadShellInput,
  success: Schema.NullOr(OrchestrationThreadShell),
  error: WsRpcError,
});
export const WsCleanCoreCreateAndSendThreadRpc = Rpc.make(WS_METHODS.cleanCoreCreateAndSendThread, {
  payload: CleanCoreCreateAndSendThreadInput,
  success: CleanCoreCreateAndSendThreadResponse,
  error: WsRpcError,
});
export const WsCleanCoreGetFolderAppTabsRpc = Rpc.make(WS_METHODS.cleanCoreGetFolderAppTabs, {
  payload: CleanCoreGetFolderAppTabsInput,
  success: Schema.NullOr(CleanCoreFolderAppTabsResult),
  error: WsRpcError,
});
export const WsCleanCoreUpdateFolderAppTabsRpc = Rpc.make(WS_METHODS.cleanCoreUpdateFolderAppTabs, {
  payload: CleanCoreUpdateFolderAppTabsInput,
  success: CleanCoreFolderAppTabsResult,
  error: WsRpcError,
});
export const WsCleanCoreCreateThreadRpc = Rpc.make(WS_METHODS.cleanCoreCreateThread, {
  payload: CleanCoreCreateThreadInput,
  success: CleanCoreCreateThreadResponse,
  error: WsRpcError,
});
export const WsCleanCoreSearchThreadsRpc = Rpc.make(WS_METHODS.cleanCoreSearchThreads, {
  payload: CleanCoreSearchThreadsInput,
  success: CleanCoreSearchThreadsResult,
  error: WsRpcError,
});
export const WsCleanCoreListArchivedNavigationRpc = Rpc.make(
  WS_METHODS.cleanCoreListArchivedNavigation,
  { payload: Schema.Struct({}), success: CleanCoreListArchivedNavigationResult, error: WsRpcError },
);
export const WsCleanCoreListArchivedThreadsRpc = Rpc.make(WS_METHODS.cleanCoreListArchivedThreads, {
  payload: CleanCoreListArchivedThreadsInput,
  success: CleanCoreListArchivedThreadsResult,
  error: WsRpcError,
});
export const WsCleanCoreRestoreThreadRpc = Rpc.make(WS_METHODS.cleanCoreRestoreThread, {
  payload: CleanCoreRestoreThreadInput,
  success: Schema.Void,
  error: WsRpcError,
});
export const WsCleanCoreListThreadsRpc = Rpc.make(WS_METHODS.cleanCoreListThreads, {
  payload: CleanCoreListThreadsInput,
  success: CleanCoreListThreadsResult,
  error: WsRpcError,
});

export const WsCleanCoreSubscribeSidebarRpc = Rpc.make(WS_METHODS.cleanCoreSubscribeSidebar, {
  payload: Schema.Struct({}),
  success: CleanCoreSidebarChange,
  error: WsRpcError,
  stream: true,
});
export const WsCleanCoreGetThreadRuntimeRpc = Rpc.make(WS_METHODS.cleanCoreGetThreadRuntime, {
  payload: CleanCoreThreadRuntimeInput,
  success: CleanCoreThreadRuntime,
  error: WsRpcError,
});
export const WsCleanCoreInterruptThreadRpc = Rpc.make(WS_METHODS.cleanCoreInterruptThread, {
  payload: CleanCoreThreadRuntimeInput,
  success: CleanCoreInterruptResult,
  error: WsRpcError,
});
export const WsCleanCoreUpdateThreadRpc = Rpc.make(WS_METHODS.cleanCoreUpdateThread, {
  payload: CleanCoreUpdateThreadInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsCleanCoreListThreadItemsPageRpc = Rpc.make(WS_METHODS.cleanCoreListThreadItemsPage, {
  payload: CleanCoreListThreadItemsPageInput,
  success: CleanCoreListThreadItemsPageResult,
  error: WsRpcError,
});
export const WsCleanCoreListTurnItemsRpc = Rpc.make(WS_METHODS.cleanCoreListTurnItems, {
  payload: CleanCoreListTurnItemsInput,
  success: CleanCoreListTurnItemsResult,
  error: WsRpcError,
});

export const WsCleanCoreGetThreadDraftRpc = Rpc.make(WS_METHODS.cleanCoreGetThreadDraft, {
  payload: CleanCoreGetThreadDraftInput,
  success: CleanCoreThreadDraft,
  error: WsRpcError,
});

export const WsCleanCoreSetThreadDraftRpc = Rpc.make(WS_METHODS.cleanCoreSetThreadDraft, {
  payload: CleanCoreSetThreadDraftInput,
  success: CleanCoreThreadDraft,
  error: WsRpcError,
});

export const WsCleanCoreSubscribeThreadRpc = Rpc.make(WS_METHODS.cleanCoreSubscribeThread, {
  payload: CleanCoreSubscribeThreadInput,
  success: CleanCoreThreadChange,
  error: WsRpcError,
  stream: true,
});

export const WsCleanCoreAnswerThreadQuestionRpc = Rpc.make(
  WS_METHODS.cleanCoreAnswerThreadQuestion,
  {
    payload: CleanCoreAnswerThreadQuestionInput,
    success: Schema.Void,
    error: WsRpcError,
  },
);

export const WsBootstrapRpcGroup = RpcGroup.make(WsBootstrapNegotiateRpc);

export const WsFeatureRpcGroup = RpcGroup.make(
  WsCleanCoreGetThreadRpc,
  WsCleanCoreSendMessageRpc,
  WsCleanCoreSteerQueuedRpc,
  WsCleanCoreCancelQueuedMessageRpc,
  WsCleanCoreEditQueuedMessageRpc,
  WsCleanCoreSavePromptRpc,
  WsCleanCoreRestoreSavedPromptRpc,
  WsCleanCoreDeleteSavedPromptRpc,
  WsCleanCoreCreateThreadRpc,
  WsCleanCoreGetFolderAppTabsRpc,
  WsCleanCoreUpdateFolderAppTabsRpc,
  WsCleanCoreCreateAndSendThreadRpc,
  WsCleanCoreGetNavigationRpc,
  WsCleanCoreUpdateNavigationRpc,
  WsCleanCoreGetFoldersRpc,
  WsCleanCoreGetThreadShellRpc,
  WsCleanCoreGetBootstrapRpc,
  WsCleanCoreListArchivedNavigationRpc,
  WsCleanCoreListArchivedThreadsRpc,
  WsCleanCoreRestoreThreadRpc,
  WsCleanCoreListThreadsRpc,
  WsCleanCoreSearchThreadsRpc,
  WsCleanCoreGetThreadRuntimeRpc,
  WsCleanCoreInterruptThreadRpc,
  WsCleanCoreUpdateThreadRpc,
  WsCleanCoreSubscribeSidebarRpc,
  WsCleanCoreListThreadItemsPageRpc,
  WsCleanCoreListTurnItemsRpc,
  WsCleanCoreGetThreadDraftRpc,
  WsCleanCoreSetThreadDraftRpc,
  WsCleanCoreSubscribeThreadRpc,
  WsCleanCoreAnswerThreadQuestionRpc,
  WsOrchestrationImportThreadRpc,
  WsFoldersListDirectoriesRpc,
  WsFoldersSearchEntriesRpc,
  WsFoldersSearchLocalEntriesRpc,
  WsFoldersReadFileRpc,
  WsFoldersCreateLocalFilePreviewGrantRpc,
  WsFoldersWriteFileRpc,
  WsSubscribeProjectWorkspaceChangesRpc,
  WsFilesystemBrowseRpc,
  WsShellOpenInEditorRpc,
  WsServerGetConfigRpc,
  WsServerGetEnvironmentRpc,
  WsServerGetSettingsRpc,
  WsRemoteSubscribePairingRpc,
  WsRemoteAnswerPairingRpc,
  WsRemoteListDevicesRpc,
  WsRemoteRemoveDeviceRpc,
  WsRemoteSubscribeDevicesRpc,
  WsServerUpdateSettingsRpc,
  WsServerGetSpaceNavigationStateRpc,
  WsServerUpdateSpaceNavigationStateRpc,
  WsServerRefreshProvidersRpc,
  WsServerListProviderUsageRpc,
  WsServerSubscribeProviderUsageRpc,
  WsServerTranscribeVoiceRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerProviderStatusesRpc,
  WsSubscribeServerSettingsRpc,
  WsProviderGetComposerCapabilitiesRpc,
  WsProviderGetCapabilityHealthRpc,
  WsProviderCompactThreadRpc,
  WsProviderListSkillsCatalogRpc,
  WsProviderGetCatalogRpc,
  WsProviderReloadCatalogRpc,
  WsProviderGetConnectionsRpc,
  WsProviderRetryAuthConnectionRpc,
  WsProviderCreateStaticConnectionRpc,
  WsProviderBeginConnectionLoginRpc,
  WsProviderSubscribeConnectionLoginRpc,
  WsProviderCancelConnectionLoginRpc,
  WsProviderTerminateConnectionRpc,
);

/** @deprecated Use WsFeatureRpcGroup. Bootstrap is intentionally a separate endpoint/group. */
export const WsRpcGroup = WsFeatureRpcGroup;
