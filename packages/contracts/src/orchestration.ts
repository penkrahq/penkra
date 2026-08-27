import { Option, Schema, SchemaIssue } from "effect";
import { ClaudeModelOptions, CodexModelOptions, OpenCodeModelOptions } from "./model";
import { ProviderMentionReference, ProviderSkillReference } from "./providerDiscovery";
import {
  ApprovalRequestId,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  FolderId,
  SpaceId,
  ProviderItemId,
  ProviderConnectionId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";

export const ORCHESTRATION_WS_METHODS = {
  getSnapshot: "orchestration.getSnapshot",
  getShellSnapshot: "orchestration.getShellSnapshot",
  getThreadDetailSnapshot: "orchestration.getThreadDetailSnapshot",
  getThreadTurnsPage: "orchestration.getThreadTurnsPage",
  dispatchCommand: "orchestration.dispatchCommand",
  importThread: "orchestration.importThread",
  repairState: "orchestration.repairState",
  replayEvents: "orchestration.replayEvents",
  listProviderDeliveryBlockers: "orchestration.listProviderDeliveryBlockers",
  reconcileProviderDelivery: "orchestration.reconcileProviderDelivery",
  subscribeSync: "orchestration.subscribeSync",
  acknowledgeSync: "orchestration.acknowledgeSync",
  subscribeShell: "orchestration.subscribeShell",
  unsubscribeShell: "orchestration.unsubscribeShell",
  subscribeThread: "orchestration.subscribeThread",
  unsubscribeThread: "orchestration.unsubscribeThread",
} as const;

export const ORCHESTRATION_WS_CHANNELS = {
  syncEvent: "orchestration.syncEvent",
  domainEvent: "orchestration.domainEvent",
  shellEvent: "orchestration.shellEvent",
  threadEvent: "orchestration.threadEvent",
} as const;

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
  /** True when this message was originally admitted to the durable follow-up queue. */
  queued: Schema.Boolean,
  /** Causal event sequence of the latest delivery transition. */
  sequence: NonNegativeInt,
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
export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;
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
 * Bounded hydration windows for thread detail held in memory or sent to clients.
 * Durable projection tables retain the complete history independently.
 */
export const ORCHESTRATION_THREAD_HYDRATION_LIMITS = {
  messages: 2_000,
  summaryActivities: 500,
  detailActivities: 2_000,
} as const;
export const MAX_PINNED_PROJECTS = 3;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
export const CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS = 4_000;
export const THREAD_NOTES_MAX_CHARS = 16_384;
export const PINNED_MESSAGES_MAX_COUNT = 100;
export const PINNED_MESSAGE_LABEL_MAX_CHARS = 60;
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

export const ProjectScriptIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectScriptIcon = typeof ProjectScriptIcon.Type;

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
});
export type ProjectScript = typeof ProjectScript.Type;

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
  scripts: Schema.Array(ProjectScript),
  iconDataUrl: Schema.optional(Schema.NullOr(FolderIconDataUrl)),
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
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
  scripts: Schema.Array(ProjectScript),
  iconDataUrl: Schema.optional(Schema.NullOr(FolderIconDataUrl)),
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
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
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
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
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;

const OrchestrationLatestTurnState = Schema.Literals([
  "running",
  "interrupted",
  "completed",
  "error",
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

/**
 * A message the user pinned to the chat's sidebar checklist. `label` is an
 * optional user override; when null the UI derives a label from the message
 * text. `done` tracks the checklist "addressed" state. Decoding defaults keep
 * older/partial persisted entries decodable as the shape evolves.
 */
export const ThreadNotes = Schema.String.check(Schema.isMaxLength(THREAD_NOTES_MAX_CHARS));
export type ThreadNotes = typeof ThreadNotes.Type;
export const PinnedMessageLabel = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PINNED_MESSAGE_LABEL_MAX_CHARS),
);
export type PinnedMessageLabel = typeof PinnedMessageLabel.Type;
export const PinnedMessage = Schema.Struct({
  messageId: MessageId,
  label: Schema.optional(Schema.NullOr(PinnedMessageLabel)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  done: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  pinnedAt: IsoDateTime,
});
export type PinnedMessage = typeof PinnedMessage.Type;
export const ThreadPinnedMessages = Schema.Array(PinnedMessage).check(
  Schema.isMaxLength(PINNED_MESSAGES_MAX_COUNT),
);
export type ThreadPinnedMessages = typeof ThreadPinnedMessages.Type;
export const ProjectionPendingInteractionKind = Schema.Literals(["approval", "userInput"]);
export type ProjectionPendingInteractionKind = typeof ProjectionPendingInteractionKind.Type;

export const ProjectionPendingInteractionStatus = Schema.Literals([
  "pending",
  "responding",
  "confirmed",
  "retryable",
  "uncertain",
]);
export type ProjectionPendingInteractionStatus = typeof ProjectionPendingInteractionStatus.Type;

export const ProjectionPendingInteractionDecision = Schema.NullOr(ProviderApprovalDecision);
export type ProjectionPendingInteractionDecision = typeof ProjectionPendingInteractionDecision.Type;

/** Unresolved provider interaction settlement exposed to thread-detail consumers. */
export const OrchestrationPendingInteraction = Schema.Struct({
  interactionKind: ProjectionPendingInteractionKind,
  requestId: ApprovalRequestId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  lifecycleGeneration: Schema.NullOr(TrimmedNonEmptyString),
  status: ProjectionPendingInteractionStatus,
  decision: ProjectionPendingInteractionDecision,
  responseCommandId: Schema.NullOr(CommandId),
  responseRequestedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationPendingInteraction = typeof OrchestrationPendingInteraction.Type;

export const OrchestrationThread = Schema.Struct({
  id: ThreadId,
  folderId: FolderId,
  sidebarSortOrder: Schema.optional(NonNegativeInt).pipe(Schema.withDecodingDefault(() => 0)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  workingDirectory: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
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
  forkSourceThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  pendingTurnStartMessageId: Schema.optional(Schema.NullOr(MessageId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  latestUserMessageAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  lastVisitedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  hasPendingApprovals: Schema.optional(Schema.Boolean),
  hasPendingUserInput: Schema.optional(Schema.Boolean),
  workStatus: Schema.optional(Schema.Literals(["idle", "running", "done", "attention"])),
  lastMessagePreview: Schema.optional(Schema.NullOr(Schema.String)),
  lastActivityAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  deletedAt: Schema.NullOr(IsoDateTime),
  pinnedMessages: Schema.optional(ThreadPinnedMessages),
  notes: Schema.optional(ThreadNotes),
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
  sidebarSortOrder: Schema.optional(NonNegativeInt).pipe(Schema.withDecodingDefault(() => 0)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  workingDirectory: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
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
  forkSourceThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  latestUserMessageAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  lastVisitedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  hasPendingApprovals: Schema.optional(Schema.Boolean),
  hasPendingUserInput: Schema.optional(Schema.Boolean),
  workStatus: Schema.optional(Schema.Literals(["idle", "running", "done", "attention"])),
  lastMessagePreview: Schema.optional(Schema.NullOr(Schema.String)),
  lastActivityAt: Schema.optional(Schema.NullOr(IsoDateTime)),
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
  spaces: Schema.Array(OrchestrationSpace),
  folders: Schema.Array(OrchestrationFolder),
  threads: Schema.Array(OrchestrationThread),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;

export const OrchestrationShellSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  spaces: Schema.Array(OrchestrationSpaceShell),
  archivedSpaces: Schema.optional(Schema.Array(OrchestrationSpaceShell)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  folders: Schema.Array(OrchestrationFolderShell),
  archivedFolders: Schema.optional(Schema.Array(OrchestrationFolderShell)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  threads: Schema.Array(OrchestrationThreadShell),
  updatedAt: IsoDateTime,
});
export type OrchestrationShellSnapshot = typeof OrchestrationShellSnapshot.Type;

export const OrchestrationShellStreamEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("space-upserted"),
    sequence: NonNegativeInt,
    space: OrchestrationSpaceShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("space-removed"),
    sequence: NonNegativeInt,
    spaceId: SpaceId,
    updatedAt: IsoDateTime,
    preserveAssignments: Schema.optional(Schema.Boolean).pipe(
      Schema.withDecodingDefault(() => false),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("space-order-updated"),
    sequence: NonNegativeInt,
    orderedSpaceIds: Schema.Array(SpaceId),
  }),
  Schema.Struct({
    kind: Schema.Literal("sidebar-layout-updated"),
    sequence: NonNegativeInt,
    folders: Schema.Array(OrchestrationFolderShell),
    threads: Schema.Array(OrchestrationThreadShell),
  }),
  Schema.Struct({
    kind: Schema.Literal("folder-upserted"),
    sequence: NonNegativeInt,
    folder: OrchestrationFolderShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("folder-removed"),
    sequence: NonNegativeInt,
    folderId: FolderId,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-upserted"),
    sequence: NonNegativeInt,
    thread: OrchestrationThreadShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-removed"),
    sequence: NonNegativeInt,
    threadId: ThreadId,
  }),
]);
export type OrchestrationShellStreamEvent = typeof OrchestrationShellStreamEvent.Type;

export const OrchestrationShellStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationShellSnapshot,
  }),
  OrchestrationShellStreamEvent,
]);
export type OrchestrationShellStreamItem = typeof OrchestrationShellStreamItem.Type;

export const SpaceCreateCommand = Schema.Struct({
  type: Schema.Literal("space.create"),
  commandId: CommandId,
  spaceId: SpaceId,
  name: SpaceName,
  icon: SpaceIconName,
  createdAt: IsoDateTime,
});

export const SpaceUpdateCommand = Schema.Struct({
  type: Schema.Literal("space.update"),
  commandId: CommandId,
  spaceId: SpaceId,
  name: Schema.optional(SpaceName),
  icon: Schema.optional(SpaceIconName),
  sortOrder: Schema.optional(NonNegativeInt),
});

export const SpaceDeleteCommand = Schema.Struct({
  type: Schema.Literal("space.delete"),
  commandId: CommandId,
  spaceId: SpaceId,
});

export const SpaceArchiveCommand = Schema.Struct({
  type: Schema.Literal("space.archive"),
  commandId: CommandId,
  spaceId: SpaceId,
});

export const SpaceRestoreCommand = Schema.Struct({
  type: Schema.Literal("space.restore"),
  commandId: CommandId,
  spaceId: SpaceId,
  name: Schema.optional(SpaceName),
});

/** Bulk assignment into one persisted target Space, applied atomically. */
export const FolderMoveCommand = Schema.Struct({
  type: Schema.Literal("folder.move"),
  commandId: CommandId,
  spaceId: SpaceId,
  folderIds: Schema.Array(FolderId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(FOLDER_MOVE_MAX_COUNT),
  ),
});

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
  Schema.Struct({ type: Schema.Literal("pinned-boundary") }),
]);
export type SidebarItemMovePosition = typeof SidebarItemMovePosition.Type;

export const SidebarItemMoveCommand = Schema.Struct({
  type: Schema.Literal("sidebar.item.move"),
  commandId: CommandId,
  item: SidebarItemReference,
  target: SidebarItemParent,
  position: SidebarItemMovePosition,
});

export const FolderCreateCommand = Schema.Struct({
  type: Schema.Literal("folder.create"),
  commandId: CommandId,
  folderId: FolderId,
  title: TrimmedNonEmptyString,
  workspaceRoot: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  spaceId: SpaceId,
  createdAt: IsoDateTime,
});

const FolderUpdateCommand = Schema.Struct({
  type: Schema.Literal("folder.update"),
  commandId: CommandId,
  folderId: FolderId,
  title: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  iconDataUrl: Schema.optional(Schema.NullOr(FolderIconDataUrl)),
  isPinned: Schema.optional(Schema.Boolean),
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});

const FolderDeleteCommand = Schema.Struct({
  type: Schema.Literal("folder.delete"),
  commandId: CommandId,
  folderId: FolderId,
});

const ThreadCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  folderId: FolderId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  workingDirectory: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  creationSource: Schema.optional(ThreadCreationSource),
  sourceThreadId: Schema.optional(ThreadId),
  sourceTurnId: Schema.optional(TurnId),
  gatewayOperationId: Schema.optional(TrimmedNonEmptyString),
  gatewayOperationIndex: Schema.optional(NonNegativeInt),
  subagentAgentId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentNickname: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentRole: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  createdAt: IsoDateTime,
});

export const ThreadImportedMessage = Schema.Struct({
  messageId: MessageId,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadImportedMessage = typeof ThreadImportedMessage.Type;

const ThreadForkCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.fork.create"),
  commandId: CommandId,
  threadId: ThreadId,
  sourceThreadId: ThreadId,
  folderId: FolderId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  workingDirectory: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  importedMessages: Schema.Array(ThreadImportedMessage),
  createdAt: IsoDateTime,
});

const ThreadDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.delete"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.archive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.unarchive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.update"),
  commandId: CommandId,
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  workingDirectory: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  isPinned: Schema.optional(Schema.Boolean),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  subagentAgentId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  subagentNickname: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  subagentRole: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  pinnedMessages: Schema.optional(ThreadPinnedMessages),
  notes: Schema.optional(ThreadNotes),
  lastVisitedAt: Schema.optional(IsoDateTime),
});

const ThreadPinnedMessageAddCommand = Schema.Struct({
  type: Schema.Literal("thread.pinned-message.add"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
});

const ThreadPinnedMessageRemoveCommand = Schema.Struct({
  type: Schema.Literal("thread.pinned-message.remove"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
});

const ThreadPinnedMessageDoneSetCommand = Schema.Struct({
  type: Schema.Literal("thread.pinned-message.done.set"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  done: Schema.Boolean,
});

const ThreadPinnedMessageLabelSetCommand = Schema.Struct({
  type: Schema.Literal("thread.pinned-message.label.set"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  label: Schema.NullOr(PinnedMessageLabel),
});

const ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

export const ThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  /** Penkra-owned identity. The engine derives it from commandId when omitted by trusted callers. */
  turnId: Schema.optional(TurnId),
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
    attachments: ChatAttachmentList,
    skills: Schema.optional(Schema.Array(ProviderSkillReference)),
    mentions: Schema.optional(Schema.Array(ProviderMentionReference)),
  }).check(TurnMessageContentCheck),
  modelSelection: Schema.optional(ModelSelection),
  connectionId: Schema.optional(Schema.NullOr(ProviderConnectionId)),
  bindingRevision: Schema.optional(NonNegativeInt),
  providerOptions: Schema.optional(ProviderStartOptions),
  reviewTarget: Schema.optional(ProviderReviewTarget),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  dispatchMode: Schema.optional(TurnDispatchMode).pipe(
    Schema.withDecodingDefault(() => DEFAULT_TURN_DISPATCH_MODE),
  ),
  // Trusted server paths may set this field. ClientThreadTurnStartCommand omits it,
  // so decoding strips any spoofed value.
  dispatchOrigin: Schema.optional(MessageDispatchOrigin),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  createdAt: IsoDateTime,
});

const ClientThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
    attachments: UploadChatAttachmentList,
    skills: Schema.optional(Schema.Array(ProviderSkillReference)),
    mentions: Schema.optional(Schema.Array(ProviderMentionReference)),
  }).check(TurnMessageContentCheck),
  modelSelection: Schema.optional(ModelSelection),
  connectionId: Schema.optional(Schema.NullOr(ProviderConnectionId)),
  bindingRevision: Schema.optional(NonNegativeInt),
  providerOptions: Schema.optional(ProviderStartOptions),
  reviewTarget: Schema.optional(ProviderReviewTarget),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  dispatchMode: Schema.optional(TurnDispatchMode).pipe(
    Schema.withDecodingDefault(() => DEFAULT_TURN_DISPATCH_MODE),
  ),
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

const ThreadTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  pendingMessageId: Schema.optional(MessageId),
  createdAt: IsoDateTime,
});

const ThreadQueuedTurnCancelCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.cancel-queued"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  createdAt: IsoDateTime,
});

const ThreadQueuedTurnSteerCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.steer-queued"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  createdAt: IsoDateTime,
});

const ThreadTaskStopCommand = Schema.Struct({
  type: Schema.Literal("thread.task.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  taskId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

const ThreadTaskBackgroundCommand = Schema.Struct({
  type: Schema.Literal("thread.task.background"),
  commandId: CommandId,
  threadId: ThreadId,
  toolUseId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

const ThreadDispatchQueuedTurnCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.dispatch-queued"),
  commandId: CommandId,
  threadId: ThreadId,
  /** Canonical identity minted when the queued turn was originally admitted. */
  turnId: Schema.optional(TurnId),
  messageId: MessageId,
  modelSelection: Schema.optional(ModelSelection),
  connectionId: Schema.optional(Schema.NullOr(ProviderConnectionId)),
  bindingRevision: Schema.optional(NonNegativeInt),
  providerOptions: Schema.optional(ProviderStartOptions),
  reviewTarget: Schema.optional(ProviderReviewTarget),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  dispatchMode: Schema.optional(TurnDispatchMode).pipe(
    Schema.withDecodingDefault(() => DEFAULT_TURN_DISPATCH_MODE),
  ),
  dispatchOrigin: Schema.optional(MessageDispatchOrigin),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  createdAt: IsoDateTime,
});

const ThreadTurnRecoverCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.recover"),
  commandId: CommandId,
  threadId: ThreadId,
  /** Identity of the new continuation turn, distinct from interruptedTurnId. */
  turnId: Schema.optional(TurnId),
  recoveryMessageId: MessageId,
  interruptedTurnId: Schema.optional(TurnId),
  connectionId: Schema.NullOr(ProviderConnectionId),
  bindingRevision: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadApprovalRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  lifecycleGeneration: Schema.optional(TrimmedNonEmptyString),
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  lifecycleGeneration: Schema.optional(TrimmedNonEmptyString),
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

const ThreadConversationRollbackCommand = Schema.Struct({
  type: Schema.Literal("thread.conversation.rollback"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  numTurns: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadMessageEditAndResendCommand = Schema.Struct({
  type: Schema.Literal("thread.message.edit-and-resend"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  modelSelection: Schema.optional(ModelSelection),
  connectionId: Schema.NullOr(ProviderConnectionId),
  bindingRevision: NonNegativeInt,
  providerOptions: Schema.optional(ProviderStartOptions),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

const ThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const ThreadActivityAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.activity.append"),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
});

const ThreadActivityReadModelTouchCommand = Schema.Struct({
  type: Schema.Literal("thread.activity-read-model.touch"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  activity: Schema.optional(OrchestrationThreadActivity),
  createdAt: IsoDateTime,
});

const DispatchableClientOrchestrationCommand = Schema.Union([
  SpaceCreateCommand,
  SpaceUpdateCommand,
  SpaceArchiveCommand,
  SpaceRestoreCommand,
  SpaceDeleteCommand,
  FolderMoveCommand,
  SidebarItemMoveCommand,
  FolderCreateCommand,
  FolderUpdateCommand,
  FolderDeleteCommand,
  ThreadCreateCommand,
  ThreadForkCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadUpdateCommand,
  ThreadPinnedMessageAddCommand,
  ThreadPinnedMessageRemoveCommand,
  ThreadPinnedMessageDoneSetCommand,
  ThreadPinnedMessageLabelSetCommand,
  ThreadRuntimeModeSetCommand,
  ThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadQueuedTurnCancelCommand,
  ThreadQueuedTurnSteerCommand,
  ThreadTaskStopCommand,
  ThreadTaskBackgroundCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadMessageEditAndResendCommand,
  ThreadActivityAppendCommand,
  ThreadSessionStopCommand,
]);
export type DispatchableClientOrchestrationCommand =
  typeof DispatchableClientOrchestrationCommand.Type;

export const ClientOrchestrationCommand = Schema.Union([
  SpaceCreateCommand,
  SpaceUpdateCommand,
  SpaceArchiveCommand,
  SpaceRestoreCommand,
  SpaceDeleteCommand,
  FolderMoveCommand,
  SidebarItemMoveCommand,
  FolderCreateCommand,
  FolderUpdateCommand,
  FolderDeleteCommand,
  ThreadCreateCommand,
  ThreadForkCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadUpdateCommand,
  ThreadPinnedMessageAddCommand,
  ThreadPinnedMessageRemoveCommand,
  ThreadPinnedMessageDoneSetCommand,
  ThreadPinnedMessageLabelSetCommand,
  ThreadRuntimeModeSetCommand,
  ClientThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadQueuedTurnCancelCommand,
  ThreadQueuedTurnSteerCommand,
  ThreadTaskStopCommand,
  ThreadTaskBackgroundCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadMessageEditAndResendCommand,
  ThreadActivityAppendCommand,
  ThreadSessionStopCommand,
]);
export type ClientOrchestrationCommand = typeof ClientOrchestrationCommand.Type;

const ThreadSessionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.session.set"),
  commandId: CommandId,
  threadId: ThreadId,
  session: OrchestrationSession,
  expectedSessionStatus: Schema.optional(OrchestrationSessionStatus),
  expectedSessionUpdatedAt: Schema.optional(IsoDateTime),
  createdAt: IsoDateTime,
});

const ThreadMessagesImportCommand = Schema.Struct({
  type: Schema.Literal("thread.messages.import"),
  commandId: CommandId,
  threadId: ThreadId,
  messages: Schema.Array(ThreadImportedMessage),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantDeltaCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.delta"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
  /** Optional caller assertion; the server derives it when omitted. */
  expectedTextByteLength: Schema.optional(NonNegativeInt),
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  /** Authoritative provider snapshot; replaces any streamed or buffered accumulator. */
  finalText: Schema.optional(Schema.String),
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadConversationRollbackCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.conversation.rollback.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  numTurns: NonNegativeInt,
  removedTurnIds: Schema.optional(Schema.Array(TurnId)),
  skipAttachmentPrune: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
});

const ThreadTurnStartCancelCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start.cancel.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  createdAt: IsoDateTime,
});

const ThreadMessageDeliverySetCommand = Schema.Struct({
  type: Schema.Literal("thread.message.delivery.set"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  state: MessageDeliveryState,
  createdAt: IsoDateTime,
});

const InternalOrchestrationCommand = Schema.Union([
  ThreadSessionSetCommand,
  ThreadMessagesImportCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadActivityAppendCommand,
  ThreadActivityReadModelTouchCommand,
  ThreadConversationRollbackCommand,
  ThreadConversationRollbackCompleteCommand,
  ThreadTurnStartCancelCompleteCommand,
  ThreadMessageDeliverySetCommand,
  ThreadDispatchQueuedTurnCommand,
  ThreadTurnRecoverCommand,
]);
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type;

export const OrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommand,
  InternalOrchestrationCommand,
]);
export type OrchestrationCommand = typeof OrchestrationCommand.Type;

export const OrchestrationEventType = Schema.Literals([
  "space.created",
  "space.updated",
  "space.archived",
  "space.restored",
  "space.deleted",
  "sidebar.layout-updated",
  "folder.created",
  "folder.updated",
  "folder.moved",
  "folder.deleted",
  "thread.created",
  "thread.deleted",
  // Legacy desktop installs can still contain these rows in orchestration_events.
  "thread.archived",
  "thread.unarchived",
  "thread.updated",
  "thread.pinned-message-added",
  "thread.pinned-message-removed",
  "thread.pinned-message-done-set",
  "thread.pinned-message-label-set",
  "thread.marker-added",
  "thread.marker-removed",
  "thread.marker-done-set",
  "thread.marker-label-set",
  "thread.runtime-mode-set",
  "thread.message-sent",
  "thread.message-delivery-set",
  "thread.turn-queued",
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.turn-cancel-queued-requested",
  "thread.turn-steer-queued-requested",
  "thread.turn-start-cancelled",
  "thread.task-stop-requested",
  "thread.task-background-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.conversation-rollback-requested",
  "thread.conversation-rolled-back",
  "thread.message-edit-resend-requested",
  "thread.session-stop-requested",
  "thread.session-set",
  "thread.activity-appended",
  "thread.activity-read-model-updated",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

export const OrchestrationAggregateKind = Schema.Literals(["space", "folder", "thread"]);
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type;
export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);

export const SpaceCreatedPayload = Schema.Struct({
  spaceId: SpaceId,
  name: SpaceName,
  icon: SpaceIconName,
  sortOrder: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const SpaceUpdatedPayload = Schema.Struct({
  spaceId: SpaceId,
  name: Schema.optional(SpaceName),
  icon: Schema.optional(SpaceIconName),
  orderedSpaceIds: Schema.optional(
    Schema.Array(SpaceId).check(Schema.isMaxLength(SPACES_MAX_COUNT)),
  ),
  updatedAt: IsoDateTime,
});

export const SpaceDeletedPayload = Schema.Struct({
  spaceId: SpaceId,
  deletedAt: IsoDateTime,
});

export const SpaceArchivedPayload = Schema.Struct({
  spaceId: SpaceId,
  archivedAt: IsoDateTime,
});

export const SpaceRestoredPayload = Schema.Struct({
  spaceId: SpaceId,
  name: Schema.optional(SpaceName),
  restoredAt: IsoDateTime,
});

export const FolderCreatedPayload = Schema.Struct({
  folderId: FolderId,
  title: TrimmedNonEmptyString,
  workspaceRoot: Schema.NullOr(TrimmedNonEmptyString),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  iconDataUrl: Schema.optional(Schema.NullOr(FolderIconDataUrl)),
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  spaceId: SpaceId,
  sidebarSortOrder: Schema.optional(NonNegativeInt).pipe(Schema.withDecodingDefault(() => 0)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const FolderUpdatedPayload = Schema.Struct({
  folderId: FolderId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  iconDataUrl: Schema.optional(Schema.NullOr(FolderIconDataUrl)),
  isPinned: Schema.optional(Schema.Boolean),
  sidebarSortOrder: Schema.optional(NonNegativeInt),
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  updatedAt: IsoDateTime,
});

export const FolderDeletedPayload = Schema.Struct({
  folderId: FolderId,
  deletedAt: IsoDateTime,
});

export const FolderMovedPayload = Schema.Struct({
  folderId: FolderId,
  spaceId: SpaceId,
  updatedAt: IsoDateTime,
});

export const SidebarLayoutUpdatedPayload = Schema.Struct({
  folderUpdates: Schema.Array(
    Schema.Struct({
      folderId: FolderId,
      sidebarSortOrder: Schema.optional(NonNegativeInt),
    }),
  ).check(Schema.isMaxLength(SIDEBAR_ITEMS_MAX_COUNT)),
  threadUpdates: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      folderId: Schema.optional(FolderId),
      sidebarSortOrder: Schema.optional(NonNegativeInt),
    }),
  ).check(Schema.isMaxLength(SIDEBAR_ITEMS_MAX_COUNT)),
  updatedAt: IsoDateTime,
});

export const ThreadCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  folderId: FolderId,
  sidebarSortOrder: Schema.optional(NonNegativeInt).pipe(Schema.withDecodingDefault(() => 0)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  workingDirectory: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  creationSource: Schema.optional(Schema.NullOr(ThreadCreationSource)),
  sourceThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  sourceTurnId: Schema.optional(Schema.NullOr(TurnId)),
  gatewayOperationId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  gatewayOperationIndex: Schema.optional(Schema.NullOr(NonNegativeInt)),
  subagentAgentId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentNickname: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentRole: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  forkSourceThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  deletedAt: IsoDateTime,
});

export const ThreadArchivedPayload = Schema.Struct({
  threadId: ThreadId,
  // Required for new events, optional for legacy events
  archivedAt: Schema.optional(IsoDateTime),
  updatedAt: Schema.optional(IsoDateTime),
});

export const ThreadUnarchivedPayload = Schema.Struct({
  threadId: ThreadId,
  // Legacy field - kept for backward compatibility with old events
  unarchivedAt: Schema.optional(IsoDateTime),
  // Required for new events
  updatedAt: Schema.optional(IsoDateTime),
});

export const ThreadUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  workingDirectory: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  isPinned: Schema.optional(Schema.Boolean),
  sidebarSortOrder: Schema.optional(NonNegativeInt),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  subagentAgentId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  subagentNickname: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  subagentRole: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  pinnedMessages: Schema.optional(ThreadPinnedMessages),
  notes: Schema.optional(ThreadNotes),
  lastVisitedAt: Schema.optional(IsoDateTime),
  updatedAt: IsoDateTime,
});

export const ThreadPinnedMessageAddedPayload = Schema.Struct({
  threadId: ThreadId,
  pin: PinnedMessage,
  updatedAt: IsoDateTime,
});

export const ThreadPinnedMessageRemovedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  updatedAt: IsoDateTime,
});

export const ThreadPinnedMessageDoneSetPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  done: Schema.Boolean,
  updatedAt: IsoDateTime,
});

export const ThreadPinnedMessageLabelSetPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  label: Schema.NullOr(PinnedMessageLabel),
  updatedAt: IsoDateTime,
});

const HistoricalThreadMarkerPayload = Schema.Record(Schema.String, Schema.Unknown);

export const ThreadRuntimeModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  updatedAt: IsoDateTime,
});

export const ThreadMessageSentPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  skills: Schema.optional(Schema.Array(ProviderSkillReference)),
  mentions: Schema.optional(Schema.Array(ProviderMentionReference)),
  dispatchMode: Schema.optional(TurnDispatchMode),
  dispatchOrigin: Schema.optional(MessageDispatchOrigin),
  delivery: Schema.optional(MessageDeliveryAdmission),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  /** UTF-8 bytes expected to exist before appending a streaming fragment. */
  expectedTextByteLength: Schema.optional(NonNegativeInt),
  source: OrchestrationMessageSource.pipe(Schema.withDecodingDefault(() => "native")),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadMessageDeliverySetPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  state: MessageDeliveryState,
  updatedAt: IsoDateTime,
});

export const ThreadTurnStartRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  /** Optional only when decoding historical events; current writers always populate it. */
  turnId: Schema.optional(TurnId),
  messageId: MessageId,
  /** Server-only continuation source. No user-visible message exists for this id. */
  recoveryOfTurnId: Schema.optional(TurnId),
  /** Invisible restart continuation, including admission before a provider turn id exists. */
  restartRecovery: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  modelSelection: Schema.optional(ModelSelection),
  connectionId: Schema.optional(Schema.NullOr(ProviderConnectionId)),
  bindingRevision: Schema.optional(NonNegativeInt),
  providerOptions: Schema.optional(ProviderStartOptions),
  reviewTarget: Schema.optional(ProviderReviewTarget),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  dispatchMode: TurnDispatchMode.pipe(Schema.withDecodingDefault(() => DEFAULT_TURN_DISPATCH_MODE)),
  dispatchOrigin: Schema.optional(MessageDispatchOrigin),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  createdAt: IsoDateTime,
});

export const ThreadTurnQueuedPayload = ThreadTurnStartRequestedPayload;

export const ThreadTurnInterruptRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  pendingMessageId: Schema.optional(MessageId),
  createdAt: IsoDateTime,
});

export const ThreadTurnStartCancelledPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  cancelledAt: IsoDateTime,
});

export const ThreadQueuedTurnMutationRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  createdAt: IsoDateTime,
});

export const ThreadTaskStopRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  taskId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

export const ThreadTaskBackgroundRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  toolUseId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

export const ThreadApprovalResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  lifecycleGeneration: Schema.optional(TrimmedNonEmptyString),
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  lifecycleGeneration: Schema.optional(TrimmedNonEmptyString),
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

export const ThreadConversationRollbackRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  numTurns: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadConversationRolledBackPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  numTurns: NonNegativeInt,
  removedTurnIds: Schema.optional(Schema.Array(TurnId)),
  skipAttachmentPrune: Schema.optional(Schema.Boolean),
});

export const ThreadMessageEditResendRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  rollbackTurnCount: Schema.optional(NonNegativeInt),
  removedTurnIds: Schema.optional(Schema.Array(TurnId)),
  modelSelection: Schema.optional(ModelSelection),
  connectionId: Schema.NullOr(ProviderConnectionId),
  bindingRevision: NonNegativeInt,
  providerOptions: Schema.optional(ProviderStartOptions),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

export const ThreadSessionStopRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const ThreadSessionSetPayload = Schema.Struct({
  threadId: ThreadId,
  session: OrchestrationSession,
});

export const ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
});

export const ThreadActivityReadModelUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  activity: Schema.optional(OrchestrationThreadActivity),
  updatedAt: IsoDateTime,
});

export const OrchestrationEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
});
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

const EventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([SpaceId, FolderId, ThreadId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const;

export const OrchestrationEvent = Schema.Union([
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("space.created"),
    payload: SpaceCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("space.updated"),
    payload: SpaceUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("space.archived"),
    payload: SpaceArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("space.restored"),
    payload: SpaceRestoredPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("space.deleted"),
    payload: SpaceDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sidebar.layout-updated"),
    payload: SidebarLayoutUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("folder.created"),
    payload: FolderCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("folder.updated"),
    payload: FolderUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("folder.moved"),
    payload: FolderMovedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("folder.deleted"),
    payload: FolderDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: ThreadCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.deleted"),
    payload: ThreadDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.archived"),
    payload: ThreadArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unarchived"),
    payload: ThreadUnarchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.updated"),
    payload: ThreadUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pinned-message-added"),
    payload: ThreadPinnedMessageAddedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pinned-message-removed"),
    payload: ThreadPinnedMessageRemovedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pinned-message-done-set"),
    payload: ThreadPinnedMessageDoneSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pinned-message-label-set"),
    payload: ThreadPinnedMessageLabelSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.marker-added"),
    // Retained only so historical marker events remain readable after the feature removal.
    payload: HistoricalThreadMarkerPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.marker-removed"),
    payload: HistoricalThreadMarkerPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.marker-done-set"),
    payload: HistoricalThreadMarkerPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.marker-label-set"),
    payload: HistoricalThreadMarkerPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-mode-set"),
    payload: ThreadRuntimeModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-sent"),
    payload: ThreadMessageSentPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-delivery-set"),
    payload: ThreadMessageDeliverySetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-queued"),
    payload: ThreadTurnQueuedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-start-requested"),
    payload: ThreadTurnStartRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-interrupt-requested"),
    payload: ThreadTurnInterruptRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-cancel-queued-requested"),
    payload: ThreadQueuedTurnMutationRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-steer-queued-requested"),
    payload: ThreadQueuedTurnMutationRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-start-cancelled"),
    payload: ThreadTurnStartCancelledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.task-stop-requested"),
    payload: ThreadTaskStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.task-background-requested"),
    payload: ThreadTaskBackgroundRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.approval-response-requested"),
    payload: ThreadApprovalResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.user-input-response-requested"),
    payload: ThreadUserInputResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.conversation-rollback-requested"),
    payload: ThreadConversationRollbackRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.conversation-rolled-back"),
    payload: ThreadConversationRolledBackPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-edit-resend-requested"),
    payload: ThreadMessageEditResendRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-stop-requested"),
    payload: ThreadSessionStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-set"),
    payload: ThreadSessionSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.activity-appended"),
    payload: ThreadActivityAppendedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.activity-read-model-updated"),
    payload: ThreadActivityReadModelUpdatedPayload,
  }),
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;

export const OrchestrationThreadDetailSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  thread: OrchestrationThread,
});
export type OrchestrationThreadDetailSnapshot = typeof OrchestrationThreadDetailSnapshot.Type;

export const OrchestrationThreadStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationThreadDetailSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    event: OrchestrationEvent,
  }),
]);
export type OrchestrationThreadStreamItem = typeof OrchestrationThreadStreamItem.Type;

export const OrchestrationCommandReceiptStatus = Schema.Literals(["accepted", "rejected"]);
export type OrchestrationCommandReceiptStatus = typeof OrchestrationCommandReceiptStatus.Type;

export const ProviderSessionRuntimeStatus = Schema.Literals([
  "starting",
  "running",
  "stopped",
  "error",
]);
export type ProviderSessionRuntimeStatus = typeof ProviderSessionRuntimeStatus.Type;

const ProjectionThreadTurnStatus = Schema.Literals([
  "running",
  "completed",
  "interrupted",
  "error",
]);
export type ProjectionThreadTurnStatus = typeof ProjectionThreadTurnStatus.Type;

export const DispatchResult = Schema.Struct({
  sequence: NonNegativeInt,
});
export type DispatchResult = typeof DispatchResult.Type;

export const OrchestrationGetSnapshotInput = Schema.Struct({});
export type OrchestrationGetSnapshotInput = typeof OrchestrationGetSnapshotInput.Type;
const OrchestrationGetSnapshotResult = OrchestrationReadModel;
export type OrchestrationGetSnapshotResult = typeof OrchestrationGetSnapshotResult.Type;

export const OrchestrationGetShellSnapshotInput = Schema.Struct({});
export type OrchestrationGetShellSnapshotInput = typeof OrchestrationGetShellSnapshotInput.Type;
const OrchestrationGetShellSnapshotResult = OrchestrationShellSnapshot;
export type OrchestrationGetShellSnapshotResult = typeof OrchestrationGetShellSnapshotResult.Type;

export const OrchestrationRepairStateInput = Schema.Struct({});
export type OrchestrationRepairStateInput = typeof OrchestrationRepairStateInput.Type;
const OrchestrationRepairStateResult = OrchestrationReadModel;
export type OrchestrationRepairStateResult = typeof OrchestrationRepairStateResult.Type;

export const OrchestrationReplayEventsInput = Schema.Struct({
  fromSequenceExclusive: NonNegativeInt,
});
export type OrchestrationReplayEventsInput = typeof OrchestrationReplayEventsInput.Type;

const OrchestrationReplayEventsResult = Schema.Array(OrchestrationEvent);
export type OrchestrationReplayEventsResult = typeof OrchestrationReplayEventsResult.Type;

export const ProviderDeliveryReconciliationOutcome = Schema.Literals([
  "accepted",
  "safe_retry",
  "abandon",
]);
export type ProviderDeliveryReconciliationOutcome =
  typeof ProviderDeliveryReconciliationOutcome.Type;

export const ProviderDeliveryBlockingEvidence = Schema.Struct({
  consumerName: Schema.String,
  eventSequence: NonNegativeInt,
  eventId: EventId,
  eventType: Schema.String,
  occurredAt: IsoDateTime,
  threadId: ThreadId,
  state: Schema.Literals(["dead", "uncertain"]),
  attemptCount: NonNegativeInt,
  lastError: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
  lastReconciliationOutcome: Schema.NullOr(ProviderDeliveryReconciliationOutcome),
  lastReconciledAt: Schema.NullOr(IsoDateTime),
  lastReconciledBy: Schema.NullOr(Schema.String),
  lastReconciliationNote: Schema.NullOr(Schema.String),
});
export type ProviderDeliveryBlockingEvidence = typeof ProviderDeliveryBlockingEvidence.Type;

export const OrchestrationListProviderDeliveryBlockersInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  limit: Schema.optional(PositiveInt),
});
export type OrchestrationListProviderDeliveryBlockersInput =
  typeof OrchestrationListProviderDeliveryBlockersInput.Type;

export const OrchestrationListProviderDeliveryBlockersResult = Schema.Array(
  ProviderDeliveryBlockingEvidence,
);
export type OrchestrationListProviderDeliveryBlockersResult =
  typeof OrchestrationListProviderDeliveryBlockersResult.Type;

export const OrchestrationReconcileProviderDeliveryInput = Schema.Struct({
  eventSequence: NonNegativeInt,
  threadId: ThreadId,
  expectedState: Schema.Literals(["dead", "uncertain"]),
  outcome: ProviderDeliveryReconciliationOutcome,
  note: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
});
export type OrchestrationReconcileProviderDeliveryInput =
  typeof OrchestrationReconcileProviderDeliveryInput.Type;

export const OrchestrationReconcileProviderDeliveryResult = Schema.Struct({
  eventSequence: NonNegativeInt,
  threadId: ThreadId,
  outcome: ProviderDeliveryReconciliationOutcome,
  state: Schema.Literals(["retry", "succeeded", "dead", "uncertain"]),
  reconciledAt: IsoDateTime,
});
export type OrchestrationReconcileProviderDeliveryResult =
  typeof OrchestrationReconcileProviderDeliveryResult.Type;

export const OrchestrationSubscribeShellInput = Schema.Struct({});
export type OrchestrationSubscribeShellInput = typeof OrchestrationSubscribeShellInput.Type;

export const OrchestrationUnsubscribeShellInput = Schema.Struct({});
export type OrchestrationUnsubscribeShellInput = typeof OrchestrationUnsubscribeShellInput.Type;

export const OrchestrationSubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationSubscribeThreadInput = typeof OrchestrationSubscribeThreadInput.Type;

export const OrchestrationGetThreadDetailSnapshotInput = OrchestrationSubscribeThreadInput;
export type OrchestrationGetThreadDetailSnapshotInput =
  typeof OrchestrationGetThreadDetailSnapshotInput.Type;

export const OrchestrationGetThreadDetailSnapshotResult = Schema.NullOr(
  OrchestrationThreadDetailSnapshot,
);
export type OrchestrationGetThreadDetailSnapshotResult =
  typeof OrchestrationGetThreadDetailSnapshotResult.Type;

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

/**
 * One authoritative cold-start projection for the uniform orchestration feed.
 * The shell contains every lightweight Thread row. Running Threads additionally
 * carry their newest complete-turn page so a renderer restart never postpones
 * live synchronization until the user visits the Thread.
 */
export const OrchestrationSyncSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  shell: OrchestrationShellSnapshot,
  activeThreadPages: Schema.Array(OrchestrationGetThreadTurnsPageResult),
});
export type OrchestrationSyncSnapshot = typeof OrchestrationSyncSnapshot.Type;

export const OrchestrationSyncStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    deliveryId: TrimmedNonEmptyString,
    snapshot: OrchestrationSyncSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    deliveryId: TrimmedNonEmptyString,
    event: OrchestrationEvent,
  }),
]);
export type OrchestrationSyncStreamItem = typeof OrchestrationSyncStreamItem.Type;

export const OrchestrationSubscribeSyncInput = Schema.Struct({
  afterSequenceExclusive: Schema.optional(NonNegativeInt),
});
export type OrchestrationSubscribeSyncInput = typeof OrchestrationSubscribeSyncInput.Type;

export const OrchestrationAcknowledgeSyncInput = Schema.Struct({
  deliveryId: TrimmedNonEmptyString,
  appliedSequence: NonNegativeInt,
});
export type OrchestrationAcknowledgeSyncInput = typeof OrchestrationAcknowledgeSyncInput.Type;

export const OrchestrationImportThreadInput = Schema.Struct({
  threadId: ThreadId,
  externalId: TrimmedNonEmptyString,
});
export type OrchestrationImportThreadInput = typeof OrchestrationImportThreadInput.Type;

export const OrchestrationImportThreadResult = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationImportThreadResult = typeof OrchestrationImportThreadResult.Type;

export const OrchestrationUnsubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationUnsubscribeThreadInput = typeof OrchestrationUnsubscribeThreadInput.Type;

export const OrchestrationRpcSchemas = {
  getSnapshot: {
    input: OrchestrationGetSnapshotInput,
    output: OrchestrationGetSnapshotResult,
  },
  getShellSnapshot: {
    input: OrchestrationGetShellSnapshotInput,
    output: OrchestrationGetShellSnapshotResult,
  },
  getThreadDetailSnapshot: {
    input: OrchestrationGetThreadDetailSnapshotInput,
    output: OrchestrationGetThreadDetailSnapshotResult,
  },
  getThreadTurnsPage: {
    input: OrchestrationGetThreadTurnsPageInput,
    output: OrchestrationGetThreadTurnsPageResult,
  },
  repairState: {
    input: OrchestrationRepairStateInput,
    output: OrchestrationRepairStateResult,
  },
  dispatchCommand: {
    input: ClientOrchestrationCommand,
    output: DispatchResult,
  },
  importThread: {
    input: OrchestrationImportThreadInput,
    output: OrchestrationImportThreadResult,
  },
  replayEvents: {
    input: OrchestrationReplayEventsInput,
    output: OrchestrationReplayEventsResult,
  },
  listProviderDeliveryBlockers: {
    input: OrchestrationListProviderDeliveryBlockersInput,
    output: OrchestrationListProviderDeliveryBlockersResult,
  },
  reconcileProviderDelivery: {
    input: OrchestrationReconcileProviderDeliveryInput,
    output: OrchestrationReconcileProviderDeliveryResult,
  },
  subscribeSync: {
    input: OrchestrationSubscribeSyncInput,
    output: OrchestrationSyncStreamItem,
  },
  acknowledgeSync: {
    input: OrchestrationAcknowledgeSyncInput,
    output: Schema.Void,
  },
  subscribeShell: {
    input: OrchestrationSubscribeShellInput,
    output: Schema.Void,
  },
  unsubscribeShell: {
    input: OrchestrationUnsubscribeShellInput,
    output: Schema.Void,
  },
  subscribeThread: {
    input: OrchestrationSubscribeThreadInput,
    output: Schema.Void,
  },
  unsubscribeThread: {
    input: OrchestrationUnsubscribeThreadInput,
    output: Schema.Void,
  },
} as const;
