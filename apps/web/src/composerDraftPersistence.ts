// FILE: composerDraftPersistence.ts
// Purpose: Owns composer draft schema v6, migrations, partialization, merge normalization, and hydration.
// Exports: Persist middleware transitions and persisted state type.

import {
  MessageId,
  ModelSelection,
  FolderId,
  ProviderConnectionId,
  ProviderKind,
  ProviderMentionReference,
  ProviderModelOptions,
  ProviderSkillReference,
  ProviderStartOptions,
  RuntimeMode,
  SpaceId,
  ThreadId,
} from "@penkra/contracts";
import * as Schema from "effect/Schema";
import type { DeepMutable } from "effect/Types";

import {
  hydrateImagesFromPersisted,
  normalizePersistedAttachment,
  persistQueuedComposerImages,
  toStorageSafePersistedAttachment,
} from "./composerDraftAttachments";
import {
  COMPOSER_DRAFT_STORAGE_VERSION,
  hydratePastedTextsFromPersisted,
  normalizeAssistantSelections,
  normalizeDraftThreadEntryPoint,
  normalizeFileComments,
  normalizeTerminalContextsForThread,
  projectDraftThreadEntryPointFromKey,
  folderIdFromDraftThreadMappingKey,
  PersistedComposerImageAttachment,
  type ComposerDraftStoreState,
  type ComposerPromptHistorySavedDraft,
  type ComposerThreadDraftState,
  type PendingStartRecovery,
  type PendingStartRecoveryRecord,
  type UnknownPendingStartRecovery,
  type QueuedComposerTurn,
} from "./composerDraftDomain";
import {
  LegacyCodexFields,
  legacyMergeModelSelectionIntoProviderModelOptions,
  legacySyncModelSelectionOptions,
  legacyToModelSelectionByProvider,
  normalizeModelSelection,
  normalizeProviderKind,
  normalizeProviderModelOptions,
  sanitizeStickyModelSelectionMap,
} from "./composerDraftModels";
import { normalizeAssistantSelectionAttachment } from "./lib/assistantSelections";
import { normalizePastedTextContent } from "./lib/composerPastedText";
import { normalizeFileCommentSelection } from "./lib/fileComments";
import {
  ensureInlineTerminalContextPlaceholders,
  normalizeTerminalContextText,
} from "./lib/terminalContext";
import { DEFAULT_RUNTIME_MODE } from "./types";

const DraftThreadEntryPointSchema = Schema.Literals(["chat", "terminal"]);

const PersistedTerminalContextDraft = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  createdAt: Schema.String,
  terminalId: Schema.String,
  terminalLabel: Schema.String,
  lineStart: Schema.Number,
  lineEnd: Schema.Number,
});

type PersistedTerminalContextDraft = typeof PersistedTerminalContextDraft.Type;

const PersistedQueuedTerminalContextDraft = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  createdAt: Schema.String,
  terminalId: Schema.String,
  terminalLabel: Schema.String,
  lineStart: Schema.Number,
  lineEnd: Schema.Number,
  text: Schema.String,
});

type PersistedQueuedTerminalContextDraft = typeof PersistedQueuedTerminalContextDraft.Type;

const PersistedFileCommentDraft = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  startLine: Schema.Number,
  endLine: Schema.Number,
  text: Schema.String,
});

type PersistedFileCommentDraft = typeof PersistedFileCommentDraft.Type;

const PersistedPastedTextDraft = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  text: Schema.String,
  title: Schema.optionalKey(Schema.String),
});

type PersistedPastedTextDraft = typeof PersistedPastedTextDraft.Type;

const PersistedComposerFileAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  assetKey: Schema.String,
});

type PersistedComposerFileAttachment = typeof PersistedComposerFileAttachment.Type;

const PersistedAssistantSelectionDraft = Schema.Struct({
  id: Schema.String,
  assistantMessageId: Schema.String,
  text: Schema.String,
});

type PersistedAssistantSelectionDraft = typeof PersistedAssistantSelectionDraft.Type;

const PersistedQueuedComposerChatTurn = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("chat"),
  createdAt: Schema.String,
  serverAcceptedAt: Schema.optionalKey(Schema.String),
  serverMessageId: Schema.optionalKey(MessageId),
  dispatchAttempt: Schema.optionalKey(Schema.Number),
  dispatchBindingRevision: Schema.optionalKey(Schema.Number),
  previewText: Schema.String,
  prompt: Schema.String,
  images: Schema.Array(PersistedComposerImageAttachment),
  files: Schema.optionalKey(Schema.Array(PersistedComposerFileAttachment)),
  assistantSelections: Schema.optionalKey(Schema.Array(PersistedAssistantSelectionDraft)),
  terminalContexts: Schema.Array(PersistedQueuedTerminalContextDraft),
  fileComments: Schema.optionalKey(Schema.Array(PersistedFileCommentDraft)),
  pastedTexts: Schema.optionalKey(Schema.Array(PersistedPastedTextDraft)),
  skills: Schema.Array(ProviderSkillReference),
  mentions: Schema.Array(ProviderMentionReference),
  selectedProvider: ProviderKind,
  selectedModel: Schema.NullOr(Schema.String),
  selectedPromptEffort: Schema.NullOr(Schema.String),
  modelSelection: ModelSelection,
  connectionId: Schema.NullOr(ProviderConnectionId),
  providerOptionsForDispatch: Schema.optionalKey(ProviderStartOptions),
  runtimeMode: RuntimeMode,
  messageId: Schema.optionalKey(MessageId),
});

type PersistedQueuedComposerChatTurn = typeof PersistedQueuedComposerChatTurn.Type;

const PersistedQueuedComposerTurn = PersistedQueuedComposerChatTurn;

type PersistedQueuedComposerTurn = typeof PersistedQueuedComposerTurn.Type;

const PersistedComposerPromptHistorySavedDraft = Schema.Union([
  Schema.String,
  Schema.Struct({
    prompt: Schema.String,
    attachments: Schema.optionalKey(Schema.Array(PersistedComposerImageAttachment)),
    files: Schema.optionalKey(Schema.Array(PersistedComposerFileAttachment)),
    assistantSelections: Schema.optionalKey(Schema.Array(PersistedAssistantSelectionDraft)),
    terminalContexts: Schema.optionalKey(Schema.Array(PersistedTerminalContextDraft)),
    fileComments: Schema.optionalKey(Schema.Array(PersistedFileCommentDraft)),
    pastedTexts: Schema.optionalKey(Schema.Array(PersistedPastedTextDraft)),
    skills: Schema.optionalKey(Schema.Array(ProviderSkillReference)),
    mentions: Schema.optionalKey(Schema.Array(ProviderMentionReference)),
  }),
]);

type PersistedComposerPromptHistorySavedDraft =
  typeof PersistedComposerPromptHistorySavedDraft.Type;

const PersistedPendingMessageEdit = Schema.Struct({
  messageId: MessageId,
  text: Schema.String,
  priorDeliverySequence: Schema.Number,
});

const PersistedComposerThreadDraftState = Schema.Struct({
  prompt: Schema.String,
  appliedVoiceJobIds: Schema.optionalKey(Schema.Array(Schema.String)),
  // Set only while composer prompt-history browsing is active: the user's real
  // draft snapshot, kept safe while `prompt` temporarily holds a recalled history entry.
  promptHistorySavedDraft: Schema.optionalKey(PersistedComposerPromptHistorySavedDraft),
  attachments: Schema.Array(PersistedComposerImageAttachment),
  files: Schema.optionalKey(Schema.Array(PersistedComposerFileAttachment)),
  assistantSelections: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        assistantMessageId: Schema.String,
        text: Schema.String,
      }),
    ),
  ),
  terminalContexts: Schema.optionalKey(Schema.Array(PersistedTerminalContextDraft)),
  fileComments: Schema.optionalKey(Schema.Array(PersistedFileCommentDraft)),
  pastedTexts: Schema.optionalKey(Schema.Array(PersistedPastedTextDraft)),
  skills: Schema.optionalKey(Schema.Array(ProviderSkillReference)),
  mentions: Schema.optionalKey(Schema.Array(ProviderMentionReference)),
  queuedTurns: Schema.optionalKey(Schema.Array(PersistedQueuedComposerTurn)),
  // Recovery records are decoded manually so newer/malformed records remain
  // durable and visible as unresolved instead of being dropped by a generic
  // schema migration.
  pendingStartRecoveriesByMessageId: Schema.optionalKey(Schema.Unknown),
  // Retain the short-lived WIP spelling when reading an already-written
  // checkpoint; it is normalized into the per-message map below.
  pendingStartRecovery: Schema.optionalKey(Schema.Unknown),
  pendingMessageEdit: Schema.optionalKey(PersistedPendingMessageEdit),
  queuePaused: Schema.optionalKey(Schema.Boolean),
  modelSelectionByProvider: Schema.optionalKey(
    Schema.Record(ProviderKind, Schema.optionalKey(ModelSelection)),
  ),
  activeProvider: Schema.optionalKey(Schema.NullOr(ProviderKind)),
  runtimeMode: Schema.optionalKey(RuntimeMode),
});

type PersistedComposerThreadDraftState = typeof PersistedComposerThreadDraftState.Type;

const LegacyThreadModelFields = Schema.Struct({
  provider: Schema.optionalKey(ProviderKind),
  model: Schema.optionalKey(Schema.String),
  modelOptions: Schema.optionalKey(Schema.NullOr(ProviderModelOptions)),
});

type LegacyThreadModelFields = typeof LegacyThreadModelFields.Type;

type LegacyV2ThreadDraftFields = {
  modelSelection?: ModelSelection | null;
  modelOptions?: ProviderModelOptions | null;
};

type LegacyPersistedComposerThreadDraftState = PersistedComposerThreadDraftState &
  LegacyCodexFields &
  LegacyThreadModelFields &
  LegacyV2ThreadDraftFields;

const LegacyStickyModelFields = Schema.Struct({
  stickyProvider: Schema.optionalKey(ProviderKind),
  stickyModel: Schema.optionalKey(Schema.String),
  stickyModelOptions: Schema.optionalKey(Schema.NullOr(ProviderModelOptions)),
});

type LegacyStickyModelFields = typeof LegacyStickyModelFields.Type;

type LegacyV2StoreFields = {
  stickyModelSelection?: ModelSelection | null;
  stickyModelOptions?: ProviderModelOptions | null;
};

type LegacyPersistedComposerDraftStoreState = PersistedComposerDraftStoreState &
  LegacyStickyModelFields &
  LegacyV2StoreFields;

const PersistedDraftThreadState = Schema.Struct({
  folderId: FolderId,
  spaceId: Schema.optionalKey(Schema.NullOr(SpaceId)),
  createdAt: Schema.String,
  runtimeMode: RuntimeMode,
  entryPoint: DraftThreadEntryPointSchema.pipe(Schema.withDecodingDefault(() => "chat")),
  workingDirectory: Schema.optionalKey(Schema.NullOr(Schema.String)),
  promotedTo: Schema.optionalKey(ThreadId),
});

type PersistedDraftThreadState = typeof PersistedDraftThreadState.Type;

const PersistedComposerDraftStoreState = Schema.Struct({
  draftsByThreadId: Schema.Record(ThreadId, PersistedComposerThreadDraftState),
  draftThreadsByThreadId: Schema.Record(ThreadId, PersistedDraftThreadState),
  projectDraftThreadIdByFolderId: Schema.Record(FolderId, ThreadId),
  stickyModelSelectionByProvider: Schema.optionalKey(
    Schema.Record(ProviderKind, Schema.optionalKey(ModelSelection)),
  ),
  stickyConnectionByProvider: Schema.optionalKey(
    Schema.Record(ProviderKind, Schema.optionalKey(Schema.NullOr(ProviderConnectionId))),
  ),
  stickyActiveProvider: Schema.optionalKey(Schema.NullOr(ProviderKind)),
});

export type PersistedComposerDraftStoreState = typeof PersistedComposerDraftStoreState.Type;

const EMPTY_PERSISTED_DRAFT_STORE_STATE = Object.freeze<PersistedComposerDraftStoreState>({
  draftsByThreadId: {},
  draftThreadsByThreadId: {},
  projectDraftThreadIdByFolderId: {},
  stickyModelSelectionByProvider: {},
  stickyConnectionByProvider: {},
  stickyActiveProvider: null,
});

function normalizePersistedPromptHistorySavedDraft(
  value: unknown,
): DeepMutable<PersistedComposerPromptHistorySavedDraft> | null {
  if (typeof value === "string") {
    return { prompt: value, attachments: [] };
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const prompt = typeof candidate.prompt === "string" ? candidate.prompt : null;
  if (prompt === null) {
    return null;
  }
  const attachments = Array.isArray(candidate.attachments)
    ? candidate.attachments.flatMap((entry) => {
        const normalized = normalizePersistedAttachment(entry);
        return normalized ? [normalized] : [];
      })
    : [];
  const assistantSelections = Array.isArray(candidate.assistantSelections)
    ? candidate.assistantSelections.flatMap((entry) => {
        const normalized = normalizePersistedAssistantSelection(entry);
        return normalized ? [normalized] : [];
      })
    : [];
  const terminalContexts = Array.isArray(candidate.terminalContexts)
    ? candidate.terminalContexts.flatMap((entry) => {
        const normalized = normalizePersistedTerminalContextDraft(entry);
        return normalized ? [normalized] : [];
      })
    : [];
  const fileComments = Array.isArray(candidate.fileComments)
    ? candidate.fileComments.flatMap((entry) => {
        const normalized = normalizePersistedFileCommentDraft(entry);
        return normalized ? [normalized] : [];
      })
    : [];
  const pastedTexts = Array.isArray(candidate.pastedTexts)
    ? candidate.pastedTexts.flatMap((entry) => {
        const normalized = normalizePersistedPastedTextDraft(entry);
        return normalized ? [normalized] : [];
      })
    : [];
  const skills = Array.isArray(candidate.skills)
    ? candidate.skills.filter(Schema.is(ProviderSkillReference))
    : [];
  const mentions = Array.isArray(candidate.mentions)
    ? candidate.mentions.filter(Schema.is(ProviderMentionReference))
    : [];
  return {
    prompt,
    attachments,
    ...(assistantSelections.length > 0 ? { assistantSelections } : {}),
    ...(terminalContexts.length > 0 ? { terminalContexts } : {}),
    ...(fileComments.length > 0 ? { fileComments } : {}),
    ...(pastedTexts.length > 0 ? { pastedTexts } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(mentions.length > 0 ? { mentions } : {}),
  };
}

function normalizePersistedTerminalContextDraft(
  value: unknown,
): PersistedTerminalContextDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const threadId = candidate.threadId;
  const createdAt = candidate.createdAt;
  const lineStart = candidate.lineStart;
  const lineEnd = candidate.lineEnd;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof threadId !== "string" ||
    threadId.length === 0 ||
    typeof createdAt !== "string" ||
    createdAt.length === 0 ||
    typeof lineStart !== "number" ||
    !Number.isFinite(lineStart) ||
    typeof lineEnd !== "number" ||
    !Number.isFinite(lineEnd)
  ) {
    return null;
  }
  const terminalId = typeof candidate.terminalId === "string" ? candidate.terminalId.trim() : "";
  const terminalLabel =
    typeof candidate.terminalLabel === "string" ? candidate.terminalLabel.trim() : "";
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const normalizedLineStart = Math.max(1, Math.floor(lineStart));
  const normalizedLineEnd = Math.max(normalizedLineStart, Math.floor(lineEnd));
  return {
    id,
    threadId: threadId as ThreadId,
    createdAt,
    terminalId,
    terminalLabel,
    lineStart: normalizedLineStart,
    lineEnd: normalizedLineEnd,
  };
}

function normalizePersistedQueuedTerminalContextDraft(
  value: unknown,
): PersistedQueuedTerminalContextDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const base = normalizePersistedTerminalContextDraft(candidate);
  if (!base) {
    return null;
  }
  const text =
    typeof candidate.text === "string" ? normalizeTerminalContextText(candidate.text) : "";
  return {
    ...base,
    text,
  };
}

function normalizePersistedAssistantSelection(
  value: unknown,
): { id: string; assistantMessageId: string; text: string } | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id : "";
  const assistantMessageId =
    typeof candidate.assistantMessageId === "string" ? candidate.assistantMessageId : "";
  const text = typeof candidate.text === "string" ? candidate.text : "";
  if (id.length === 0) {
    return null;
  }
  const normalized = normalizeAssistantSelectionAttachment({ assistantMessageId, text });
  if (!normalized) {
    return null;
  }
  return { id, assistantMessageId: normalized.assistantMessageId, text: normalized.text };
}

function normalizePersistedFileCommentDraft(value: unknown): PersistedFileCommentDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id : "";
  if (id.length === 0) {
    return null;
  }
  const path = typeof candidate.path === "string" ? candidate.path : "";
  const text = typeof candidate.text === "string" ? candidate.text : "";
  const startLine = typeof candidate.startLine === "number" ? candidate.startLine : Number.NaN;
  const endLine = typeof candidate.endLine === "number" ? candidate.endLine : Number.NaN;
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
    return null;
  }
  const normalized = normalizeFileCommentSelection({ path, startLine, endLine, text });
  if (!normalized) {
    return null;
  }
  return { id, ...normalized };
}

function normalizePersistedPastedTextDraft(value: unknown): PersistedPastedTextDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id : "";
  const createdAt = typeof candidate.createdAt === "string" ? candidate.createdAt : "";
  const text = typeof candidate.text === "string" ? normalizePastedTextContent(candidate.text) : "";
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  if (id.length === 0 || text.length === 0) {
    return null;
  }
  return { id, createdAt, text, ...(title ? { title } : {}) };
}

function normalizePersistedQueuedTurns(
  rawQueuedTurns: unknown,
): DeepMutable<NonNullable<PersistedComposerThreadDraftState["queuedTurns"]>> | undefined {
  if (!Array.isArray(rawQueuedTurns)) {
    return undefined;
  }
  const normalizedTurns: DeepMutable<
    NonNullable<PersistedComposerThreadDraftState["queuedTurns"]>
  > = [];
  const seenIds = new Set<string>();
  for (const entry of rawQueuedTurns) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id : "";
    const kind = candidate.kind;
    const createdAt = typeof candidate.createdAt === "string" ? candidate.createdAt : "";
    const previewText = typeof candidate.previewText === "string" ? candidate.previewText : "";
    const selectedProvider = normalizeProviderKind(candidate.selectedProvider);
    const selectedModel =
      candidate.selectedModel === null
        ? null
        : typeof candidate.selectedModel === "string"
          ? candidate.selectedModel
          : null;
    const selectedPromptEffort =
      candidate.selectedPromptEffort === null
        ? null
        : typeof candidate.selectedPromptEffort === "string"
          ? candidate.selectedPromptEffort
          : null;
    const modelSelection = normalizeModelSelection(candidate.modelSelection);
    const connectionId =
      candidate.connectionId === null
        ? null
        : Schema.is(ProviderConnectionId)(candidate.connectionId)
          ? candidate.connectionId
          : undefined;
    const providerOptionsForDispatch = Schema.is(ProviderStartOptions)(
      candidate.providerOptionsForDispatch,
    )
      ? candidate.providerOptionsForDispatch
      : undefined;
    const runtimeMode =
      candidate.runtimeMode === "approval-required" || candidate.runtimeMode === "full-access"
        ? candidate.runtimeMode
        : null;
    if (
      id.length === 0 ||
      createdAt.length === 0 ||
      previewText.length === 0 ||
      selectedProvider === null ||
      modelSelection === null ||
      connectionId === undefined ||
      runtimeMode === null ||
      seenIds.has(id)
    ) {
      continue;
    }
    if (kind === "chat") {
      const serverAcceptedAt =
        typeof candidate.serverAcceptedAt === "string" && candidate.serverAcceptedAt.length > 0
          ? candidate.serverAcceptedAt
          : undefined;
      const serverMessageId = Schema.is(MessageId)(candidate.serverMessageId)
        ? candidate.serverMessageId
        : undefined;
      const dispatchAttempt =
        typeof candidate.dispatchAttempt === "number" &&
        Number.isSafeInteger(candidate.dispatchAttempt) &&
        candidate.dispatchAttempt >= 0
          ? candidate.dispatchAttempt
          : undefined;
      const dispatchBindingRevision =
        typeof candidate.dispatchBindingRevision === "number" &&
        Number.isSafeInteger(candidate.dispatchBindingRevision) &&
        candidate.dispatchBindingRevision >= 0
          ? candidate.dispatchBindingRevision
          : undefined;
      const prompt = typeof candidate.prompt === "string" ? candidate.prompt : "";
      const images = Array.isArray(candidate.images)
        ? candidate.images.flatMap((image) => {
            const normalized = normalizePersistedAttachment(image);
            return normalized ? [normalized] : [];
          })
        : [];
      const terminalContexts = Array.isArray(candidate.terminalContexts)
        ? candidate.terminalContexts.flatMap((context) => {
            const normalized = normalizePersistedQueuedTerminalContextDraft(context);
            return normalized ? [normalized] : [];
          })
        : [];
      const assistantSelections = Array.isArray(candidate.assistantSelections)
        ? candidate.assistantSelections.flatMap((selection) => {
            const normalized = normalizePersistedAssistantSelection(selection);
            return normalized ? [normalized] : [];
          })
        : [];
      const fileComments = Array.isArray(candidate.fileComments)
        ? candidate.fileComments.flatMap((comment) => {
            const normalized = normalizePersistedFileCommentDraft(comment);
            return normalized ? [normalized] : [];
          })
        : [];
      const pastedTexts = Array.isArray(candidate.pastedTexts)
        ? candidate.pastedTexts.flatMap((pasted) => {
            const normalized = normalizePersistedPastedTextDraft(pasted);
            return normalized ? [normalized] : [];
          })
        : [];
      const skills = Array.isArray(candidate.skills)
        ? candidate.skills.filter(Schema.is(ProviderSkillReference))
        : [];
      const mentions = Array.isArray(candidate.mentions)
        ? candidate.mentions.filter(Schema.is(ProviderMentionReference))
        : [];
      normalizedTurns.push({
        id,
        kind: "chat",
        createdAt,
        ...(serverAcceptedAt ? { serverAcceptedAt } : {}),
        ...(serverMessageId ? { serverMessageId } : {}),
        ...(dispatchAttempt === undefined ? {} : { dispatchAttempt }),
        ...(dispatchBindingRevision === undefined ? {} : { dispatchBindingRevision }),
        previewText,
        prompt,
        images,
        ...(assistantSelections.length > 0 ? { assistantSelections } : {}),
        terminalContexts,
        ...(fileComments.length > 0 ? { fileComments } : {}),
        ...(pastedTexts.length > 0 ? { pastedTexts } : {}),
        skills: [...skills],
        mentions: [...mentions],
        selectedProvider,
        selectedModel,
        selectedPromptEffort,
        modelSelection,
        connectionId,
        ...(providerOptionsForDispatch ? { providerOptionsForDispatch } : {}),
        runtimeMode,
      });
      seenIds.add(id);
      continue;
    }
  }
  return normalizedTurns.length > 0 ? normalizedTurns : undefined;
}

function unknownPendingStartRecovery(
  threadId: ThreadId,
  raw: unknown,
  fallbackMessageId?: string,
): UnknownPendingStartRecovery {
  const candidate = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const messageId =
    typeof candidate.messageId === "string" && candidate.messageId.length > 0
      ? MessageId.makeUnsafe(candidate.messageId)
      : MessageId.makeUnsafe(fallbackMessageId ?? `${threadId}:pending-start-recovery`);
  const schemaVersion =
    typeof candidate.schemaVersion === "number" && Number.isSafeInteger(candidate.schemaVersion)
      ? candidate.schemaVersion
      : 0;
  return { schemaVersion, threadId, messageId, raw };
}

function normalizePendingStartRecovery(
  threadId: ThreadId,
  raw: unknown,
  fallbackMessageId?: string,
): PendingStartRecoveryRecord | null {
  if (raw === undefined || raw === null) return null;
  if (!raw || typeof raw !== "object") {
    return unknownPendingStartRecovery(threadId, raw, fallbackMessageId);
  }
  const candidate = raw as Record<string, unknown>;
  const messageId = Schema.is(MessageId)(candidate.messageId) ? candidate.messageId : undefined;
  const pendingTurnCandidate = candidate.pendingTurn;
  const pendingTurn =
    pendingTurnCandidate && typeof pendingTurnCandidate === "object"
      ? normalizePersistedQueuedTurns([pendingTurnCandidate as Record<string, unknown>])?.[0]
      : undefined;
  if (!pendingTurn) return unknownPendingStartRecovery(threadId, raw, fallbackMessageId);
  const settlement = candidate.settlement;
  const receiptSequence =
    typeof candidate.receiptSequence === "number" &&
    Number.isSafeInteger(candidate.receiptSequence) &&
    candidate.receiptSequence >= 0
      ? candidate.receiptSequence
      : undefined;
  const restorationReceipt =
    candidate.restorationReceipt && typeof candidate.restorationReceipt === "object"
      ? (candidate.restorationReceipt as Record<string, unknown>)
      : undefined;
  const receipt =
    restorationReceipt &&
    typeof restorationReceipt.sequence === "number" &&
    Number.isSafeInteger(restorationReceipt.sequence) &&
    restorationReceipt.sequence >= 0 &&
    typeof restorationReceipt.rowId === "string" &&
    restorationReceipt.rowId.length > 0 &&
    typeof restorationReceipt.appliedAt === "string" &&
    restorationReceipt.appliedAt.length > 0
      ? {
          sequence: restorationReceipt.sequence,
          rowId: restorationReceipt.rowId,
          appliedAt: restorationReceipt.appliedAt,
        }
      : undefined;
  const validIdentity =
    candidate.schemaVersion === 1 &&
    Schema.is(ThreadId)(candidate.threadId) &&
    candidate.threadId === threadId &&
    messageId !== undefined &&
    pendingTurn!.id === messageId;
  const validSettlement =
    settlement === "unresolved" ||
    settlement === "accepted" ||
    settlement === "failed" ||
    (settlement === "restored" && receipt !== undefined);
  if (validIdentity && validSettlement) {
    const persistedImages = Array.isArray(candidate.persistedImages)
      ? candidate.persistedImages.flatMap((entry) => {
          const normalized = normalizePersistedAttachment(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    return {
      schemaVersion: 1,
      threadId,
      messageId,
      pendingTurn: {
        ...pendingTurn,
        messageId,
      } as unknown as PendingStartRecovery["pendingTurn"],
      ...(persistedImages.length > 0 ? { persistedImages } : {}),
      settlement,
      ...(receiptSequence === undefined ? {} : { receiptSequence }),
      ...(receipt === undefined ? {} : { restorationReceipt: receipt }),
    };
  }
  return unknownPendingStartRecovery(threadId, raw, fallbackMessageId);
}

function normalizePendingStartRecoveryMap(
  threadId: ThreadId,
  rawMap: unknown,
  legacyRaw: unknown,
): Partial<Record<MessageId, PendingStartRecoveryRecord>> {
  const normalized: Partial<Record<MessageId, PendingStartRecoveryRecord>> = {};
  if (rawMap && typeof rawMap === "object" && !Array.isArray(rawMap)) {
    for (const [messageId, raw] of Object.entries(rawMap as Record<string, unknown>)) {
      const recovery = normalizePendingStartRecovery(threadId, raw, messageId);
      if (recovery) {
        const key = recovery.messageId ?? MessageId.makeUnsafe(messageId);
        normalized[key] = recovery;
      }
    }
  }
  const legacyRecovery = normalizePendingStartRecovery(threadId, legacyRaw);
  if (legacyRecovery && normalized[legacyRecovery.messageId] === undefined) {
    normalized[legacyRecovery.messageId] = legacyRecovery;
  }
  return normalized;
}

function normalizePersistedDraftThreads(
  rawDraftThreadsByThreadId: unknown,
  rawProjectDraftThreadIdByFolderId: unknown,
): Pick<
  PersistedComposerDraftStoreState,
  "draftThreadsByThreadId" | "projectDraftThreadIdByFolderId"
> {
  const draftThreadsByThreadId: Record<ThreadId, PersistedDraftThreadState> = {};
  if (rawDraftThreadsByThreadId && typeof rawDraftThreadsByThreadId === "object") {
    for (const [threadId, rawDraftThread] of Object.entries(
      rawDraftThreadsByThreadId as Record<string, unknown>,
    )) {
      if (typeof threadId !== "string" || threadId.length === 0) {
        continue;
      }
      if (!rawDraftThread || typeof rawDraftThread !== "object") {
        continue;
      }
      const candidateDraftThread = rawDraftThread as Record<string, unknown>;
      const folderId = candidateDraftThread.folderId;
      const createdAt = candidateDraftThread.createdAt;
      const workingDirectory = candidateDraftThread.workingDirectory;
      const promotedTo =
        typeof candidateDraftThread.promotedTo === "string" &&
        candidateDraftThread.promotedTo.length > 0
          ? (candidateDraftThread.promotedTo as ThreadId)
          : undefined;
      if (typeof folderId !== "string" || folderId.length === 0) {
        continue;
      }
      draftThreadsByThreadId[threadId as ThreadId] = {
        folderId: folderId as FolderId,
        spaceId:
          typeof candidateDraftThread.spaceId === "string"
            ? SpaceId.makeUnsafe(candidateDraftThread.spaceId)
            : null,
        createdAt:
          typeof createdAt === "string" && createdAt.length > 0
            ? createdAt
            : new Date().toISOString(),
        runtimeMode:
          candidateDraftThread.runtimeMode === "approval-required" ||
          candidateDraftThread.runtimeMode === "full-access"
            ? candidateDraftThread.runtimeMode
            : DEFAULT_RUNTIME_MODE,
        entryPoint: normalizeDraftThreadEntryPoint(candidateDraftThread.entryPoint),
        workingDirectory: typeof workingDirectory === "string" ? workingDirectory : null,
        ...(promotedTo ? { promotedTo } : {}),
      };
    }
  }

  const projectDraftThreadIdByFolderId: Record<string, ThreadId> = {};
  if (rawProjectDraftThreadIdByFolderId && typeof rawProjectDraftThreadIdByFolderId === "object") {
    for (const [mappingKey, threadId] of Object.entries(
      rawProjectDraftThreadIdByFolderId as Record<string, unknown>,
    )) {
      const folderId = folderIdFromDraftThreadMappingKey(mappingKey);
      const entryPoint = projectDraftThreadEntryPointFromKey(mappingKey);
      if (
        typeof folderId === "string" &&
        folderId.length > 0 &&
        typeof threadId === "string" &&
        threadId.length > 0
      ) {
        projectDraftThreadIdByFolderId[mappingKey] = threadId as ThreadId;
        if (!draftThreadsByThreadId[threadId as ThreadId]) {
          draftThreadsByThreadId[threadId as ThreadId] = {
            folderId: folderId as FolderId,
            spaceId: null,
            createdAt: new Date().toISOString(),
            runtimeMode: DEFAULT_RUNTIME_MODE,
            entryPoint,
            workingDirectory: null,
          };
        } else if (draftThreadsByThreadId[threadId as ThreadId]?.folderId !== folderId) {
          draftThreadsByThreadId[threadId as ThreadId] = {
            ...draftThreadsByThreadId[threadId as ThreadId]!,
            folderId: folderId as FolderId,
          };
        } else if (draftThreadsByThreadId[threadId as ThreadId]?.entryPoint !== entryPoint) {
          draftThreadsByThreadId[threadId as ThreadId] = {
            ...draftThreadsByThreadId[threadId as ThreadId]!,
            entryPoint,
          };
        }
      }
    }
  }

  return { draftThreadsByThreadId, projectDraftThreadIdByFolderId };
}

function normalizePersistedDraftsByThreadId(
  rawDraftMap: unknown,
): PersistedComposerDraftStoreState["draftsByThreadId"] {
  if (!rawDraftMap || typeof rawDraftMap !== "object") {
    return {};
  }

  const nextDraftsByThreadId: DeepMutable<PersistedComposerDraftStoreState["draftsByThreadId"]> =
    {};
  for (const [threadId, draftValue] of Object.entries(rawDraftMap as Record<string, unknown>)) {
    if (typeof threadId !== "string" || threadId.length === 0) {
      continue;
    }
    if (!draftValue || typeof draftValue !== "object") {
      continue;
    }
    const draftCandidate = draftValue as PersistedComposerThreadDraftState;
    const promptCandidate = typeof draftCandidate.prompt === "string" ? draftCandidate.prompt : "";
    const promptHistorySavedDraft = normalizePersistedPromptHistorySavedDraft(
      draftCandidate.promptHistorySavedDraft,
    );
    const attachments = Array.isArray(draftCandidate.attachments)
      ? draftCandidate.attachments.flatMap((entry) => {
          const normalized = normalizePersistedAttachment(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const terminalContexts = Array.isArray(draftCandidate.terminalContexts)
      ? draftCandidate.terminalContexts.flatMap((entry) => {
          const normalized = normalizePersistedTerminalContextDraft(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const assistantSelections = Array.isArray(draftCandidate.assistantSelections)
      ? draftCandidate.assistantSelections.flatMap((entry) => {
          const normalized = normalizePersistedAssistantSelection(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const fileComments = Array.isArray(draftCandidate.fileComments)
      ? draftCandidate.fileComments.flatMap((entry) => {
          const normalized = normalizePersistedFileCommentDraft(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const pastedTexts = Array.isArray(draftCandidate.pastedTexts)
      ? draftCandidate.pastedTexts.flatMap((entry) => {
          const normalized = normalizePersistedPastedTextDraft(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const skills = Array.isArray(draftCandidate.skills)
      ? draftCandidate.skills.filter(Schema.is(ProviderSkillReference))
      : [];
    const mentions = Array.isArray(draftCandidate.mentions)
      ? draftCandidate.mentions.filter(Schema.is(ProviderMentionReference))
      : [];
    const queuedTurns = normalizePersistedQueuedTurns(draftCandidate.queuedTurns);
    const runtimeMode =
      draftCandidate.runtimeMode === "approval-required" ||
      draftCandidate.runtimeMode === "full-access"
        ? draftCandidate.runtimeMode
        : null;
    const prompt = ensureInlineTerminalContextPlaceholders(
      promptCandidate,
      terminalContexts.length,
    );
    // If the draft already has the v3 shape, use it directly
    const legacyDraftCandidate = draftValue as LegacyPersistedComposerThreadDraftState;
    let modelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>> = {};
    let activeProvider: ProviderKind | null = null;

    if (
      draftCandidate.modelSelectionByProvider &&
      typeof draftCandidate.modelSelectionByProvider === "object"
    ) {
      // v3 format
      modelSelectionByProvider = draftCandidate.modelSelectionByProvider as Partial<
        Record<ProviderKind, ModelSelection>
      >;
      activeProvider = normalizeProviderKind(draftCandidate.activeProvider);
    } else {
      // v2 or legacy format: migrate
      const normalizedModelOptions =
        normalizeProviderModelOptions(
          legacyDraftCandidate.modelOptions,
          undefined,
          legacyDraftCandidate,
        ) ?? null;
      const normalizedModelSelection = normalizeModelSelection(
        legacyDraftCandidate.modelSelection,
        {
          provider: legacyDraftCandidate.provider,
          model: legacyDraftCandidate.model,
          modelOptions: normalizedModelOptions ?? legacyDraftCandidate.modelOptions,
          legacyCodex: legacyDraftCandidate,
        },
      );
      const mergedModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
        normalizedModelSelection,
        normalizedModelOptions,
      );
      const modelSelection = legacySyncModelSelectionOptions(
        normalizedModelSelection,
        mergedModelOptions,
      );
      modelSelectionByProvider = legacyToModelSelectionByProvider(
        modelSelection,
        mergedModelOptions,
      );
      activeProvider = modelSelection?.provider ?? null;
    }

    const normalizedQueuedTurns = queuedTurns ?? [];
    const pendingStartRecoveriesByMessageId = normalizePendingStartRecoveryMap(
      threadId as ThreadId,
      draftCandidate.pendingStartRecoveriesByMessageId,
      draftCandidate.pendingStartRecovery,
    );
    const queuePaused = draftCandidate.queuePaused === true;
    const pendingMessageEdit = Schema.is(PersistedPendingMessageEdit)(
      draftCandidate.pendingMessageEdit,
    )
      ? draftCandidate.pendingMessageEdit
      : undefined;
    const hasModelData =
      Object.keys(modelSelectionByProvider).length > 0 || activeProvider !== null;
    const hasQueuedTurns = normalizedQueuedTurns.length > 0;
    const hasReferenceData = skills.length > 0 || mentions.length > 0;
    if (
      promptCandidate.length === 0 &&
      promptHistorySavedDraft === null &&
      attachments.length === 0 &&
      terminalContexts.length === 0 &&
      assistantSelections.length === 0 &&
      fileComments.length === 0 &&
      pastedTexts.length === 0 &&
      !hasReferenceData &&
      !hasQueuedTurns &&
      Object.keys(pendingStartRecoveriesByMessageId).length === 0 &&
      pendingMessageEdit === undefined &&
      !queuePaused &&
      !hasModelData &&
      !runtimeMode
    ) {
      continue;
    }
    nextDraftsByThreadId[threadId as ThreadId] = {
      prompt,
      ...(promptHistorySavedDraft !== null ? { promptHistorySavedDraft } : {}),
      attachments,
      ...(assistantSelections.length > 0 ? { assistantSelections } : {}),
      ...(terminalContexts.length > 0 ? { terminalContexts } : {}),
      ...(fileComments.length > 0 ? { fileComments } : {}),
      ...(pastedTexts.length > 0 ? { pastedTexts } : {}),
      ...(skills.length > 0 ? { skills } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(hasQueuedTurns ? { queuedTurns: normalizedQueuedTurns } : {}),
      ...(Object.keys(pendingStartRecoveriesByMessageId).length > 0
        ? { pendingStartRecoveriesByMessageId }
        : {}),
      ...(pendingMessageEdit ? { pendingMessageEdit } : {}),
      ...(queuePaused ? { queuePaused: true } : {}),
      ...(hasModelData ? { modelSelectionByProvider, activeProvider } : {}),
      ...(runtimeMode ? { runtimeMode } : {}),
    };
  }

  return nextDraftsByThreadId;
}

export function migratePersistedComposerDraftStoreState(
  persistedState: unknown,
  version?: number,
): PersistedComposerDraftStoreState {
  const normalized = normalizeCurrentPersistedComposerDraftStoreState(persistedState);
  if (version === 6 || (version !== undefined && version > COMPOSER_DRAFT_STORAGE_VERSION)) {
    return normalized;
  }
  // v6 is an intentional clean cut for the composer/thread redesign. Keep only
  // sticky model preference; every persisted draft and draft-thread mapping is
  // discarded instead of applying compatibility transforms or field heuristics.
  return {
    ...EMPTY_PERSISTED_DRAFT_STORE_STATE,
    stickyModelSelectionByProvider: normalized.stickyModelSelectionByProvider ?? {},
    stickyConnectionByProvider: normalized.stickyConnectionByProvider ?? {},
    stickyActiveProvider: normalized.stickyActiveProvider ?? null,
  };
}

export function partializeComposerDraftStoreState(
  state: ComposerDraftStoreState,
): PersistedComposerDraftStoreState {
  const persistedDraftsByThreadId: DeepMutable<
    PersistedComposerDraftStoreState["draftsByThreadId"]
  > = {};
  for (const [threadId, draft] of Object.entries(state.draftsByThreadId)) {
    if (typeof threadId !== "string" || threadId.length === 0) {
      continue;
    }
    const persistedQueuedTurns: DeepMutable<
      NonNullable<PersistedComposerThreadDraftState["queuedTurns"]>
    > = [];
    for (const queuedTurn of draft.queuedTurns) {
      if (queuedTurn.kind === "chat") {
        if (queuedTurn.files.some((file) => !file.assetKey)) {
          continue;
        }
        const images = persistQueuedComposerImages(queuedTurn.images);
        if (images.length !== queuedTurn.images.length) {
          continue;
        }
        persistedQueuedTurns.push({
          id: queuedTurn.id,
          kind: "chat",
          createdAt: queuedTurn.createdAt,
          ...(queuedTurn.serverAcceptedAt ? { serverAcceptedAt: queuedTurn.serverAcceptedAt } : {}),
          ...(queuedTurn.serverMessageId ? { serverMessageId: queuedTurn.serverMessageId } : {}),
          ...(queuedTurn.dispatchAttempt === undefined
            ? {}
            : { dispatchAttempt: queuedTurn.dispatchAttempt }),
          ...(queuedTurn.dispatchBindingRevision === undefined
            ? {}
            : { dispatchBindingRevision: queuedTurn.dispatchBindingRevision }),
          previewText: queuedTurn.previewText,
          prompt: queuedTurn.prompt,
          images,
          files: queuedTurn.files.map((file) => ({
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            assetKey: file.assetKey!,
          })),
          assistantSelections: queuedTurn.assistantSelections.map((selection) => ({
            id: selection.id,
            assistantMessageId: selection.assistantMessageId,
            text: selection.text,
          })),
          terminalContexts: queuedTurn.terminalContexts.map((context) => ({
            id: context.id,
            threadId: context.threadId,
            createdAt: context.createdAt,
            terminalId: context.terminalId,
            terminalLabel: context.terminalLabel,
            lineStart: context.lineStart,
            lineEnd: context.lineEnd,
            text: context.text,
          })),
          ...(queuedTurn.fileComments.length > 0
            ? {
                fileComments: queuedTurn.fileComments.map((comment) => ({
                  id: comment.id,
                  path: comment.path,
                  startLine: comment.startLine,
                  endLine: comment.endLine,
                  text: comment.text,
                })),
              }
            : {}),
          ...(queuedTurn.pastedTexts.length > 0
            ? {
                pastedTexts: queuedTurn.pastedTexts.map((pasted) => ({
                  id: pasted.id,
                  createdAt: pasted.createdAt,
                  text: pasted.text,
                  ...(pasted.title ? { title: pasted.title } : {}),
                })),
              }
            : {}),
          skills: [...queuedTurn.skills],
          mentions: [...queuedTurn.mentions],
          selectedProvider: queuedTurn.selectedProvider,
          selectedModel: queuedTurn.selectedModel,
          selectedPromptEffort: queuedTurn.selectedPromptEffort,
          modelSelection: queuedTurn.modelSelection,
          connectionId: queuedTurn.connectionId,
          ...(queuedTurn.providerOptionsForDispatch
            ? { providerOptionsForDispatch: queuedTurn.providerOptionsForDispatch }
            : {}),
          runtimeMode: queuedTurn.runtimeMode,
        });
      }
    }
    const persistedPendingStartRecoveriesByMessageId: Record<string, unknown> = {};
    for (const [messageId, pendingStartRecovery] of Object.entries(
      draft.pendingStartRecoveriesByMessageId ?? {},
    )) {
      if (!pendingStartRecovery) continue;
      if ("raw" in pendingStartRecovery) {
        persistedPendingStartRecoveriesByMessageId[messageId] = pendingStartRecovery.raw;
      } else {
        const pendingTurn = serializeQueuedComposerTurn(
          pendingStartRecovery.pendingTurn as unknown as QueuedComposerTurn,
          true,
        );
        persistedPendingStartRecoveriesByMessageId[messageId] = {
          schemaVersion: 1,
          threadId: pendingStartRecovery.threadId,
          messageId: pendingStartRecovery.messageId,
          pendingTurn: { ...pendingTurn, messageId: pendingStartRecovery.messageId },
          settlement: pendingStartRecovery.settlement,
          ...(pendingStartRecovery.receiptSequence === undefined
            ? {}
            : { receiptSequence: pendingStartRecovery.receiptSequence }),
          ...(pendingStartRecovery.restorationReceipt === undefined
            ? {}
            : { restorationReceipt: pendingStartRecovery.restorationReceipt }),
          ...(pendingStartRecovery.persistedImages === undefined
            ? {}
            : { persistedImages: pendingStartRecovery.persistedImages }),
        };
      }
    }
    const hasModelData =
      Object.keys(draft.modelSelectionByProvider).length > 0 || draft.activeProvider !== null;
    const hasQueuedTurns = persistedQueuedTurns.length > 0;
    const hasReferenceData = draft.skills.length > 0 || draft.mentions.length > 0;
    if (
      draft.prompt.length === 0 &&
      (draft.appliedVoiceJobIds?.length ?? 0) === 0 &&
      draft.promptHistorySavedDraft === null &&
      draft.persistedAttachments.length === 0 &&
      draft.files.length === 0 &&
      draft.assistantSelections.length === 0 &&
      draft.terminalContexts.length === 0 &&
      draft.fileComments.length === 0 &&
      draft.pastedTexts.length === 0 &&
      !hasReferenceData &&
      !hasQueuedTurns &&
      Object.keys(persistedPendingStartRecoveriesByMessageId).length === 0 &&
      draft.pendingMessageEdit === null &&
      !draft.queuePaused &&
      !hasModelData &&
      draft.runtimeMode === null
    ) {
      continue;
    }
    const persistedDraft: DeepMutable<PersistedComposerThreadDraftState> = {
      prompt: draft.prompt,
      ...((draft.appliedVoiceJobIds?.length ?? 0) > 0
        ? { appliedVoiceJobIds: [...(draft.appliedVoiceJobIds ?? [])] }
        : {}),
      ...(draft.promptHistorySavedDraft !== null
        ? {
            promptHistorySavedDraft: {
              prompt: draft.promptHistorySavedDraft.prompt,
              attachments: draft.promptHistorySavedDraft.persistedAttachments.map(
                toStorageSafePersistedAttachment,
              ),
              files: draft.promptHistorySavedDraft.files.flatMap((file) =>
                file.assetKey
                  ? [
                      {
                        id: file.id,
                        name: file.name,
                        mimeType: file.mimeType,
                        sizeBytes: file.sizeBytes,
                        assetKey: file.assetKey,
                      },
                    ]
                  : [],
              ),
              ...(draft.promptHistorySavedDraft.assistantSelections.length > 0
                ? {
                    assistantSelections: draft.promptHistorySavedDraft.assistantSelections.map(
                      (selection) => ({
                        id: selection.id,
                        assistantMessageId: selection.assistantMessageId,
                        text: selection.text,
                      }),
                    ),
                  }
                : {}),
              ...(draft.promptHistorySavedDraft.terminalContexts.length > 0
                ? {
                    terminalContexts: draft.promptHistorySavedDraft.terminalContexts.map(
                      (context) => ({
                        id: context.id,
                        threadId: context.threadId,
                        createdAt: context.createdAt,
                        terminalId: context.terminalId,
                        terminalLabel: context.terminalLabel,
                        lineStart: context.lineStart,
                        lineEnd: context.lineEnd,
                      }),
                    ),
                  }
                : {}),
              ...(draft.promptHistorySavedDraft.fileComments.length > 0
                ? {
                    fileComments: draft.promptHistorySavedDraft.fileComments.map((comment) => ({
                      id: comment.id,
                      path: comment.path,
                      startLine: comment.startLine,
                      endLine: comment.endLine,
                      text: comment.text,
                    })),
                  }
                : {}),
              ...(draft.promptHistorySavedDraft.pastedTexts.length > 0
                ? {
                    pastedTexts: draft.promptHistorySavedDraft.pastedTexts.map((pasted) => ({
                      id: pasted.id,
                      createdAt: pasted.createdAt,
                      text: pasted.text,
                      ...(pasted.title ? { title: pasted.title } : {}),
                    })),
                  }
                : {}),
              ...(draft.promptHistorySavedDraft.skills.length > 0
                ? { skills: [...draft.promptHistorySavedDraft.skills] }
                : {}),
              ...(draft.promptHistorySavedDraft.mentions.length > 0
                ? { mentions: [...draft.promptHistorySavedDraft.mentions] }
                : {}),
            },
          }
        : {}),
      attachments: draft.persistedAttachments.map(toStorageSafePersistedAttachment),
      files: draft.files.flatMap((file) =>
        file.assetKey
          ? [
              {
                id: file.id,
                name: file.name,
                mimeType: file.mimeType,
                sizeBytes: file.sizeBytes,
                assetKey: file.assetKey,
              },
            ]
          : [],
      ),
      ...(draft.assistantSelections.length > 0
        ? {
            assistantSelections: draft.assistantSelections.map((selection) => ({
              id: selection.id,
              assistantMessageId: selection.assistantMessageId,
              text: selection.text,
            })),
          }
        : {}),
      ...(draft.terminalContexts.length > 0
        ? {
            terminalContexts: draft.terminalContexts.map((context) => ({
              id: context.id,
              threadId: context.threadId,
              createdAt: context.createdAt,
              terminalId: context.terminalId,
              terminalLabel: context.terminalLabel,
              lineStart: context.lineStart,
              lineEnd: context.lineEnd,
            })),
          }
        : {}),
      ...(draft.fileComments.length > 0
        ? {
            fileComments: draft.fileComments.map((comment) => ({
              id: comment.id,
              path: comment.path,
              startLine: comment.startLine,
              endLine: comment.endLine,
              text: comment.text,
            })),
          }
        : {}),
      ...(draft.pastedTexts.length > 0
        ? {
            pastedTexts: draft.pastedTexts.map((pasted) => ({
              id: pasted.id,
              createdAt: pasted.createdAt,
              text: pasted.text,
              ...(pasted.title ? { title: pasted.title } : {}),
            })),
          }
        : {}),
      ...(draft.skills.length > 0 ? { skills: [...draft.skills] } : {}),
      ...(draft.mentions.length > 0 ? { mentions: [...draft.mentions] } : {}),
      ...(hasQueuedTurns ? { queuedTurns: persistedQueuedTurns } : {}),
      ...(Object.keys(persistedPendingStartRecoveriesByMessageId).length === 0
        ? {}
        : { pendingStartRecoveriesByMessageId: persistedPendingStartRecoveriesByMessageId }),
      ...(draft.pendingMessageEdit ? { pendingMessageEdit: draft.pendingMessageEdit } : {}),
      ...(draft.queuePaused ? { queuePaused: true } : {}),
      ...(hasModelData
        ? {
            modelSelectionByProvider: draft.modelSelectionByProvider,
            activeProvider: draft.activeProvider,
          }
        : {}),
      ...(draft.runtimeMode ? { runtimeMode: draft.runtimeMode } : {}),
    };
    persistedDraftsByThreadId[threadId as ThreadId] = persistedDraft;
  }
  return {
    draftsByThreadId: persistedDraftsByThreadId,
    draftThreadsByThreadId: state.draftThreadsByThreadId,
    projectDraftThreadIdByFolderId: state.projectDraftThreadIdByFolderId,
    stickyModelSelectionByProvider: state.stickyModelSelectionByProvider,
    stickyConnectionByProvider: state.stickyConnectionByProvider,
    stickyActiveProvider: state.stickyActiveProvider,
  };
}

function serializeQueuedComposerTurn(
  queuedTurn: QueuedComposerTurn & { messageId?: MessageId },
  strict: boolean,
): PersistedQueuedComposerChatTurn {
  if (queuedTurn.kind !== "chat") {
    throw new Error("Pending start recovery must contain a chat turn.");
  }
  if (queuedTurn.files.some((file) => !file.assetKey)) {
    throw new Error("Pending start recovery contains a file without a durable asset reference.");
  }
  const images = persistQueuedComposerImages(queuedTurn.images);
  if (images.length !== queuedTurn.images.length) {
    if (strict) {
      throw new Error("Pending start recovery contains an image without durable bytes.");
    }
    throw new Error("Queued composer image could not be persisted.");
  }
  return {
    id: queuedTurn.id,
    kind: "chat",
    createdAt: queuedTurn.createdAt,
    ...(queuedTurn.serverAcceptedAt ? { serverAcceptedAt: queuedTurn.serverAcceptedAt } : {}),
    ...(queuedTurn.serverMessageId ? { serverMessageId: queuedTurn.serverMessageId } : {}),
    ...(queuedTurn.dispatchAttempt === undefined
      ? {}
      : { dispatchAttempt: queuedTurn.dispatchAttempt }),
    ...(queuedTurn.dispatchBindingRevision === undefined
      ? {}
      : { dispatchBindingRevision: queuedTurn.dispatchBindingRevision }),
    previewText: queuedTurn.previewText,
    prompt: queuedTurn.prompt,
    images,
    files: queuedTurn.files.map((file) => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      assetKey: file.assetKey!,
    })),
    assistantSelections: queuedTurn.assistantSelections.map((selection) => ({
      id: selection.id,
      assistantMessageId: selection.assistantMessageId,
      text: selection.text,
    })),
    terminalContexts: queuedTurn.terminalContexts.map((context) => ({
      id: context.id,
      threadId: context.threadId,
      createdAt: context.createdAt,
      terminalId: context.terminalId,
      terminalLabel: context.terminalLabel,
      lineStart: context.lineStart,
      lineEnd: context.lineEnd,
      text: context.text,
    })),
    ...(queuedTurn.fileComments.length > 0
      ? {
          fileComments: queuedTurn.fileComments.map((comment) => ({
            id: comment.id,
            path: comment.path,
            startLine: comment.startLine,
            endLine: comment.endLine,
            text: comment.text,
          })),
        }
      : {}),
    ...(queuedTurn.pastedTexts.length > 0
      ? {
          pastedTexts: queuedTurn.pastedTexts.map((pasted) => ({
            id: pasted.id,
            createdAt: pasted.createdAt,
            text: pasted.text,
            ...(pasted.title ? { title: pasted.title } : {}),
          })),
        }
      : {}),
    skills: [...queuedTurn.skills],
    mentions: [...queuedTurn.mentions],
    selectedProvider: queuedTurn.selectedProvider,
    selectedModel: queuedTurn.selectedModel,
    selectedPromptEffort: queuedTurn.selectedPromptEffort,
    modelSelection: queuedTurn.modelSelection,
    connectionId: queuedTurn.connectionId,
    ...(queuedTurn.providerOptionsForDispatch
      ? { providerOptionsForDispatch: queuedTurn.providerOptionsForDispatch }
      : {}),
    runtimeMode: queuedTurn.runtimeMode,
    ...(queuedTurn.messageId ? { messageId: queuedTurn.messageId } : {}),
  };
}

export function normalizeCurrentPersistedComposerDraftStoreState(
  persistedState: unknown,
): PersistedComposerDraftStoreState {
  if (!persistedState || typeof persistedState !== "object") {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }
  const normalizedPersistedState = persistedState as LegacyPersistedComposerDraftStoreState;
  const { draftThreadsByThreadId, projectDraftThreadIdByFolderId } = normalizePersistedDraftThreads(
    normalizedPersistedState.draftThreadsByThreadId,
    normalizedPersistedState.projectDraftThreadIdByFolderId,
  );

  // Handle both v3 (modelSelectionByProvider) and v2/legacy formats
  let stickyModelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>> = {};
  const stickyConnectionByProvider = Object.fromEntries(
    Object.entries(normalizedPersistedState.stickyConnectionByProvider ?? {}).filter(
      ([provider, connectionId]) =>
        Schema.is(ProviderKind)(provider) &&
        (connectionId === null || Schema.is(ProviderConnectionId)(connectionId)),
    ),
  ) as Partial<Record<ProviderKind, ProviderConnectionId | null>>;
  let stickyActiveProvider: ProviderKind | null = null;
  if (
    normalizedPersistedState.stickyModelSelectionByProvider &&
    typeof normalizedPersistedState.stickyModelSelectionByProvider === "object"
  ) {
    stickyModelSelectionByProvider =
      normalizedPersistedState.stickyModelSelectionByProvider as Partial<
        Record<ProviderKind, ModelSelection>
      >;
    stickyActiveProvider = normalizeProviderKind(normalizedPersistedState.stickyActiveProvider);
  } else {
    // Legacy migration path
    const stickyModelOptions =
      normalizeProviderModelOptions(normalizedPersistedState.stickyModelOptions) ?? {};
    const normalizedStickyModelSelection = normalizeModelSelection(
      normalizedPersistedState.stickyModelSelection,
      {
        provider: normalizedPersistedState.stickyProvider ?? "codex",
        model: normalizedPersistedState.stickyModel,
        modelOptions: stickyModelOptions,
      },
    );
    const nextStickyModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
      normalizedStickyModelSelection,
      stickyModelOptions,
    );
    const stickyModelSelection = legacySyncModelSelectionOptions(
      normalizedStickyModelSelection,
      nextStickyModelOptions,
    );
    stickyModelSelectionByProvider = legacyToModelSelectionByProvider(
      stickyModelSelection,
      nextStickyModelOptions,
    );
    stickyActiveProvider = normalizeProviderKind(normalizedPersistedState.stickyProvider);
  }

  return {
    draftsByThreadId: normalizePersistedDraftsByThreadId(normalizedPersistedState.draftsByThreadId),
    draftThreadsByThreadId,
    projectDraftThreadIdByFolderId,
    stickyModelSelectionByProvider: sanitizeStickyModelSelectionMap(stickyModelSelectionByProvider),
    stickyConnectionByProvider,
    stickyActiveProvider,
  };
}

function hydrateQueuedTurnsFromPersisted(
  threadId: ThreadId,
  queuedTurns: ReadonlyArray<PersistedQueuedComposerTurn> | undefined,
): QueuedComposerTurn[] {
  if (!queuedTurns || queuedTurns.length === 0) {
    return [];
  }
  return queuedTurns.map((queuedTurn) => ({
    ...queuedTurn,
    images: hydrateImagesFromPersisted(queuedTurn.images),
    files: hydrateFilesFromPersisted(queuedTurn.files),
    assistantSelections: normalizeAssistantSelections(queuedTurn.assistantSelections ?? []),
    terminalContexts: normalizeTerminalContextsForThread(threadId, queuedTurn.terminalContexts),
    fileComments: normalizeFileComments(queuedTurn.fileComments ?? []),
    pastedTexts: hydratePastedTextsFromPersisted(queuedTurn.pastedTexts),
    skills: [...queuedTurn.skills],
    mentions: [...queuedTurn.mentions],
  }));
}

function hydratePendingStartRecoveries(
  threadId: ThreadId,
  recoveries: Partial<Record<MessageId, PendingStartRecoveryRecord>>,
): Partial<Record<MessageId, PendingStartRecoveryRecord>> {
  const hydrated: Partial<Record<MessageId, PendingStartRecoveryRecord>> = {};
  for (const [messageId, recovery] of Object.entries(recoveries)) {
    if (!recovery || "raw" in recovery) {
      hydrated[messageId as MessageId] = recovery;
      continue;
    }
    const pendingTurn = hydrateQueuedTurnsFromPersisted(threadId, [
      recovery.pendingTurn as unknown as NonNullable<
        Parameters<typeof hydrateQueuedTurnsFromPersisted>[1]
      >[number],
    ])[0];
    hydrated[messageId as MessageId] = pendingTurn
      ? { ...recovery, pendingTurn: { ...pendingTurn } }
      : unknownPendingStartRecovery(threadId, recovery);
  }
  return hydrated;
}

function hydratePromptHistorySavedDraft(
  savedDraft: PersistedComposerPromptHistorySavedDraft | undefined,
): ComposerPromptHistorySavedDraft | null {
  if (savedDraft === undefined) {
    return null;
  }
  if (typeof savedDraft === "string") {
    return {
      prompt: savedDraft,
      images: [],
      files: [],
      nonPersistedImageIds: [],
      persistedAttachments: [],
      assistantSelections: [],
      terminalContexts: [],
      fileComments: [],
      pastedTexts: [],
      skills: [],
      mentions: [],
    };
  }
  const attachments = savedDraft.attachments ?? [];
  return {
    prompt: savedDraft.prompt,
    images: hydrateImagesFromPersisted(attachments),
    files: hydrateFilesFromPersisted(savedDraft.files),
    nonPersistedImageIds: [],
    persistedAttachments: [...attachments],
    assistantSelections: normalizeAssistantSelections(savedDraft.assistantSelections ?? []),
    terminalContexts:
      savedDraft.terminalContexts?.map((context) => ({
        ...context,
        text: "",
      })) ?? [],
    fileComments: normalizeFileComments(savedDraft.fileComments ?? []),
    pastedTexts: hydratePastedTextsFromPersisted(savedDraft.pastedTexts),
    skills: [...(savedDraft.skills ?? [])],
    mentions: [...(savedDraft.mentions ?? [])],
  };
}

export function toHydratedThreadDraft(
  threadId: ThreadId,
  persistedDraft: PersistedComposerThreadDraftState,
): ComposerThreadDraftState {
  // The persisted draft is already in v3 shape (migration handles older formats)
  const modelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>> =
    persistedDraft.modelSelectionByProvider ?? {};
  const activeProvider = normalizeProviderKind(persistedDraft.activeProvider) ?? null;

  return {
    prompt: persistedDraft.prompt,
    appliedVoiceJobIds: [...(persistedDraft.appliedVoiceJobIds ?? [])],
    promptHistorySavedDraft: hydratePromptHistorySavedDraft(persistedDraft.promptHistorySavedDraft),
    images: hydrateImagesFromPersisted(persistedDraft.attachments),
    files: hydrateFilesFromPersisted(persistedDraft.files),
    nonPersistedImageIds: [],
    persistedAttachments: [...persistedDraft.attachments],
    assistantSelections: normalizeAssistantSelections(persistedDraft.assistantSelections ?? []),
    terminalContexts:
      persistedDraft.terminalContexts?.map((context) => ({
        ...context,
        text: "",
      })) ?? [],
    fileComments: normalizeFileComments(persistedDraft.fileComments ?? []),
    pastedTexts: hydratePastedTextsFromPersisted(persistedDraft.pastedTexts),
    skills: [...(persistedDraft.skills ?? [])],
    mentions: [...(persistedDraft.mentions ?? [])],
    queuedTurns: hydrateQueuedTurnsFromPersisted(threadId, persistedDraft.queuedTurns),
    pendingStartRecoveriesByMessageId: hydratePendingStartRecoveries(
      threadId,
      normalizePendingStartRecoveryMap(
        threadId,
        persistedDraft.pendingStartRecoveriesByMessageId,
        persistedDraft.pendingStartRecovery,
      ),
    ),
    pendingMessageEdit: persistedDraft.pendingMessageEdit ?? null,
    queuePaused: persistedDraft.queuePaused === true,
    modelSelectionByProvider,
    activeProvider,
    runtimeMode: persistedDraft.runtimeMode ?? null,
  };
}

function hydrateFilesFromPersisted(
  files: ReadonlyArray<PersistedComposerFileAttachment> | undefined,
): ComposerThreadDraftState["files"] {
  return (files ?? []).map((file) => ({
    type: "file" as const,
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    assetKey: file.assetKey,
    // The binary body is hydrated lazily immediately before upload.
    file: new File([], file.name, { type: file.mimeType }),
  }));
}
