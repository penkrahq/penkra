import { CleanCoreThreadSummary } from "./threadSummary";
import { Option, Schema, SchemaIssue } from "effect";
import { ClaudeModelOptions, CodexModelOptions, OpenCodeModelOptions } from "./model";
import { ProviderMentionReference, ProviderSkillReference } from "./providerDiscovery";
import {
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  FolderId,
  SpaceId,
  ProviderConnectionId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";

export const ORCHESTRATION_WS_METHODS = { importThread: "orchestration.importThread" } as const;

export const ProviderKind = Schema.Literals(["codex", "claudeAgent", "opencode"]);
export type ProviderKind = typeof ProviderKind.Type;
export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;
export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;
export const DEFAULT_PROVIDER_KIND: ProviderKind = "codex";

export const FolderIconDataUrl = Schema.String.check(
  Schema.isPattern(/^data:image\/(?:webp|jpeg);base64,/),
).check(Schema.isMaxLength(100_000));
export type FolderIconDataUrl = typeof FolderIconDataUrl.Type;

export const CodexModelSelection = Schema.Struct({
  provider: Schema.Literal("codex"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(CodexModelOptions),
});
export type CodexModelSelection = typeof CodexModelSelection.Type;

export const ClaudeModelSelection = Schema.Struct({
  provider: Schema.Literal("claudeAgent"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(ClaudeModelOptions),
});
export type ClaudeModelSelection = typeof ClaudeModelSelection.Type;

export const OpenCodeModelSelection = Schema.Struct({
  provider: Schema.Literal("opencode"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(OpenCodeModelOptions),
});
export type OpenCodeModelSelection = typeof OpenCodeModelSelection.Type;

export const ModelSelection = Schema.Union([
  CodexModelSelection,
  ClaudeModelSelection,
  OpenCodeModelSelection,
]);
export type ModelSelection = typeof ModelSelection.Type;

export const CodexProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
});

export const ClaudeProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  permissionMode: Schema.optional(
    Schema.Literals(["default", "acceptEdits", "bypassPermissions", "dontAsk"]),
  ),
  maxThinkingTokens: Schema.optional(NonNegativeInt),
});

export const OpenCodeProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  serverUrl: Schema.optional(TrimmedNonEmptyString),
  experimentalWebSockets: Schema.optional(Schema.Boolean),
});

export const ProviderStartOptions = Schema.Struct({
  codex: Schema.optional(CodexProviderStartOptions),
  claudeAgent: Schema.optional(ClaudeProviderStartOptions),
  opencode: Schema.optional(OpenCodeProviderStartOptions),
});
export type ProviderStartOptions = typeof ProviderStartOptions.Type;

export const RuntimeMode = Schema.Literals(["approval-required", "full-access"]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
export const ProviderRequestKind = Schema.Literals(["command", "file-read", "file-change"]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;
export const AssistantDeliveryMode = Schema.Literals(["buffered", "streaming"]);
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type;
// Queue is the default "send message" behavior; steer is an urgent redirect.
export const TurnDispatchMode = Schema.Literals(["queue", "steer"]);
export type TurnDispatchMode = typeof TurnDispatchMode.Type;
export const DEFAULT_TURN_DISPATCH_MODE: TurnDispatchMode = "queue";
// Marks who dispatched a user turn. The legacy "automation" value remains solely
// for decoding existing Penkra data; no Penkra Automation runtime is retained.
// Absent is treated as "user"; only trusted server paths can carry the flag.
export const MessageDispatchOrigin = Schema.Literals(["user", "automation", "agent"]);
export type MessageDispatchOrigin = typeof MessageDispatchOrigin.Type;

/**
 * Server-owned delivery lifecycle for one user message. This is deliberately
 * separate from turn/session state: a steer is accepted into an existing turn,
 * while a normal send starts a new one.
 */
export const MessageDeliveryState = Schema.Literals([
  "queued",
  "steering",
  "starting",
  "accepted",
  "failed",
]);
export type MessageDeliveryState = typeof MessageDeliveryState.Type;

export const MessageDelivery = Schema.Struct({
  state: MessageDeliveryState,
  /** True once this message has occupied the durable follow-up queue. */
  queued: Schema.Boolean,
  /** Causal event sequence of the latest delivery transition. */
  sequence: NonNegativeInt,
  /** Durable proof that this attempt failed before any provider turn dispatch. */
  failurePhase: Schema.optional(Schema.Literal("before-provider-dispatch")),
  /** Exact retained startup failure for diagnostics and recovery. */
  failureDetail: Schema.optional(Schema.String),
});
export type MessageDelivery = typeof MessageDelivery.Type;

const MessageDeliveryAdmission = Schema.Struct({
  state: MessageDeliveryState,
  queued: Schema.Boolean,
});
export const ThreadCreationSource = Schema.Literals(["penkra_mcp", "provider_native"]);
export type ThreadCreationSource = typeof ThreadCreationSource.Type;
export const ProviderReviewTarget = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("uncommittedChanges"),
  }),
  Schema.Struct({
    type: Schema.Literal("baseBranch"),
    branch: TrimmedNonEmptyString,
  }),
]);
export type ProviderReviewTarget = typeof ProviderReviewTarget.Type;
export const ProviderUserInputAnswer = Schema.NullOr(
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
);
export type ProviderUserInputAnswer = typeof ProviderUserInputAnswer.Type;
export const ProviderUserInputAnswers = Schema.Record(Schema.String, ProviderUserInputAnswer);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;
export const OrchestrationMessageSource = Schema.Literals(["native", "fork-import"]);
export type OrchestrationMessageSource = typeof OrchestrationMessageSource.Type;

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const PROVIDER_SEND_TURN_MAX_FILE_BYTES = 25 * 1024 * 1024;
/**
 * Safety bounds for bulk/shell hydration and thread detail without an owned
 * turn page. Explicit turn pages retain their complete causal message/activity
 * window and are bounded by page ownership plus client detail eviction instead.
 * Durable projection tables retain the complete history independently.
 */
export const ORCHESTRATION_THREAD_HYDRATION_LIMITS = {
  messages: 2_000,
  summaryActivities: 500,
  detailActivities: 2_000,
} as const;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
export const CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS = 4_000;
// Correlation id is command id by design in this model.
export const CorrelationId = CommandId;
export type CorrelationId = typeof CorrelationId.Type;

const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ChatAttachmentId = typeof ChatAttachmentId.Type;

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

export const ChatFileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
});
export type ChatFileAttachment = typeof ChatFileAttachment.Type;

export const ChatAssistantSelectionAttachment = Schema.Struct({
  type: Schema.Literal("assistant-selection"),
  id: ChatAttachmentId,
  assistantMessageId: MessageId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS)),
});
export type ChatAssistantSelectionAttachment = typeof ChatAssistantSelectionAttachment.Type;

export const UploadChatAssistantSelectionAttachment = Schema.Struct({
  type: Schema.Literal("assistant-selection"),
  assistantMessageId: MessageId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS)),
});
export type UploadChatAssistantSelectionAttachment =
  typeof UploadChatAssistantSelectionAttachment.Type;

export const ChatAttachment = Schema.Union([
  ChatImageAttachment,
  ChatFileAttachment,
  ChatAssistantSelectionAttachment,
]);
export type ChatAttachment = typeof ChatAttachment.Type;
const ChatAttachmentList = Schema.Array(ChatAttachment).check(
  Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
);
const UploadChatAttachment = Schema.Union([
  ChatImageAttachment,
  ChatFileAttachment,
  UploadChatAssistantSelectionAttachment,
]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;
const UploadChatAttachmentList = Schema.Array(UploadChatAttachment).check(
  Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
);
const TurnMessageContentCheck = Schema.makeFilter(
  (input: { readonly text: string; readonly attachments: ReadonlyArray<unknown> }) =>
    input.text.trim().length > 0 ||
    input.attachments.length > 0 ||
    new SchemaIssue.InvalidValue(Option.some(input.text), {
      message: "Turn input must include text or attachments.",
    }),
  { identifier: "TurnMessageContent" },
);

export const SPACE_NAME_MAX_LENGTH = 32;
export const SPACES_MAX_COUNT = 50;
/** Per-command cap for bulk assignment; clients chunk larger selections. */
export const FOLDER_MOVE_MAX_COUNT = 200;
export const SIDEBAR_ITEMS_MAX_COUNT = 10_000;
export const SPACE_ICON_NAMES = [
  "bag",
  "home",
  "code-brackets",
  "rocket",
  "light-bulb",
  "color-palette",
  "book",
  "lab",
  "heart",
  "star",
  "globe",
  "cloud",
  "hammer",
  "chart-2",
  "gamecontroller",
  "camera-1",
  "target",
  "tree",
  "school",
  "backpack",
] as const;
export const SpaceIconName = Schema.Literals(SPACE_ICON_NAMES);
export type SpaceIconName = typeof SpaceIconName.Type;
export const SpaceName = TrimmedNonEmptyString.check(Schema.isMaxLength(SPACE_NAME_MAX_LENGTH));
export type SpaceName = typeof SpaceName.Type;

export const OrchestrationSpace = Schema.Struct({
  id: SpaceId,
  name: SpaceName,
  icon: SpaceIconName,
  sortOrder: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationSpace = typeof OrchestrationSpace.Type;

export const OrchestrationSpaceShell = Schema.Struct({
  id: SpaceId,
  name: SpaceName,
  icon: SpaceIconName,
  sortOrder: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
});
export type OrchestrationSpaceShell = typeof OrchestrationSpaceShell.Type;

export const OrchestrationFolder = Schema.Struct({
  id: FolderId,
  title: TrimmedNonEmptyString,
  workspaceRoot: Schema.NullOr(TrimmedNonEmptyString),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  iconDataUrl: Schema.optional(Schema.NullOr(FolderIconDataUrl)),
  spaceId: SpaceId,
  sidebarSortOrder: Schema.optional(NonNegativeInt).pipe(Schema.withDecodingDefault(() => 0)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationFolder = typeof OrchestrationFolder.Type;

export const OrchestrationFolderShell = Schema.Struct({
  id: FolderId,
  title: TrimmedNonEmptyString,
  workspaceRoot: Schema.NullOr(TrimmedNonEmptyString),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  iconDataUrl: Schema.optional(Schema.NullOr(FolderIconDataUrl)),
  spaceId: SpaceId,
  sidebarSortOrder: Schema.optional(NonNegativeInt).pipe(Schema.withDecodingDefault(() => 0)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
});
export type OrchestrationFolderShell = typeof OrchestrationFolderShell.Type;

export const OrchestrationMessageRole = Schema.Literals(["user", "assistant", "system"]);
export type OrchestrationMessageRole = typeof OrchestrationMessageRole.Type;

export const OrchestrationMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  skills: Schema.optional(Schema.Array(ProviderSkillReference)),
  mentions: Schema.optional(Schema.Array(ProviderMentionReference)),
  dispatchMode: Schema.optional(TurnDispatchMode),
  dispatchOrigin: Schema.optional(MessageDispatchOrigin),
  senderThreadId: Schema.optional(ThreadId),
  delivery: Schema.optional(MessageDelivery),
  /** First durable message event sequence. Delivery sequence may supersede it for presentation. */
  sequence: Schema.optional(NonNegativeInt),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  source: OrchestrationMessageSource.pipe(Schema.withDecodingDefault(() => "native")),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationMessage = typeof OrchestrationMessage.Type;

export const OrchestrationSessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type OrchestrationSessionStatus = typeof OrchestrationSessionStatus.Type;

export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type OrchestrationSession = typeof OrchestrationSession.Type;

export const OrchestrationThreadActivityTone = Schema.Literals([
  "info",
  "tool",
  "approval",
  "error",
]);
export type OrchestrationThreadActivityTone = typeof OrchestrationThreadActivityTone.Type;

export const OrchestrationThreadActivity = Schema.Struct({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  payload: Schema.Json,
  turnId: Schema.NullOr(TurnId),
  providerTurnId: Schema.optional(Schema.NullOr(TurnId)),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;

const OrchestrationLatestTurnState = Schema.Literals([
  "queued",
  "running",
  "interrupted",
  "completed",
  "error",
  "cancelled",
]);
export type OrchestrationLatestTurnState = typeof OrchestrationLatestTurnState.Type;

export const OrchestrationLatestTurn = Schema.Struct({
  turnId: TurnId,
  providerTurnId: Schema.optional(Schema.NullOr(TurnId)),
  state: OrchestrationLatestTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
});
export type OrchestrationLatestTurn = typeof OrchestrationLatestTurn.Type;

export const ProjectionPendingInteractionKind = Schema.Literal("userInput");
export type ProjectionPendingInteractionKind = typeof ProjectionPendingInteractionKind.Type;

export const ProjectionPendingInteractionStatus = Schema.Literals([
  "pending",
  "responding",
  "confirmed",
  "retryable",
  "uncertain",
]);
export type ProjectionPendingInteractionStatus = typeof ProjectionPendingInteractionStatus.Type;

/** Unresolved provider interaction settlement exposed to thread-detail consumers. */
export const OrchestrationPendingInteraction = Schema.Struct({
  interactionKind: ProjectionPendingInteractionKind,
  requestId: TrimmedNonEmptyString,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  lifecycleGeneration: Schema.NullOr(TrimmedNonEmptyString),
  status: ProjectionPendingInteractionStatus,
  responseCommandId: Schema.NullOr(CommandId),
  responseRequestedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationPendingInteraction = typeof OrchestrationPendingInteraction.Type;

export const OrchestrationThread = Schema.Struct({
  id: ThreadId,
  folderId: FolderId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  /** Thread's current preferred Connection; null means anonymous route. */
  connectionId: Schema.optional(Schema.NullOr(ProviderConnectionId)),
  creationSource: Schema.optional(Schema.NullOr(ThreadCreationSource)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  sourceThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  sourceTurnId: Schema.optional(Schema.NullOr(TurnId)).pipe(Schema.withDecodingDefault(() => null)),
  gatewayOperationId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  gatewayOperationIndex: Schema.optional(Schema.NullOr(NonNegativeInt)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentAgentId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentNickname: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentRole: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  pendingTurnStartMessageId: Schema.optional(Schema.NullOr(MessageId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  hasPendingUserInput: Schema.optional(Schema.Boolean),
  workStatus: Schema.optional(Schema.Literals(["idle", "running", "done", "attention"])),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  deletedAt: Schema.NullOr(IsoDateTime),
  messages: Schema.Array(OrchestrationMessage),
  queuedMessageIds: Schema.optional(Schema.Array(MessageId)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  activities: Schema.Array(OrchestrationThreadActivity),
  pendingInteractions: Schema.optional(Schema.Array(OrchestrationPendingInteraction)),
  session: Schema.NullOr(OrchestrationSession),
});
export type OrchestrationThread = typeof OrchestrationThread.Type;

export const OrchestrationThreadShell = Schema.Struct({
  id: ThreadId,
  folderId: FolderId,
  spaceId: Schema.optional(Schema.NullOr(SpaceId)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  connectionId: Schema.optional(Schema.NullOr(ProviderConnectionId)),
  creationSource: Schema.optional(Schema.NullOr(ThreadCreationSource)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  sourceThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  sourceTurnId: Schema.optional(Schema.NullOr(TurnId)).pipe(Schema.withDecodingDefault(() => null)),
  gatewayOperationId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  gatewayOperationIndex: Schema.optional(Schema.NullOr(NonNegativeInt)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentAgentId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentNickname: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentRole: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  hasPendingUserInput: Schema.optional(Schema.Boolean),
  workStatus: Schema.optional(Schema.Literals(["idle", "running", "done", "attention"])),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  session: Schema.NullOr(OrchestrationSession),
});
export type OrchestrationThreadShell = typeof OrchestrationThreadShell.Type;

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  threads: Schema.Array(OrchestrationThread),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;

export const OrchestrationStartupSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  spaces: Schema.Array(OrchestrationSpaceShell),
  folders: Schema.Array(OrchestrationFolderShell),
  runningThreads: Schema.Array(CleanCoreThreadSummary),
});
export type OrchestrationStartupSnapshot = typeof OrchestrationStartupSnapshot.Type;

/** Bulk assignment into one persisted target Space, applied atomically. */

export const SidebarItemReference = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("folder"), id: FolderId }),
  Schema.Struct({ kind: Schema.Literal("thread"), id: ThreadId }),
]);
export type SidebarItemReference = typeof SidebarItemReference.Type;

export const SidebarItemParent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("space"), spaceId: SpaceId }),
  Schema.Struct({ kind: Schema.Literal("folder"), folderId: FolderId }),
]);
export type SidebarItemParent = typeof SidebarItemParent.Type;

export const SidebarItemMovePosition = Schema.Union([
  Schema.Struct({ type: Schema.Literal("before"), item: SidebarItemReference }),
  Schema.Struct({ type: Schema.Literal("after"), item: SidebarItemReference }),
  Schema.Struct({ type: Schema.Literal("start") }),
]);
export type SidebarItemMovePosition = typeof SidebarItemMovePosition.Type;

export const ThreadImportedMessage = Schema.Struct({
  messageId: MessageId,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadImportedMessage = typeof ThreadImportedMessage.Type;

export const OrchestrationGetThreadTurnsPageInput = Schema.Struct({
  threadId: ThreadId,
  before: Schema.optional(TrimmedNonEmptyString),
});
export type OrchestrationGetThreadTurnsPageInput = typeof OrchestrationGetThreadTurnsPageInput.Type;

export const OrchestrationGetThreadTurnsPageResult = Schema.Struct({
  threadId: ThreadId,
  snapshotSequence: NonNegativeInt,
  /** User-message conversation boundaries represented by this page. */
  conversationTurnCount: NonNegativeInt,
  messages: Schema.Array(OrchestrationMessage),
  activities: Schema.Array(OrchestrationThreadActivity),
  pendingInteractions: Schema.Array(OrchestrationPendingInteraction),
  hasOlder: Schema.Boolean,
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
});
export type OrchestrationGetThreadTurnsPageResult =
  typeof OrchestrationGetThreadTurnsPageResult.Type;

export const OrchestrationImportThreadInput = Schema.Struct({
  threadId: ThreadId,
  externalId: TrimmedNonEmptyString,
});
export type OrchestrationImportThreadInput = typeof OrchestrationImportThreadInput.Type;

export const OrchestrationImportThreadResult = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationImportThreadResult = typeof OrchestrationImportThreadResult.Type;

export const OrchestrationRpcSchemas = {
  importThread: { input: OrchestrationImportThreadInput, output: OrchestrationImportThreadResult },
};
