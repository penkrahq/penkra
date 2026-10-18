import { CleanCoreListArchivedThreadsInput, CleanCoreRestoreThreadInput } from "./cleanCore";
import { Schema, Struct } from "effect";
import { NonNegativeInt, FolderId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import {
  CLEAN_CORE_WS_CHANNELS,
  CleanCoreThreadRuntimeInput,
  CleanCoreAnswerThreadQuestionInput,
  CleanCoreGetThreadDraftInput,
  CleanCoreListThreadItemsPageInput,
  CleanCoreListTurnItemsInput,
  CleanCoreCreateThreadInput,
  CleanCoreGetFolderAppTabsInput,
  CleanCoreUpdateFolderAppTabsInput,
  CleanCoreCreateAndSendThreadInput,
  CleanCoreUserSendMessageInput,
  CleanCoreQueuedMessageInput,
  CleanCoreEditQueuedMessageInput,
  CleanCoreGetThreadShellInput,
  CleanCoreUpdateNavigationInput,
  CleanCoreGetFoldersInput,
  CleanCoreListThreadsInput,
  CleanCoreSearchThreadsInput,
  CleanCoreUpdateThreadInput,
  CleanCoreSetThreadDraftInput,
  CleanCoreSubscribeThreadInput,
  CleanCoreThreadChange,
  CleanCoreSidebarChange,
} from "./cleanCore";

import { OrchestrationImportThreadInput, ORCHESTRATION_WS_METHODS } from "./orchestration";
import {
  ProjectCreateLocalFilePreviewGrantInput,
  ProjectListDirectoriesInput,
  ProjectReadFileInput,
  ProjectSearchEntriesInput,
  ProjectSearchLocalEntriesInput,
  ProjectWriteFileInput,
  ProjectWorkspaceChangeEvent,
} from "./project";
import { FilesystemBrowseInput } from "./filesystem";
import { OpenInEditorInput } from "./editor";
import {
  ServerConfigUpdatedPayload,
  ServerLifecycleStreamEvent,
  ServerUpdateSettingsInput,
  ServerUpdateSpaceNavigationStateInput,
  ServerListProviderUsageInput,
  ServerProviderStatusesUpdatedPayload,
  ServerSettingsUpdatedPayload,
  ServerVoiceTranscriptionInput,
} from "./server";
import {
  ProviderListCommandsInput,
  ProviderGetComposerCapabilitiesInput,
  ProviderGetCapabilityHealthInput,
  ProviderListPluginsInput,
  ProviderListModelsInput,
  ProviderListAgentsInput,
  ProviderReadPluginInput,
  ProviderListSkillsInput,
  ProviderSkillsCatalogInput,
} from "./providerDiscovery";
import { ProviderCompactThreadInput } from "./provider";
import {
  CreateStaticProviderConnectionInput,
  BeginProviderConnectionLoginInput,
  GetProviderConnectionLoginInput,
  ProviderConnectionsSnapshotInput,
  RetryProviderAuthConnectionInput,
  TerminateProviderConnectionInput,
} from "./providerConnections";

// ── WebSocket RPC Method Names ───────────────────────────────────────

export const WS_METHODS = {
  projectsListDirectories: "folders.listDirectories",
  projectsSearchEntries: "folders.searchEntries",
  projectsSearchLocalEntries: "folders.searchLocalEntries",
  projectsReadFile: "folders.readFile",
  projectsCreateLocalFilePreviewGrant: "folders.createLocalFilePreviewGrant",
  projectsWriteFile: "folders.writeFile",
  subscribeProjectWorkspaceChanges: "folders.subscribeWorkspaceChanges",

  // Filesystem browse methods
  filesystemBrowse: "filesystem.browse",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Server meta
  cleanCoreGetThreadRuntime: "cleanCore.getThreadRuntime",
  cleanCoreInterruptThread: "cleanCore.interruptThread",
  cleanCoreGetThread: "cleanCore.getThread",
  cleanCoreSendMessage: "cleanCore.sendMessage",
  cleanCoreSteerQueued: "cleanCore.steerQueued",
  cleanCoreCancelQueuedMessage: "cleanCore.cancelQueuedMessage",
  cleanCoreEditQueuedMessage: "cleanCore.editQueuedMessage",
  cleanCoreGetNavigation: "cleanCore.getNavigation",
  cleanCoreUpdateNavigation: "cleanCore.updateNavigation",
  cleanCoreGetFolders: "cleanCore.getFolders",
  cleanCoreGetThreadShell: "cleanCore.getThreadShell",
  cleanCoreGetBootstrap: "cleanCore.getBootstrap",
  cleanCoreGetFolderAppTabs: "cleanCore.getFolderAppTabs",
  cleanCoreUpdateFolderAppTabs: "cleanCore.updateFolderAppTabs",
  cleanCoreCreateThread: "cleanCore.createThread",
  cleanCoreCreateAndSendThread: "cleanCore.createAndSendThread",
  cleanCoreSearchThreads: "cleanCore.searchThreads",
  cleanCoreListArchivedNavigation: "cleanCore.listArchivedNavigation",
  cleanCoreListArchivedThreads: "cleanCore.listArchivedThreads",
  cleanCoreRestoreThread: "cleanCore.restoreThread",
  cleanCoreListThreads: "cleanCore.listThreads",
  cleanCoreUpdateThread: "cleanCore.updateThread",
  cleanCoreSubscribeSidebar: "cleanCore.subscribeSidebar",
  cleanCoreListThreadItemsPage: "cleanCore.listThreadItemsPage",
  cleanCoreListTurnItems: "cleanCore.listTurnItems",
  cleanCoreGetThreadDraft: "cleanCore.getThreadDraft",
  cleanCoreSetThreadDraft: "cleanCore.setThreadDraft",
  cleanCoreSubscribeThread: "cleanCore.subscribeThread",
  cleanCoreAnswerThreadQuestion: "cleanCore.answerThreadQuestion",

  // Server meta
  serverGetConfig: "server.getConfig",
  serverGetEnvironment: "server.getEnvironment",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverGetSpaceNavigationState: "server.getSpaceNavigationState",
  serverUpdateSpaceNavigationState: "server.updateSpaceNavigationState",
  serverRefreshProviders: "server.refreshProviders",
  serverListProviderUsage: "server.listProviderUsage",
  serverTranscribeVoice: "server.transcribeVoice",
  subscribeServerLifecycle: "server.subscribeLifecycle",
  subscribeServerConfig: "server.subscribeConfig",
  subscribeServerProviderStatuses: "server.subscribeProviderStatuses",
  subscribeServerSettings: "server.subscribeSettings",

  // Provider discovery
  providerGetComposerCapabilities: "provider.getComposerCapabilities",
  providerGetCapabilityHealth: "provider.getCapabilityHealth",
  providerCompactThread: "provider.compactThread",
  providerListCommands: "provider.listCommands",
  providerListSkills: "provider.listSkills",
  providerListSkillsCatalog: "provider.listSkillsCatalog",
  providerListPlugins: "provider.listPlugins",
  providerReadPlugin: "provider.readPlugin",
  providerListModels: "provider.listModels",
  providerListAgents: "provider.listAgents",
  providerGetConnections: "provider.getConnections",
  providerRetryAuthConnection: "provider.retryAuthConnection",
  providerCreateStaticConnection: "provider.createStaticConnection",
  providerBeginConnectionLogin: "provider.beginConnectionLogin",
  providerSubscribeConnectionLogin: "provider.subscribeConnectionLogin",
  providerCancelConnectionLogin: "provider.cancelConnectionLogin",
  providerTerminateConnection: "provider.terminateConnection",
} as const;

// ── Push Event Channels ──────────────────────────────────────────────

export const WS_CHANNELS = {
  projectWorkspaceChange: "project.workspaceChange",
  serverWelcome: "server.welcome",
  serverMaintenanceUpdated: "server.maintenanceUpdated",
  serverConfigUpdated: "server.configUpdated",
  serverProviderStatusesUpdated: "server.providerStatusesUpdated",
  serverSettingsUpdated: "server.settingsUpdated",
} as const;

// -- Tagged Union of all request body schemas ─────────────────────────

const tagRequestBody = <const Tag extends string, const Fields extends Schema.Struct.Fields>(
  tag: Tag,
  schema: Schema.Struct<Fields>,
) =>
  schema.mapFields(
    Struct.assign({ _tag: Schema.tag(tag) }),
    // PreserveChecks is safe here. No existing schema should have checks depending on the tag
    { unsafePreserveChecks: true },
  );

const WebSocketRequestBody = Schema.Union([
  tagRequestBody(ORCHESTRATION_WS_METHODS.importThread, OrchestrationImportThreadInput),
  tagRequestBody(WS_METHODS.projectsListDirectories, ProjectListDirectoriesInput),
  tagRequestBody(WS_METHODS.projectsSearchEntries, ProjectSearchEntriesInput),
  tagRequestBody(WS_METHODS.projectsSearchLocalEntries, ProjectSearchLocalEntriesInput),
  tagRequestBody(WS_METHODS.projectsReadFile, ProjectReadFileInput),
  tagRequestBody(
    WS_METHODS.projectsCreateLocalFilePreviewGrant,
    ProjectCreateLocalFilePreviewGrantInput,
  ),
  tagRequestBody(WS_METHODS.projectsWriteFile, ProjectWriteFileInput),
  tagRequestBody(WS_METHODS.subscribeProjectWorkspaceChanges, Schema.Struct({})),

  // Filesystem browse
  tagRequestBody(WS_METHODS.filesystemBrowse, FilesystemBrowseInput),

  // Shell methods
  tagRequestBody(WS_METHODS.shellOpenInEditor, OpenInEditorInput),

  // Server meta
  tagRequestBody(WS_METHODS.serverGetConfig, Schema.Struct({})),
  tagRequestBody(WS_METHODS.cleanCoreGetThreadRuntime, CleanCoreThreadRuntimeInput),
  tagRequestBody(WS_METHODS.cleanCoreInterruptThread, CleanCoreThreadRuntimeInput),
  tagRequestBody(WS_METHODS.cleanCoreGetThread, CleanCoreGetThreadShellInput),
  tagRequestBody(WS_METHODS.cleanCoreSendMessage, CleanCoreUserSendMessageInput),
  tagRequestBody(WS_METHODS.cleanCoreSteerQueued, CleanCoreQueuedMessageInput),
  tagRequestBody(WS_METHODS.cleanCoreCancelQueuedMessage, CleanCoreQueuedMessageInput),
  tagRequestBody(WS_METHODS.cleanCoreEditQueuedMessage, CleanCoreEditQueuedMessageInput),
  tagRequestBody(WS_METHODS.cleanCoreGetNavigation, Schema.Struct({})),
  tagRequestBody(WS_METHODS.cleanCoreUpdateNavigation, CleanCoreUpdateNavigationInput),
  tagRequestBody(WS_METHODS.cleanCoreGetFolders, CleanCoreGetFoldersInput),
  tagRequestBody(WS_METHODS.cleanCoreGetThreadShell, CleanCoreGetThreadShellInput),
  tagRequestBody(WS_METHODS.cleanCoreGetBootstrap, Schema.Struct({})),
  tagRequestBody(WS_METHODS.cleanCoreGetFolderAppTabs, CleanCoreGetFolderAppTabsInput),
  tagRequestBody(WS_METHODS.cleanCoreUpdateFolderAppTabs, CleanCoreUpdateFolderAppTabsInput),
  tagRequestBody(WS_METHODS.cleanCoreCreateThread, CleanCoreCreateThreadInput),
  tagRequestBody(WS_METHODS.cleanCoreCreateAndSendThread, CleanCoreCreateAndSendThreadInput),
  tagRequestBody(WS_METHODS.cleanCoreSearchThreads, CleanCoreSearchThreadsInput),
  tagRequestBody(WS_METHODS.cleanCoreListArchivedNavigation, Schema.Struct({})),
  tagRequestBody(WS_METHODS.cleanCoreListArchivedThreads, CleanCoreListArchivedThreadsInput),
  tagRequestBody(WS_METHODS.cleanCoreRestoreThread, CleanCoreRestoreThreadInput),
  tagRequestBody(WS_METHODS.cleanCoreListThreads, CleanCoreListThreadsInput),
  tagRequestBody(WS_METHODS.cleanCoreUpdateThread, CleanCoreUpdateThreadInput),
  tagRequestBody(WS_METHODS.cleanCoreSubscribeSidebar, Schema.Struct({})),
  tagRequestBody(WS_METHODS.cleanCoreListThreadItemsPage, CleanCoreListThreadItemsPageInput),
  tagRequestBody(WS_METHODS.cleanCoreListTurnItems, CleanCoreListTurnItemsInput),
  tagRequestBody(WS_METHODS.cleanCoreGetThreadDraft, CleanCoreGetThreadDraftInput),
  tagRequestBody(WS_METHODS.cleanCoreSetThreadDraft, CleanCoreSetThreadDraftInput),
  tagRequestBody(WS_METHODS.cleanCoreSubscribeThread, CleanCoreSubscribeThreadInput),
  tagRequestBody(WS_METHODS.cleanCoreAnswerThreadQuestion, CleanCoreAnswerThreadQuestionInput),
  tagRequestBody(WS_METHODS.serverGetEnvironment, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverGetSettings, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverUpdateSettings, ServerUpdateSettingsInput),
  tagRequestBody(WS_METHODS.serverGetSpaceNavigationState, Schema.Struct({})),
  tagRequestBody(
    WS_METHODS.serverUpdateSpaceNavigationState,
    ServerUpdateSpaceNavigationStateInput,
  ),
  tagRequestBody(WS_METHODS.serverRefreshProviders, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverListProviderUsage, ServerListProviderUsageInput),
  tagRequestBody(WS_METHODS.serverTranscribeVoice, ServerVoiceTranscriptionInput),

  // Provider discovery
  tagRequestBody(WS_METHODS.providerGetComposerCapabilities, ProviderGetComposerCapabilitiesInput),
  tagRequestBody(WS_METHODS.providerGetCapabilityHealth, ProviderGetCapabilityHealthInput),
  tagRequestBody(WS_METHODS.providerCompactThread, ProviderCompactThreadInput),
  tagRequestBody(WS_METHODS.providerListCommands, ProviderListCommandsInput),
  tagRequestBody(WS_METHODS.providerListSkills, ProviderListSkillsInput),
  tagRequestBody(WS_METHODS.providerListSkillsCatalog, ProviderSkillsCatalogInput),
  tagRequestBody(WS_METHODS.providerListPlugins, ProviderListPluginsInput),
  tagRequestBody(WS_METHODS.providerReadPlugin, ProviderReadPluginInput),
  tagRequestBody(WS_METHODS.providerListModels, ProviderListModelsInput),
  tagRequestBody(WS_METHODS.providerListAgents, ProviderListAgentsInput),
  tagRequestBody(WS_METHODS.providerGetConnections, ProviderConnectionsSnapshotInput),
  tagRequestBody(WS_METHODS.providerRetryAuthConnection, RetryProviderAuthConnectionInput),
  tagRequestBody(WS_METHODS.providerCreateStaticConnection, CreateStaticProviderConnectionInput),
  tagRequestBody(WS_METHODS.providerBeginConnectionLogin, BeginProviderConnectionLoginInput),
  tagRequestBody(WS_METHODS.providerCancelConnectionLogin, GetProviderConnectionLoginInput),
  tagRequestBody(WS_METHODS.providerTerminateConnection, TerminateProviderConnectionInput),
]);

export const WebSocketRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  body: WebSocketRequestBody,
});
export type WebSocketRequest = typeof WebSocketRequest.Type;

export const WebSocketResponse = Schema.Struct({
  id: TrimmedNonEmptyString,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      message: Schema.String,
    }),
  ),
});
export type WebSocketResponse = typeof WebSocketResponse.Type;

export const WsPushSequence = NonNegativeInt;
export type WsPushSequence = typeof WsPushSequence.Type;

export const WsWelcomePayload = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  homeDir: Schema.optional(TrimmedNonEmptyString),
  chatWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  projectName: TrimmedNonEmptyString,
  bootstrapFolderId: Schema.optional(FolderId),
  bootstrapThreadId: Schema.optional(ThreadId),
});
export type WsWelcomePayload = typeof WsWelcomePayload.Type;

export interface WsPushPayloadByChannel {
  readonly [WS_CHANNELS.serverWelcome]: WsWelcomePayload;
  readonly [WS_CHANNELS.serverMaintenanceUpdated]: ServerLifecycleStreamEvent;
  readonly [WS_CHANNELS.serverConfigUpdated]: typeof ServerConfigUpdatedPayload.Type;
  readonly [WS_CHANNELS.serverProviderStatusesUpdated]: typeof ServerProviderStatusesUpdatedPayload.Type;
  readonly [WS_CHANNELS.serverSettingsUpdated]: typeof ServerSettingsUpdatedPayload.Type;
  readonly [WS_CHANNELS.projectWorkspaceChange]: typeof ProjectWorkspaceChangeEvent.Type;
  readonly [CLEAN_CORE_WS_CHANNELS.threadChange]: CleanCoreThreadChange;
  readonly [CLEAN_CORE_WS_CHANNELS.sidebarChange]: CleanCoreSidebarChange;
}

export type WsPushChannel = keyof WsPushPayloadByChannel;
export type WsPushData<C extends WsPushChannel> = WsPushPayloadByChannel[C];

const makeWsPushSchema = <const Channel extends string, Payload extends Schema.Schema<any>>(
  channel: Channel,
  payload: Payload,
) =>
  Schema.Struct({
    type: Schema.Literal("push"),
    sequence: WsPushSequence,
    channel: Schema.Literal(channel),
    data: payload,
  });

export const WsPushServerWelcome = makeWsPushSchema(WS_CHANNELS.serverWelcome, WsWelcomePayload);
export const WsPushServerMaintenanceUpdated = makeWsPushSchema(
  WS_CHANNELS.serverMaintenanceUpdated,
  ServerLifecycleStreamEvent,
);
export const WsPushServerConfigUpdated = makeWsPushSchema(
  WS_CHANNELS.serverConfigUpdated,
  ServerConfigUpdatedPayload,
);
export const WsPushServerProviderStatusesUpdated = makeWsPushSchema(
  WS_CHANNELS.serverProviderStatusesUpdated,
  ServerProviderStatusesUpdatedPayload,
);
export const WsPushServerSettingsUpdated = makeWsPushSchema(
  WS_CHANNELS.serverSettingsUpdated,
  ServerSettingsUpdatedPayload,
);
export const WsPushProjectWorkspaceChange = makeWsPushSchema(
  WS_CHANNELS.projectWorkspaceChange,
  ProjectWorkspaceChangeEvent,
);

export const WsPushCleanCoreSidebarChange = makeWsPushSchema(
  CLEAN_CORE_WS_CHANNELS.sidebarChange,
  CleanCoreSidebarChange,
);
export const WsPushCleanCoreThreadChange = makeWsPushSchema(
  CLEAN_CORE_WS_CHANNELS.threadChange,
  CleanCoreThreadChange,
);

export const WsPushChannelSchema = Schema.Literals([
  WS_CHANNELS.serverWelcome,
  WS_CHANNELS.serverMaintenanceUpdated,
  WS_CHANNELS.serverConfigUpdated,
  WS_CHANNELS.serverProviderStatusesUpdated,
  WS_CHANNELS.serverSettingsUpdated,
  WS_CHANNELS.projectWorkspaceChange,
  CLEAN_CORE_WS_CHANNELS.threadChange,
  CLEAN_CORE_WS_CHANNELS.sidebarChange,
]);
export type WsPushChannelSchema = typeof WsPushChannelSchema.Type;

export const WsPush = Schema.Union([
  WsPushServerWelcome,
  WsPushServerMaintenanceUpdated,
  WsPushServerConfigUpdated,
  WsPushServerProviderStatusesUpdated,
  WsPushServerSettingsUpdated,
  WsPushProjectWorkspaceChange,
  WsPushCleanCoreThreadChange,
  WsPushCleanCoreSidebarChange,
]);
export type WsPush = typeof WsPush.Type;

export type WsPushMessage<C extends WsPushChannel> = Extract<WsPush, { channel: C }>;

export const WsPushEnvelopeBase = Schema.Struct({
  type: Schema.Literal("push"),
  sequence: WsPushSequence,
  channel: WsPushChannelSchema,
  data: Schema.Unknown,
});
export type WsPushEnvelopeBase = typeof WsPushEnvelopeBase.Type;

// ── Union of all server → client messages ─────────────────────────────

export const WsResponse = Schema.Union([WebSocketResponse, WsPush]);
export type WsResponse = typeof WsResponse.Type;
