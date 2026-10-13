import { CleanCoreThreadSummary } from "./threadSummary";
export {
  CleanCoreThreadSummary,
  CleanCoreLatestTurn,
  CleanCoreOpenQuestion,
} from "./threadSummary";
import { Schema } from "effect";
import { ProviderSkillReference, ProviderMentionReference } from "./providerDiscovery";

import {
  MessageId,
  FolderId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProviderConnectionId,
  SpaceId,
  ThreadId,
  TurnId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import {
  ModelSelection,
  ProviderReviewTarget,
  ProviderKind,
  RuntimeMode,
  OrchestrationThreadShell,
  OrchestrationFolderShell,
  OrchestrationSpaceShell,
  ChatAttachment,
  ProviderStartOptions,
  AssistantDeliveryMode,
  SpaceName,
  SpaceIconName,
  FolderIconDataUrl,
  FOLDER_MOVE_MAX_COUNT,
} from "./orchestration";

/** Bounded read page size from clean-core design 2.1 and 2.8. */
export const THREADS_PAGE_SIZE = 50;
export const CleanCoreGetFoldersInput = Schema.Struct({
  folderIds: Schema.Array(FolderId).check(Schema.isMaxLength(THREADS_PAGE_SIZE)),
});
export type CleanCoreGetFoldersInput = typeof CleanCoreGetFoldersInput.Type;
export const CleanCoreGetFoldersResult = Schema.Array(OrchestrationFolderShell);
export type CleanCoreGetFoldersResult = typeof CleanCoreGetFoldersResult.Type;

/** Clean-core bounded transcript read (0.14.4 design 2.1). */
export const CleanCoreListThreadItemsPageInput = Schema.Struct({
  threadId: ThreadId,
  beforeSeq: Schema.optional(NonNegativeInt),
});
export type CleanCoreListThreadItemsPageInput = typeof CleanCoreListThreadItemsPageInput.Type;

export const CleanCoreThreadItem = Schema.Struct({
  threadId: ThreadId,
  seq: NonNegativeInt,
  sourceId: Schema.String,
  turnId: Schema.NullOr(TurnId),
  kind: Schema.String,
  status: Schema.String,
  text: Schema.NullOr(Schema.String),
  data: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CleanCoreThreadItem = typeof CleanCoreThreadItem.Type;

export const CleanCoreListThreadItemsPageResult = Schema.Struct({
  turns: Schema.Record(Schema.String, CleanCoreThreadItem),
  items: Schema.Array(CleanCoreThreadItem),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type CleanCoreListThreadItemsPageResult = typeof CleanCoreListThreadItemsPageResult.Type;

/** One composer draft per thread (0.14.4 design 2.6). */
export const CleanCoreThreadDraft = Schema.Struct({
  draft: Schema.NullOr(Schema.String),
  draftUpdatedAt: Schema.NullOr(IsoDateTime),
});
export type CleanCoreThreadDraft = typeof CleanCoreThreadDraft.Type;

export const CleanCoreGetThreadDraftInput = Schema.Struct({
  threadId: ThreadId,
});
export type CleanCoreGetThreadDraftInput = typeof CleanCoreGetThreadDraftInput.Type;

export const CleanCoreSetThreadDraftInput = Schema.Struct({
  threadId: ThreadId,
  draft: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type CleanCoreSetThreadDraftInput = typeof CleanCoreSetThreadDraftInput.Type;

/** Live thread change signal for the push channel (0.14.4 design 2.2). */
export const CleanCoreThreadChange = Schema.Struct({ threadId: ThreadId });
export type CleanCoreThreadChange = typeof CleanCoreThreadChange.Type;

export const CleanCoreSubscribeThreadInput = Schema.Struct({ threadId: ThreadId });
export type CleanCoreSubscribeThreadInput = typeof CleanCoreSubscribeThreadInput.Type;

export const CleanCoreQueuedMessage = Schema.Struct({
  messageId: MessageId,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  senderThreadId: Schema.NullOr(ThreadId),
  dispatchOrigin: Schema.Literals(["user", "automation", "agent"]),
  queuedAt: IsoDateTime,
});
export type CleanCoreQueuedMessage = typeof CleanCoreQueuedMessage.Type;
export const CleanCoreSendMessageInput = Schema.Struct({
  threadId: ThreadId,
  draftUpdatedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  reviewTarget: Schema.optional(ProviderReviewTarget),
  runtimeMode: Schema.optional(RuntimeMode),
  message: CleanCoreQueuedMessage,
  dispatchMode: Schema.Literals(["queue", "steer"]),
  modelSelection: Schema.optional(ModelSelection),
  connectionId: Schema.optional(Schema.NullOr(ProviderConnectionId)),
  providerOptions: Schema.optional(ProviderStartOptions),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  skills: Schema.optional(Schema.Array(ProviderSkillReference)),
  mentions: Schema.optional(Schema.Array(ProviderMentionReference)),
});
export type CleanCoreSendMessageInput = typeof CleanCoreSendMessageInput.Type;
export const CleanCoreQueuedMessageInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export type CleanCoreQueuedMessageInput = typeof CleanCoreQueuedMessageInput.Type;
export const CleanCoreQueuedMessageResult = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  removed: Schema.Boolean,
});
export type CleanCoreQueuedMessageResult = typeof CleanCoreQueuedMessageResult.Type;
export const CleanCoreEditQueuedMessageInput = Schema.Struct({
  ...CleanCoreQueuedMessageInput.fields,
  updatedAt: IsoDateTime,
});
export type CleanCoreEditQueuedMessageInput = typeof CleanCoreEditQueuedMessageInput.Type;

export const CleanCoreThreadListCursor = Schema.Struct({
  sidebarSortOrder: Schema.Number,
  createdAt: IsoDateTime,
  id: ThreadId,
});
export type CleanCoreThreadListCursor = typeof CleanCoreThreadListCursor.Type;

export const CleanCoreListThreadsInput = Schema.Struct({
  spaceId: SpaceId,
  folderId: Schema.NullOr(FolderId),
  after: Schema.optional(Schema.NullOr(CleanCoreThreadListCursor)),
  limit: Schema.optional(NonNegativeInt),
});
export type CleanCoreListThreadsInput = typeof CleanCoreListThreadsInput.Type;

export const CleanCoreListThreadsResult = Schema.Struct({
  threads: Schema.Array(CleanCoreThreadSummary),
  nextCursor: Schema.NullOr(CleanCoreThreadListCursor),
});
export type CleanCoreListThreadsResult = typeof CleanCoreListThreadsResult.Type;

export const CleanCoreThreadSearchCursor = Schema.Struct({
  matchKind: Schema.Literals(["title", "message"]),
  lastActivityAt: Schema.NullOr(IsoDateTime),
  id: ThreadId,
});
export type CleanCoreThreadSearchCursor = typeof CleanCoreThreadSearchCursor.Type;
export const CleanCoreSearchThreadsInput = Schema.Struct({
  spaceId: SpaceId,
  query: Schema.String,
  cursor: Schema.NullOr(CleanCoreThreadSearchCursor),
});
export type CleanCoreSearchThreadsInput = typeof CleanCoreSearchThreadsInput.Type;
export const CleanCoreThreadSearchMatch = Schema.Struct({
  ...CleanCoreThreadSummary.fields,
  matchKind: Schema.Literals(["title", "message"]),
  messageId: Schema.NullOr(Schema.String),
  messageText: Schema.NullOr(Schema.String),
});
export type CleanCoreThreadSearchMatch = typeof CleanCoreThreadSearchMatch.Type;
export const CleanCoreSearchThreadsResult = Schema.Struct({
  threads: Schema.Array(CleanCoreThreadSearchMatch),
  nextCursor: Schema.NullOr(CleanCoreThreadSearchCursor),
});
export type CleanCoreSearchThreadsResult = typeof CleanCoreSearchThreadsResult.Type;

export const CleanCoreGetThreadShellInput = Schema.Struct({ threadId: ThreadId });
export type CleanCoreGetThreadShellInput = typeof CleanCoreGetThreadShellInput.Type;

export const CleanCoreCreateThreadInput = Schema.Struct({
  threadId: ThreadId,
  folderId: FolderId,
  title: Schema.String,
  modelSelection: ModelSelection,
  connection: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("default") }),
    Schema.Struct({
      kind: Schema.Literal("selected"),
      connectionId: Schema.NullOr(ProviderConnectionId),
    }),
  ]),
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
  creator: Schema.Union([
    Schema.Struct({ kind: Schema.Literals(["user", "provider_native"]) }),
    Schema.Struct({ kind: Schema.Literal("agent"), threadId: ThreadId }),
  ]),
});
export type CleanCoreCreateThreadInput = typeof CleanCoreCreateThreadInput.Type;
export const CleanCoreCreateThreadResult = Schema.Struct({
  thread: CleanCoreThreadSummary,
  created: Schema.Boolean,
});
export type CleanCoreCreateThreadResult = typeof CleanCoreCreateThreadResult.Type;
export const CleanCoreCreateThreadResponse = Schema.Struct({
  ...CleanCoreCreateThreadResult.fields,
  shell: OrchestrationThreadShell,
});
export type CleanCoreCreateThreadResponse = typeof CleanCoreCreateThreadResponse.Type;

export const CleanCoreThreadMovePosition = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["before", "after"]), itemId: Schema.String }),
  Schema.Struct({ type: Schema.Literals(["start", "end"]) }),
]);
export type CleanCoreThreadMovePosition = typeof CleanCoreThreadMovePosition.Type;

export const CleanCoreFolderAppPane = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("app"),
  appId: Schema.String,
  appSpaceId: Schema.String,
  appSlug: Schema.String,
  appName: Schema.String,
  appRoute: Schema.String,
});
export type CleanCoreFolderAppPane = typeof CleanCoreFolderAppPane.Type;
export const CleanCoreFolderAppTabs = Schema.Struct({
  panes: Schema.Array(CleanCoreFolderAppPane),
});
export type CleanCoreFolderAppTabs = typeof CleanCoreFolderAppTabs.Type;
export const CleanCoreGetFolderAppTabsInput = Schema.Struct({ folderId: FolderId });
export type CleanCoreGetFolderAppTabsInput = typeof CleanCoreGetFolderAppTabsInput.Type;
export const CleanCoreFolderAppTabsResult = Schema.Struct({
  folderId: FolderId,
  tabs: CleanCoreFolderAppTabs,
  updatedAt: IsoDateTime,
});
export type CleanCoreFolderAppTabsResult = typeof CleanCoreFolderAppTabsResult.Type;
export const CleanCoreUpdateFolderAppTabsInput = Schema.Struct({
  folderId: FolderId,
  updatedAt: IsoDateTime,
  update: Schema.Union([
    Schema.Struct({
      action: Schema.Literal("open"),
      pane: CleanCoreFolderAppPane,
    }),
    Schema.Struct({ action: Schema.Literal("close"), paneId: Schema.String }),
    Schema.Struct({ action: Schema.Literal("reorder"), paneIds: Schema.Array(Schema.String) }),
    Schema.Struct({
      action: Schema.Literal("navigate"),
      paneId: Schema.String,
      appRoute: Schema.String,
    }),
  ]),
});
export type CleanCoreUpdateFolderAppTabsInput = typeof CleanCoreUpdateFolderAppTabsInput.Type;

export const CleanCoreGetNavigationResult = Schema.Struct({
  spaces: Schema.Array(OrchestrationSpaceShell),
  folders: Schema.Array(OrchestrationFolderShell),
});
export type CleanCoreGetNavigationResult = typeof CleanCoreGetNavigationResult.Type;
export const CleanCoreFolderCreateUpdate = Schema.Struct({
  action: Schema.Literal("folder.create"),
  folderId: FolderId,
  title: TrimmedNonEmptyString,
  workspaceRoot: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  spaceId: SpaceId,
  createdAt: IsoDateTime,
});
export const CleanCoreFolderUpdate = Schema.Struct({
  action: Schema.Literal("folder.update"),
  folderId: FolderId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  iconDataUrl: Schema.optional(Schema.NullOr(FolderIconDataUrl)),
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export const CleanCoreNavigationUpdate = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("space.create"),
    spaceId: SpaceId,
    name: SpaceName,
    icon: SpaceIconName,
    createdAt: IsoDateTime,
  }),
  Schema.Struct({
    action: Schema.Literal("space.update"),
    spaceId: SpaceId,
    name: Schema.optional(SpaceName),
    icon: Schema.optional(SpaceIconName),
  }),
  Schema.Struct({
    action: Schema.Literal("space.archive"),
    spaceId: SpaceId,
  }),
  Schema.Struct({
    action: Schema.Literal("space.restore"),
    spaceId: SpaceId,
    name: Schema.optional(SpaceName),
  }),
  Schema.Struct({
    action: Schema.Literal("space.delete"),
    spaceId: SpaceId,
  }),
  CleanCoreFolderCreateUpdate,
  CleanCoreFolderUpdate,
  Schema.Struct({
    action: Schema.Literal("folder.move"),
    spaceId: SpaceId,
    position: Schema.optional(CleanCoreThreadMovePosition),
    folderIds: Schema.Array(FolderId).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(FOLDER_MOVE_MAX_COUNT),
    ),
  }),
  Schema.Struct({
    action: Schema.Literal("folder.move"),
    folderId: FolderId,
    spaceId: SpaceId,
    position: CleanCoreThreadMovePosition,
  }),
  Schema.Struct({
    action: Schema.Literal("space.move"),
    spaceId: SpaceId,
    position: CleanCoreThreadMovePosition,
  }),
  Schema.Struct({
    action: Schema.Literal("folder.delete"),
    folderId: FolderId,
  }),
]);
export type CleanCoreNavigationUpdate = typeof CleanCoreNavigationUpdate.Type;
export const CleanCoreUpdateNavigationInput = Schema.Struct({ update: CleanCoreNavigationUpdate });
export type CleanCoreUpdateNavigationInput = typeof CleanCoreUpdateNavigationInput.Type;

export const CleanCoreSidebarChange = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("folder.appTabs"), ...CleanCoreFolderAppTabsResult.fields }),
  Schema.Struct({ kind: Schema.Literal("navigation") }),
  Schema.Struct({ kind: Schema.Literals(["thread", "thread.created"]), threadId: ThreadId }),
]);
export type CleanCoreSidebarChange = typeof CleanCoreSidebarChange.Type;

export const CleanCoreThreadUpdate = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("resume"),
    threadId: ThreadId,
    messageId: MessageId,
    runtimeMode: Schema.optional(RuntimeMode),
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    action: Schema.Literal("stopTask"),
    threadId: ThreadId,
    taskId: Schema.String,
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    action: Schema.Literal("rename"),
    threadId: ThreadId,
    title: Schema.String,
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    action: Schema.Literal("archive"),
    threadId: ThreadId,
    archivedAt: Schema.NullOr(IsoDateTime),
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    action: Schema.Literal("delete"),
    threadId: ThreadId,
    deletedAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    action: Schema.Literal("visit"),
    threadId: ThreadId,
    visitedAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    action: Schema.Literal("runtimeMode"),
    threadId: ThreadId,
    runtimeMode: Schema.String,
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    action: Schema.Literal("moveSidebarItem"),
    threadId: ThreadId,
    folderId: FolderId,
    position: CleanCoreThreadMovePosition,
    updatedAt: IsoDateTime,
  }),
]);
export type CleanCoreThreadUpdate = typeof CleanCoreThreadUpdate.Type;

export const CleanCoreUpdateThreadInput = Schema.Struct({ update: CleanCoreThreadUpdate });
export type CleanCoreUpdateThreadInput = typeof CleanCoreUpdateThreadInput.Type;

/**
 * A clean-core answer to an open `question` item (0.14.4 design 2.5). The item
 * row is updated in place by the provider stream consumer; this call delivers
 * the answer to the provider so the turn continues.
 */
export const CleanCoreAnswerThreadQuestionInput = Schema.Struct({
  threadId: ThreadId,
  requestId: Schema.String,
  lifecycleGeneration: Schema.optional(TrimmedNonEmptyString),
  answers: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)])),
});
export type CleanCoreAnswerThreadQuestionInput = typeof CleanCoreAnswerThreadQuestionInput.Type;

/** Push channels for the clean-core live updates. */
export const CLEAN_CORE_WS_CHANNELS = {
  threadChange: "cleanCore.threadChange",
  sidebarChange: "cleanCore.sidebarChange",
} as const;

/** Provider-confirmed send outcomes (TODO 2.4); queued messages have no turn yet. */
export const CleanCoreSendAdmission = Schema.Union([
  Schema.Struct({
    threadId: ThreadId,
    messageId: Schema.String,
    plan: Schema.Literals(["deliver", "steer", "interrupt-deliver"]),
    seq: NonNegativeInt,
  }),
  Schema.Struct({
    threadId: ThreadId,
    messageId: Schema.String,
    plan: Schema.Literal("queue"),
    position: PositiveInt,
    queueLength: PositiveInt,
  }),
]);
export type CleanCoreSendAdmission = typeof CleanCoreSendAdmission.Type;

export const CleanCoreCreateAndSendThreadInput = Schema.Struct({
  thread: CleanCoreCreateThreadInput,
  draftUpdatedAt: CleanCoreSendMessageInput.fields.draftUpdatedAt,
  runtimeMode: CleanCoreSendMessageInput.fields.runtimeMode,
  message: CleanCoreSendMessageInput.fields.message,
  dispatchMode: CleanCoreSendMessageInput.fields.dispatchMode,
  modelSelection: CleanCoreSendMessageInput.fields.modelSelection,
  connectionId: CleanCoreSendMessageInput.fields.connectionId,
  providerOptions: CleanCoreSendMessageInput.fields.providerOptions,
  assistantDeliveryMode: CleanCoreSendMessageInput.fields.assistantDeliveryMode,
  skills: CleanCoreSendMessageInput.fields.skills,
  mentions: CleanCoreSendMessageInput.fields.mentions,
});
export type CleanCoreCreateAndSendThreadInput = typeof CleanCoreCreateAndSendThreadInput.Type;
export const CleanCoreCreateAndSendThreadResponse = Schema.Struct({
  ...CleanCoreCreateThreadResponse.fields,
  sendResult: CleanCoreSendAdmission,
});
export type CleanCoreCreateAndSendThreadResponse = typeof CleanCoreCreateAndSendThreadResponse.Type;

export const CleanCoreThreadRuntimeInput = Schema.Struct({ threadId: ThreadId });
export type CleanCoreThreadRuntimeInput = typeof CleanCoreThreadRuntimeInput.Type;
export const CleanCoreThreadRuntime = Schema.Struct({
  state: Schema.Literals(["idle", "running", "error"]),
  activeTurnId: Schema.NullOr(TurnId),
});
export type CleanCoreThreadRuntime = typeof CleanCoreThreadRuntime.Type;
export const CleanCoreInterruptResult = Schema.Struct({
  threadId: ThreadId,
  interruptRequested: Schema.Boolean,
  interruptedTurnId: Schema.NullOr(TurnId),
});
export type CleanCoreInterruptResult = typeof CleanCoreInterruptResult.Type;

export const QUEUED_MESSAGE_EDIT_NONEMPTY_DRAFT_ERROR =
  "Clear or send your message before editing a queued one.";

export class QueuedEditDraftNotEmptyError extends Schema.TaggedErrorClass<QueuedEditDraftNotEmptyError>()(
  "QueuedEditDraftNotEmptyError",
  {
    message: Schema.String,
  },
) {}

export const CleanCoreArchivedSpace = Schema.Struct({
  id: SpaceId,
  name: Schema.String,
  folders: NonNegativeInt,
  chats: NonNegativeInt,
  archivedAt: IsoDateTime,
});
export const CleanCoreArchivedFolder = Schema.Struct({
  id: FolderId,
  name: Schema.String,
  space: Schema.String,
  chats: NonNegativeInt,
  archivedAt: IsoDateTime,
  iconDataUrl: Schema.NullOr(Schema.String),
});
export const CleanCoreArchivedChat = Schema.Struct({
  deletesInActiveDays: NonNegativeInt,
  id: ThreadId,
  folderId: FolderId,
  spaceId: SpaceId,
  title: Schema.String,
  folder: Schema.String,
  space: Schema.String,
  archivedAt: IsoDateTime,
  provider: ProviderKind,
  restoresFolder: Schema.Boolean,
  restoresSpace: Schema.Boolean,
});
export type CleanCoreArchivedChat = typeof CleanCoreArchivedChat.Type;
export const CleanCoreListArchivedNavigationResult = Schema.Struct({
  totalChats: NonNegativeInt,
  spaces: Schema.Array(CleanCoreArchivedSpace),
  folders: Schema.Array(CleanCoreArchivedFolder),
});
export type CleanCoreListArchivedNavigationResult =
  typeof CleanCoreListArchivedNavigationResult.Type;
export const CleanCoreArchivedThreadCursor = Schema.Struct({
  archivedAt: IsoDateTime,
  id: ThreadId,
});
export type CleanCoreArchivedThreadCursor = typeof CleanCoreArchivedThreadCursor.Type;
export const CleanCoreListArchivedThreadsInput = Schema.Struct({
  cursor: Schema.NullOr(CleanCoreArchivedThreadCursor),
});
export type CleanCoreListArchivedThreadsInput = typeof CleanCoreListArchivedThreadsInput.Type;
export const CleanCoreListArchivedThreadsResult = Schema.Struct({
  threads: Schema.Array(CleanCoreArchivedChat),
  nextCursor: Schema.NullOr(CleanCoreArchivedThreadCursor),
});
export type CleanCoreListArchivedThreadsResult = typeof CleanCoreListArchivedThreadsResult.Type;
export const CleanCoreRestoreThreadInput = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});
export type CleanCoreRestoreThreadInput = typeof CleanCoreRestoreThreadInput.Type;

export const CleanCoreGetBootstrapResult = Schema.Struct({
  runningThreads: Schema.Array(CleanCoreThreadSummary),
});
export type CleanCoreGetBootstrapResult = typeof CleanCoreGetBootstrapResult.Type;
