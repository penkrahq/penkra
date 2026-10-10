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
  ThreadDeckId,
  ThreadId,
  TurnId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import {
  ModelSelection,
  RuntimeMode,
  ProviderUserInputAnswers,
  OrchestrationThreadShell,
  ChatAttachment,
  ProviderStartOptions,
  AssistantDeliveryMode,
} from "./orchestration";

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

export const CleanCoreThreadSummary = Schema.Struct({
  id: ThreadId,
  spaceId: SpaceId,
  folderId: Schema.NullOr(FolderId),
  title: Schema.String,
  provider: Schema.String,
  connectionId: Schema.NullOr(ProviderConnectionId),
  model: Schema.String,
  modelOptions: Schema.NullOr(Schema.String),
  runtimeMode: Schema.String,
  workingDirectory: Schema.NullOr(Schema.String),
  state: Schema.String,
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(Schema.String),
  queue: Schema.String,
  createdBy: Schema.String,
  createdByThreadId: Schema.NullOr(ThreadId),
  parentThreadId: Schema.NullOr(ThreadId),
  deckId: Schema.NullOr(ThreadDeckId),
  deckSortOrder: Schema.Number,
  sidebarSortOrder: Schema.NullOr(Schema.Number),
  isPinned: Schema.Number,
  lastActivityAt: Schema.NullOr(IsoDateTime),
  lastMessagePreview: Schema.NullOr(Schema.String),
  lastUserMessageAt: Schema.NullOr(IsoDateTime),
  lastVisitedAt: Schema.NullOr(IsoDateTime),
  openQuestionCount: NonNegativeInt,
  archivedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CleanCoreThreadSummary = typeof CleanCoreThreadSummary.Type;

export const CleanCoreThreadListCursor = Schema.Struct({
  isPinned: Schema.Number,
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

export const CleanCoreDeckThreadCursor = Schema.Struct({
  deckSortOrder: Schema.Number,
  id: ThreadId,
});
export type CleanCoreDeckThreadCursor = typeof CleanCoreDeckThreadCursor.Type;
export const CleanCoreListDeckThreadsInput = Schema.Struct({
  deckId: ThreadDeckId,
  after: Schema.NullOr(CleanCoreDeckThreadCursor),
});
export type CleanCoreListDeckThreadsInput = typeof CleanCoreListDeckThreadsInput.Type;
export const CleanCoreListDeckThreadsResult = Schema.Struct({
  threads: Schema.Array(CleanCoreThreadSummary),
  nextCursor: Schema.NullOr(CleanCoreDeckThreadCursor),
});
export type CleanCoreListDeckThreadsResult = typeof CleanCoreListDeckThreadsResult.Type;

export const CleanCoreGetThreadShellInput = Schema.Struct({ threadId: ThreadId });
export type CleanCoreGetThreadShellInput = typeof CleanCoreGetThreadShellInput.Type;

export const CleanCoreCreateThreadInput = Schema.Struct({
  threadId: ThreadId,
  folderId: FolderId,
  deckId: ThreadDeckId,
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
  workingDirectory: Schema.NullOr(Schema.String),
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
  Schema.Struct({ type: Schema.Literal("pinned-boundary") }),
]);
export type CleanCoreThreadMovePosition = typeof CleanCoreThreadMovePosition.Type;

export const CleanCoreSidebarChange = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
  Schema.Struct({
    kind: Schema.Literal("folder"),
    folderId: FolderId,
    spaceId: SpaceId,
    sidebarSortOrder: Schema.Number,
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    kind: Schema.Literal("space"),
    spaceId: SpaceId,
    sortOrder: Schema.Number,
    updatedAt: IsoDateTime,
  }),
]);
export type CleanCoreSidebarChange = typeof CleanCoreSidebarChange.Type;

export const CleanCoreDeckMovePosition = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["start", "end"]) }),
  Schema.Struct({ type: Schema.Literals(["before", "after"]), itemId: ThreadId }),
]);
export type CleanCoreDeckMovePosition = typeof CleanCoreDeckMovePosition.Type;

export const CleanCoreThreadUpdate = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("connection"),
    threadId: ThreadId,
    connectionId: Schema.NullOr(ProviderConnectionId),
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    action: Schema.Literal("model"),
    threadId: ThreadId,
    modelSelection: ModelSelection,
    connection: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("keep") }),
      Schema.Struct({
        kind: Schema.Literal("selected"),
        connectionId: Schema.NullOr(ProviderConnectionId),
      }),
    ]),
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
    action: Schema.Literal("moveFolder"),
    folderId: FolderId,
    spaceId: SpaceId,
    position: CleanCoreThreadMovePosition,
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    action: Schema.Literal("moveSpace"),
    spaceId: SpaceId,
    position: CleanCoreThreadMovePosition,
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    action: Schema.Literal("pin"),
    threadId: ThreadId,
    isPinned: Schema.Boolean,
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
    action: Schema.Literal("workingDirectory"),
    threadId: ThreadId,
    workingDirectory: Schema.NullOr(Schema.String),
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    action: Schema.Literal("moveSidebarItem"),
    threadId: ThreadId,
    folderId: FolderId,
    position: CleanCoreThreadMovePosition,
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    action: Schema.Literal("moveDeckThread"),
    threadId: ThreadId,
    deckId: ThreadDeckId,
    position: CleanCoreDeckMovePosition,
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
  answers: ProviderUserInputAnswers,
});
export type CleanCoreAnswerThreadQuestionInput = typeof CleanCoreAnswerThreadQuestionInput.Type;

/** Push channels for the clean-core live updates. */
export const CLEAN_CORE_WS_CHANNELS = {
  threadChange: "cleanCore.threadChange",
  sidebarChange: "cleanCore.sidebarChange",
} as const;

/** Provider-confirmed send outcomes (TODO 2.4); queued messages have no turn yet. */
export const CleanCoreSendResult = Schema.Union([
  Schema.Struct({
    threadId: ThreadId,
    messageId: Schema.String,
    delivery: Schema.Literals(["started", "steered", "interrupted"]),
    turnId: TurnId,
  }),
  Schema.Struct({
    threadId: ThreadId,
    messageId: Schema.String,
    delivery: Schema.Literal("queued"),
    position: PositiveInt,
    queueLength: PositiveInt,
    runningTurnId: Schema.NullOr(TurnId),
  }),
  Schema.Struct({
    threadId: ThreadId,
    messageId: Schema.String,
    delivery: Schema.Literal("failed"),
    error: Schema.String,
  }),
]);
export type CleanCoreSendResult = typeof CleanCoreSendResult.Type;

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
