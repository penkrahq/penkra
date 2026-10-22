/**
 * CodexAdapterLive - Scoped live implementation for the Codex provider adapter.
 *
 * Wraps `CodexAppServerManager` behind the `CodexAdapter` service contract and
 * maps manager failures into the shared `ProviderAdapterError` algebra.
 *
 * @module CodexAdapterLive
 */
import {
  type ChatAttachment,
  type CanonicalItemType,
  type ModelSelection,
  type ProviderComposerCapabilities,
  type ProviderEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderRuntimeEvent,
  type ServerVoiceTranscriptionResult,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "@penkra/contracts";
import {
  Cause,
  Effect,
  FileSystem,
  Layer,
  Option,
  Queue,
  Schema,
  ServiceMap,
  Stream,
} from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { PENDING_INTERACTION_NOT_FOUND_FAILURE_CODE } from "@penkra/shared/threadSummary";
import { CodexAdapter, type CodexAdapterShape } from "../Services/CodexAdapter.ts";
import {
  awaitProviderRuntimeEventsDrained,
  PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
  type ProviderManagedLaunchContext,
} from "../Services/ProviderAdapter.ts";
import {
  CodexAppServerManager,
  CodexJsonRpcResponseError,
  CodexSessionNotFoundError,
  CodexSessionClosedError,
  CodexSessionStoppedRequestError,
  parseCodexUserInputQuestions,
  type CodexAppServerSendTurnInput,
  type CodexAppServerStartSessionInput,
} from "../../codexAppServerManager.ts";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { AgentGatewayToolBridge } from "../../agentGateway/Services/AgentGatewayToolBridge.ts";
import { acquireAgentGatewaySessionLease } from "../../agentGateway/sessionLease.ts";
import { loadProviderPromptImageBlocks } from "../promptAttachments.ts";
import {
  codexGeneratedImageArtifact,
  extractCodexGeneratedImageReference,
  firstStringValue,
  sanitizeNestedCodexGeneratedImagePayloads,
} from "../../codexGeneratedImages.ts";
import { isCodexToolAttemptFailure } from "../../codexErrorClassification.ts";
import { ServerConfig } from "../../config.ts";
import { makeRuntimeTaskListItem } from "../runtimeTaskList.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { penkraSkillsDir } from "../skillsCatalog.ts";
import { makeBoundedCallbackIngress } from "../boundedCallbackIngress.ts";
import { assignDerivedProviderRuntimeEventIds } from "../providerRuntimeEventIdentity.ts";
import {
  compactProviderRuntimeEventForIngress,
  isTerminalProviderRuntimeEvent,
  PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES,
  PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE,
  PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES,
  providerRuntimeEventBytes,
} from "../providerRuntimeEventIngress.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { adoptManagedCodexRollout, prepareManagedCodexResume } from "../codexManagedNativeState.ts";
import { makeInvalidationHub } from "../../cleanCore/invalidationHub.ts";
import type { ProviderCatalogInvalidation } from "../Services/ProviderAdapter.ts";

const PROVIDER = "codex" as const;

function codexResumeThreadId(cursor: unknown): string | null {
  if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return null;
  const threadId = (cursor as Record<string, unknown>).threadId;
  if (typeof threadId !== "string" || threadId.trim().length === 0) return null;
  return threadId.trim();
}

type CodexRuntimeIngressItem = {
  readonly nativeEvent: ProviderEvent;
  readonly runtimeEvents: ReadonlyArray<ProviderRuntimeEvent>;
};

function compactCodexNativeEventForIngress(event: ProviderEvent): ProviderEvent {
  let originalBytes: number;
  try {
    originalBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
  } catch {
    originalBytes = PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES + 1;
  }
  if (originalBytes <= PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES) {
    return event;
  }
  return {
    ...event,
    payload: {
      penkraTruncated: true,
      reason: "Codex native event exceeded the callback ingress size limit",
      originalBytes,
    },
  };
}

function codexRuntimeIngressItemBytes(item: CodexRuntimeIngressItem): number {
  let nativeBytes: number;
  try {
    nativeBytes = Buffer.byteLength(JSON.stringify(item.nativeEvent), "utf8");
  } catch {
    nativeBytes = PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES;
  }
  return (
    nativeBytes +
    item.runtimeEvents.reduce((total, event) => total + providerRuntimeEventBytes(event), 0)
  );
}

export interface CodexAdapterLiveOptions {
  readonly manager?: CodexAppServerManager;
  readonly makeManager?: (services?: ServiceMap.ServiceMap<never>) => CodexAppServerManager;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return sanitizeUserFacingErrorMessage(cause.message, fallback);
  }
  return fallback;
}

function sanitizeUserFacingErrorMessage(message: string, fallback: string): string {
  const normalized = message.trim();
  if (normalized.length === 0) {
    return fallback;
  }

  const firstLine = normalized.split("\n")[0]?.trim() ?? "";
  const withoutInlineStack = firstLine.replace(/\s+at file:\/\/.*$/s, "").trim();
  return withoutInlineStack.length > 0 ? withoutInlineStack : fallback;
}

function composeCodexInputWithFileAttachments(input: {
  readonly input: string | undefined;
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly attachmentsDir: string;
}): string | undefined {
  return appendFileAttachmentsPromptBlock({
    text: input.input,
    attachments: input.attachments,
    attachmentsDir: input.attachmentsDir,
    include: "all-files",
  });
}

function codexModelSelectionOverrides(
  modelSelection: ModelSelection | undefined,
): Pick<CodexAppServerSendTurnInput, "model" | "effort"> &
  Pick<CodexAppServerStartSessionInput, "serviceTier"> {
  if (modelSelection?.provider !== PROVIDER) {
    return {};
  }

  return {
    model: modelSelection.model,
    ...(modelSelection.options?.reasoningEffort !== undefined
      ? { effort: modelSelection.options.reasoningEffort }
      : {}),
    ...(modelSelection.options?.fastMode ? { serviceTier: "fast" } : {}),
  };
}

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  if (cause instanceof CodexSessionNotFoundError) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (
    cause instanceof CodexSessionClosedError ||
    cause instanceof CodexSessionStoppedRequestError
  ) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  const normalizedRequestCode =
    cause instanceof CodexJsonRpcResponseError
      ? cause.code
      : asObject(cause)?.code === PENDING_INTERACTION_NOT_FOUND_FAILURE_CODE
        ? PENDING_INTERACTION_NOT_FOUND_FAILURE_CODE
        : undefined;
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    ...(asObject(cause)?.requestOutcome === "rejected"
      ? { requestOutcome: "rejected" as const }
      : {}),
    ...(normalizedRequestCode !== undefined ? { code: normalizedRequestCode } : {}),
    cause,
  });
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const CODEX_ACTIONABLE_WARNING_CLASSES = {
  providerRetry: "provider-retry",
  mcpStartupFailure: "mcp-startup-failure",
  windowsWorldWritable: "windows-world-writable",
  windowsSandboxSetupFailure: "windows-sandbox-setup-failure",
} as const;

type CodexActionableWarningClass =
  (typeof CODEX_ACTIONABLE_WARNING_CLASSES)[keyof typeof CODEX_ACTIONABLE_WARNING_CLASSES];

function codexProviderErrorWarningClass(
  event: ProviderEvent,
): CodexActionableWarningClass | undefined {
  return event.kind === "error" && event.method === "mcpServer/startupFailed"
    ? CODEX_ACTIONABLE_WARNING_CLASSES.mcpStartupFailure
    : undefined;
}

function codexRuntimeDiagnostic(
  value: unknown,
):
  | { readonly key: string; readonly fingerprint: string; readonly state: "active" | "resolved" }
  | undefined {
  const diagnostic = asObject(asObject(value)?.diagnostic);
  const key = asString(diagnostic?.key)?.trim();
  const fingerprint = asString(diagnostic?.fingerprint)?.trim();
  const state = asString(diagnostic?.state);
  return key && fingerprint && (state === "active" || state === "resolved")
    ? { key, fingerprint, state }
    : undefined;
}

function normalizeCodexTokenUsage(value: unknown): ThreadTokenUsageSnapshot | undefined {
  const usage = asObject(value);
  const totalUsage = asObject(usage?.total_token_usage ?? usage?.total);
  const lastUsage = asObject(usage?.last_token_usage ?? usage?.last);

  const totalProcessedTokens =
    asNumber(totalUsage?.total_tokens) ?? asNumber(totalUsage?.totalTokens);
  const usedTokens =
    asNumber(lastUsage?.total_tokens) ?? asNumber(lastUsage?.totalTokens) ?? totalProcessedTokens;
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const maxTokens = asNumber(usage?.model_context_window) ?? asNumber(usage?.modelContextWindow);
  const inputTokens = asNumber(lastUsage?.input_tokens) ?? asNumber(lastUsage?.inputTokens);
  const cachedInputTokens =
    asNumber(lastUsage?.cached_input_tokens) ?? asNumber(lastUsage?.cachedInputTokens);
  const outputTokens = asNumber(lastUsage?.output_tokens) ?? asNumber(lastUsage?.outputTokens);
  const reasoningOutputTokens =
    asNumber(lastUsage?.reasoning_output_tokens) ?? asNumber(lastUsage?.reasoningOutputTokens);

  return {
    usedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(usedTokens !== undefined ? { lastUsedTokens: usedTokens } : {}),
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    compactsAutomatically: true,
  };
}

function toTurnId(value: string | undefined): TurnId | undefined {
  return value?.trim() ? TurnId.makeUnsafe(value) : undefined;
}

function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return value?.trim() ? ProviderItemId.makeUnsafe(value) : undefined;
}

function toTurnStatus(value: unknown): "completed" | "failed" | "cancelled" | "interrupted" {
  switch (value) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      return "completed";
  }
}

const CODEX_ITEM_TYPES = {
  userMessage: "user_message",
  hookPrompt: "unknown",
  agentMessage: "assistant_message",
  functionCallOutput: "unknown",
  plan: "plan",
  reasoning: "reasoning",
  commandExecution: "command_execution",
  fileChange: "file_change",
  mcpToolCall: "mcp_tool_call",
  dynamicToolCall: "dynamic_tool_call",
  collabAgentToolCall: "collab_agent_tool_call",
  subAgentActivity: "unknown",
  webSearch: "web_search",
  imageView: "image_view",
  sleep: "unknown",
  imageGeneration: "image_generation",
  enteredReviewMode: "review_entered",
  exitedReviewMode: "review_exited",
  contextCompaction: "context_compaction",
} satisfies Record<
  import("../generated/codex/v2/ThreadItem.ts").ThreadItem["type"],
  CanonicalItemType
>;

function toCanonicalItemType(raw: unknown): CanonicalItemType {
  return typeof raw === "string" && Object.hasOwn(CODEX_ITEM_TYPES, raw)
    ? CODEX_ITEM_TYPES[raw as keyof typeof CODEX_ITEM_TYPES]
    : "unknown";
}

function itemTitle(itemType: CanonicalItemType): string | undefined {
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    case "web_search":
      return "Web search";
    case "image_generation":
      return "Generated image";
    case "image_view":
      return "Image view";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

function joinedTextParts(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const object = asObject(entry);
      return asString(object?.text) ?? asString(object?.summary);
    })
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function itemDetail(
  item: Record<string, unknown>,
  payload: Record<string, unknown>,
): string | undefined {
  const nestedResult = asObject(item.result);
  const candidates = [
    asString(item.command),
    asString(item.title),
    asString(item.summary),
    joinedTextParts(item.summary),
    joinedTextParts(item.content),
    asString(item.review),
    asString(item.text),
    asString(item.saved_path),
    asString(item.savedPath),
    asString(item.path),
    asString(item.file_path),
    asString(item.prompt),
    asString(nestedResult?.command),
    asString(payload.command),
    asString(payload.message),
    asString(payload.prompt),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    return trimmed;
  }
  return undefined;
}

function itemInput(item: Record<string, unknown>): unknown {
  for (const candidate of [item.input, item.arguments, item.args, item.parameters]) {
    if (candidate !== undefined && candidate !== null) return candidate;
  }
  const command = asString(item.command);
  return command ? { command } : undefined;
}

function itemStatus(
  lifecycle: "item.started" | "item.updated" | "item.completed",
  rawStatus: unknown,
): "inProgress" | "completed" | "failed" | "declined" | undefined {
  if (lifecycle === "item.started") {
    return "inProgress";
  }
  if (lifecycle === "item.updated") {
    return undefined;
  }
  return rawStatus === "failed" || rawStatus === "declined" ? rawStatus : "completed";
}

function toCanonicalUserInputAnswers(
  answers: ProviderUserInputAnswers | undefined,
): ProviderUserInputAnswers {
  if (!answers) {
    return {};
  }

  const result: Record<string, string | ReadonlyArray<string> | null> = {};
  for (const [questionId, value] of Object.entries(answers)) {
    if (typeof value === "string") {
      result[questionId] = value;
      continue;
    }

    if (Array.isArray(value)) {
      const normalized = value.filter((entry): entry is string => typeof entry === "string");
      result[questionId] = normalized.length === 1 ? normalized[0]! : normalized;
      continue;
    }

    const nestedAnswers = asArray(asObject(value)?.answers);
    if (nestedAnswers) {
      const normalized = nestedAnswers.filter(
        (entry): entry is string => typeof entry === "string",
      );
      result[questionId] = normalized.length === 1 ? normalized[0]! : normalized;
      continue;
    }
  }
  return result;
}

function toThreadState(
  value: unknown,
): "active" | "idle" | "archived" | "closed" | "compacted" | "error" {
  switch (value) {
    case "idle":
      return "idle";
    case "archived":
      return "archived";
    case "closed":
      return "closed";
    case "compacted":
      return "compacted";
    case "error":
    case "failed":
      return "error";
    default:
      return "active";
  }
}

function contentStreamKindFromMethod(
  method: string,
): "assistant_text" | "command_output" | "file_change_output" {
  switch (method) {
    case "item/agentMessage/delta":
      return "assistant_text";
    case "item/commandExecution/outputDelta":
      return "command_output";
    case "item/fileChange/outputDelta":
      return "file_change_output";
    default:
      return "assistant_text";
  }
}

function asRuntimeItemId(itemId: ProviderItemId): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(itemId);
}

function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(requestId);
}

function asRuntimeTaskId(taskId: string): RuntimeTaskId {
  return RuntimeTaskId.makeUnsafe(taskId);
}

function codexEventMessage(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return asObject(payload?.msg);
}

function codexEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const payload = asObject(event.payload);
  const msg = codexEventMessage(payload);
  const turnId = event.turnId ?? toTurnId(asString(msg?.turn_id) ?? asString(msg?.turnId));
  const itemId = event.itemId ?? toProviderItemId(asString(msg?.item_id) ?? asString(msg?.itemId));
  const requestId = asString(msg?.request_id) ?? asString(msg?.requestId);
  const base = runtimeEventBase(event, canonicalThreadId);
  const providerRefs = base.providerRefs
    ? {
        ...base.providerRefs,
        ...(turnId ? { providerTurnId: turnId } : {}),
        ...(itemId ? { providerItemId: itemId } : {}),
        ...(requestId ? { providerRequestId: requestId } : {}),
      }
    : {
        ...(turnId ? { providerTurnId: turnId } : {}),
        ...(itemId ? { providerItemId: itemId } : {}),
        ...(requestId ? { providerRequestId: requestId } : {}),
      };

  return {
    ...base,
    ...(turnId ? { turnId } : {}),
    ...(itemId ? { itemId: asRuntimeItemId(itemId) } : {}),
    ...(requestId ? { requestId: asRuntimeRequestId(requestId) } : {}),
    ...(Object.keys(providerRefs).length > 0 ? { providerRefs } : {}),
  };
}

function codexGeneratedImageThreadId(
  event: ProviderEvent,
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const msg = codexEventMessage(payload);
  const nestedEvent = asObject(payload?.event);
  return (
    firstStringValue(msg, ["thread_id", "threadId", "threadID", "thread"]) ??
    firstStringValue(nestedEvent, ["thread_id", "threadId", "threadID", "thread"]) ??
    firstStringValue(payload, ["thread_id", "threadId", "threadID", "thread"]) ??
    event.providerThreadId ??
    event.threadId
  );
}

function sanitizeGeneratedImagePayload(event: ProviderEvent, canonicalThreadId: ThreadId): unknown {
  const payload = asObject(event.payload);
  return sanitizeNestedCodexGeneratedImagePayloads({
    value: event.payload ?? {},
    threadId: codexGeneratedImageThreadId(event, payload) ?? canonicalThreadId,
  });
}

function withSanitizedGeneratedImageRaw(
  base: Omit<ProviderRuntimeEvent, "type" | "payload">,
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  return {
    ...base,
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: sanitizeGeneratedImagePayload(event, canonicalThreadId),
    },
  };
}

function generatedImageEventCandidate(event: ProviderEvent): Record<string, unknown> | undefined {
  const payload = asObject(event.payload);
  const msg = codexEventMessage(payload);
  const item = asObject(payload?.item);
  const nestedEvent = asObject(payload?.event);
  if (item) {
    return item;
  }
  if (msg) {
    return {
      ...msg,
      type: asString(msg.type) ?? "image_generation_end",
    };
  }
  if (nestedEvent) {
    return {
      ...nestedEvent,
      type: asString(nestedEvent.type) ?? "image_generation_end",
    };
  }
  if (payload) {
    return {
      ...payload,
      type: asString(payload.type) ?? "image_generation_end",
    };
  }
  return undefined;
}

function mapGeneratedImageEndEvent(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ProviderRuntimeEvent | undefined {
  if (
    event.method !== "codex/event/image_generation_end" &&
    event.method !== "image_generation_end"
  ) {
    return undefined;
  }
  const payload = asObject(event.payload);
  const candidate = generatedImageEventCandidate(event);
  const reference = extractCodexGeneratedImageReference({
    value: candidate,
    threadId: codexGeneratedImageThreadId(event, payload) ?? canonicalThreadId,
  });
  if (!reference) {
    return undefined;
  }

  const turnId =
    event.turnId ??
    toTurnId(
      firstStringValue(candidate, ["turn_id", "turnId"]) ??
        firstStringValue(payload, ["turn_id", "turnId"]),
    );
  const itemId =
    event.itemId ??
    toProviderItemId(
      firstStringValue(candidate, ["item_id", "itemId", "call_id", "callId", "id"]) ??
        firstStringValue(payload, ["item_id", "itemId", "call_id", "callId", "id"]),
    );
  const base = withSanitizedGeneratedImageRaw(
    {
      ...runtimeEventBase(
        {
          ...event,
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
        },
        canonicalThreadId,
      ),
      ...(turnId ? { turnId } : {}),
      ...(itemId ? { itemId: asRuntimeItemId(itemId) } : {}),
    },
    event,
    canonicalThreadId,
  );

  return {
    ...base,
    type: "item.completed",
    payload: {
      itemType: "image_generation",
      status: "completed",
      title: "Generated image",
      detail: reference.path,
      data: codexGeneratedImageArtifact(reference),
    },
  };
}

function eventRawSource(event: ProviderEvent): NonNullable<ProviderRuntimeEvent["raw"]>["source"] {
  return event.kind === "request" ? "codex.app-server.request" : "codex.app-server.notification";
}

function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.providerThreadId) refs.providerThreadId = event.providerThreadId;
  if (event.providerParentThreadId) refs.providerParentThreadId = event.providerParentThreadId;
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.parentTurnId) refs.parentProviderTurnId = event.parentTurnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;

  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(event);
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.lifecycleGeneration !== undefined
      ? { lifecycleGeneration: event.lifecycleGeneration }
      : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.parentTurnId ? { parentTurnId: event.parentTurnId } : {}),
    ...(event.itemId ? { itemId: asRuntimeItemId(event.itemId) } : {}),
    ...(event.requestId ? { requestId: asRuntimeRequestId(event.requestId) } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

function mapItemLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): ProviderRuntimeEvent | undefined {
  const payload = asObject(event.payload);
  const item = asObject(payload?.item);
  const source = item ?? payload;
  if (!source) {
    return undefined;
  }

  const itemType = toCanonicalItemType(source.type ?? source.kind);
  if (itemType === "unknown" || itemType === "reasoning" || itemType === "plan") {
    return undefined;
  }
  const generatedImageReference =
    itemType === "image_generation"
      ? extractCodexGeneratedImageReference({
          value: source,
          threadId: codexGeneratedImageThreadId(event, payload) ?? canonicalThreadId,
        })
      : undefined;
  if (
    lifecycle === "item.completed" &&
    itemType === "image_generation" &&
    !generatedImageReference
  ) {
    return undefined;
  }

  const canonicalItemType =
    lifecycle === "item.completed" && itemType === "review_exited" ? "assistant_message" : itemType;

  const detail = itemDetail(source, payload ?? {});
  const status = itemStatus(lifecycle, source.status);
  const input = itemInput(source);

  return {
    ...(generatedImageReference
      ? withSanitizedGeneratedImageRaw(
          runtimeEventBase(event, canonicalThreadId),
          event,
          canonicalThreadId,
        )
      : runtimeEventBase(event, canonicalThreadId)),
    type: lifecycle,
    payload: {
      itemType: canonicalItemType,
      ...(status ? { status } : {}),
      ...(itemTitle(canonicalItemType) ? { title: itemTitle(canonicalItemType) } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(generatedImageReference
        ? { detail: generatedImageReference.path }
        : detail
          ? { detail }
          : {}),
      ...(generatedImageReference
        ? { data: codexGeneratedImageArtifact(generatedImageReference) }
        : event.payload !== undefined
          ? { data: event.payload }
          : {}),
    },
  };
}

function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const turn = asObject(payload?.turn);
  const generatedImageEndEvent = mapGeneratedImageEndEvent(event, canonicalThreadId);
  if (generatedImageEndEvent) {
    return [generatedImageEndEvent];
  }

  if (event.kind === "error") {
    if (!event.message) {
      return [];
    }
    const diagnostic = codexRuntimeDiagnostic(event.payload);
    if (event.method === "process/stderr" && !diagnostic) {
      return [];
    }
    const warningClass = codexProviderErrorWarningClass(event);
    const isDiagnosticWarning = diagnostic !== undefined;
    const isWarning = warningClass !== undefined || isDiagnosticWarning;
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: event.message,
          ...(diagnostic ? { diagnostic } : {}),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
        ...(isWarning
          ? { type: "runtime.warning" as const }
          : {
              type: "runtime.error" as const,
              payload: {
                message: event.message,
                class: "provider_error" as const,
                terminal: false,
                ...(event.payload !== undefined ? { detail: event.payload } : {}),
              },
            }),
      },
    ];
  }

  if (event.kind === "request") {
    if (event.method === "item/tool/requestUserInput") {
      // The manager refuses (and answers) unrenderable requests, so reaching
      // this branch with no questions means nothing is parked on the reply.
      const questions = parseCodexUserInputQuestions(payload);
      if (!questions) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.requested",
          payload: {
            questions,
          },
        },
      ];
    }

    return [];
  }

  if (event.method === "session/connecting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "starting",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/ready") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "ready",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.started",
        payload: {
          ...(event.message ? { message: event.message } : {}),
          ...(event.payload !== undefined ? { resume: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/exited" || event.method === "session/closed") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.exited",
        payload: {
          ...(event.message ? { reason: event.message } : {}),
          ...(event.method === "session/closed" ? { exitKind: "graceful" } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/started") {
    const payloadThreadId = asString(asObject(payload?.thread)?.id);
    const providerThreadId = payloadThreadId ?? asString(payload?.threadId);
    if (!providerThreadId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.started",
        payload: {
          providerThreadId,
        },
      },
    ];
  }

  if (event.method === "thread/compacting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.updated",
        payload: {
          itemType: "context_compaction",
          status: "inProgress",
          title: "Context compaction",
          detail: event.message ?? "Compacting context",
          ...(event.payload !== undefined ? { data: event.payload } : {}),
        },
      },
    ];
  }

  if (
    event.method === "thread/status/changed" ||
    event.method === "thread/archived" ||
    event.method === "thread/unarchived" ||
    event.method === "thread/closed" ||
    event.method === "thread/compacted"
  ) {
    return [
      {
        type: "thread.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state:
            event.method === "thread/archived"
              ? "archived"
              : event.method === "thread/closed"
                ? "closed"
                : event.method === "thread/compacted"
                  ? "compacted"
                  : toThreadState(asObject(payload?.thread)?.state ?? payload?.state),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/name/updated") {
    return [
      {
        type: "thread.metadata.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          ...(asString(payload?.threadName) ? { name: asString(payload?.threadName) } : {}),
          ...(event.payload !== undefined ? { metadata: asObject(event.payload) } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/tokenUsage/updated") {
    const tokenUsage = asObject(payload?.tokenUsage);
    const normalizedUsage = normalizeCodexTokenUsage(tokenUsage ?? event.payload);
    if (!normalizedUsage) {
      return [];
    }
    return [
      {
        type: "thread.token-usage.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          usage: normalizedUsage,
        },
      },
    ];
  }

  if (event.method === "turn/started") {
    const turnId = event.turnId;
    if (!turnId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId,
        type: "turn.started",
        payload: {
          ...(asString(turn?.model) ? { model: asString(turn?.model) } : {}),
          ...(asString(turn?.effort) ? { effort: asString(turn?.effort) } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/completed") {
    const errorMessage = asString(asObject(turn?.error)?.message);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.completed",
        payload: {
          state: toTurnStatus(turn?.status),
          ...(asString(turn?.stopReason) ? { stopReason: asString(turn?.stopReason) } : {}),
          ...(turn?.usage !== undefined ? { usage: turn.usage } : {}),
          ...(asObject(turn?.modelUsage) ? { modelUsage: asObject(turn?.modelUsage) } : {}),
          ...(asNumber(turn?.totalCostUsd) !== undefined
            ? { totalCostUsd: asNumber(turn?.totalCostUsd) }
            : {}),
          ...(errorMessage ? { errorMessage } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/aborted") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.aborted",
        payload: {
          reason: event.message ?? "Turn aborted",
        },
      },
    ];
  }

  if (event.method === "turn/plan/updated") {
    const steps = Array.isArray(payload?.plan) ? payload.plan : [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.tasks.updated",
        payload: {
          ...(asString(payload?.explanation)
            ? { explanation: asString(payload?.explanation) }
            : {}),
          tasks: steps.flatMap((entry) => {
            const taskEntry = asObject(entry);
            if (!taskEntry) {
              return [];
            }
            const item = makeRuntimeTaskListItem(
              asString(taskEntry.step) ?? "task",
              taskEntry.status,
            );
            return item ? [item] : [];
          }),
        },
      },
    ];
  }

  if (event.method === "item/started") {
    const started = mapItemLifecycle(event, canonicalThreadId, "item.started");
    return started ? [started] : [];
  }

  if (event.method === "item/completed") {
    const payload = asObject(event.payload);
    const item = asObject(payload?.item);
    const source = item ?? payload;
    if (!source) {
      return [];
    }
    const completed = mapItemLifecycle(event, canonicalThreadId, "item.completed");
    return completed ? [completed] : [];
  }

  if (
    event.method === "item/agentMessage/delta" ||
    event.method === "item/commandExecution/outputDelta" ||
    event.method === "item/fileChange/outputDelta"
  ) {
    const delta =
      event.textDelta ??
      asString(payload?.delta) ??
      asString(payload?.text) ??
      asString(asObject(payload?.content)?.text);
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: contentStreamKindFromMethod(event.method),
          delta,
          ...(typeof payload?.contentIndex === "number"
            ? { contentIndex: payload.contentIndex }
            : {}),
          ...(typeof payload?.summaryIndex === "number"
            ? { summaryIndex: payload.summaryIndex }
            : {}),
        },
      },
    ];
  }

  if (event.method === "item/mcpToolCall/progress") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "tool.progress",
        payload: {
          ...(asString(payload?.toolUseId) ? { toolUseId: asString(payload?.toolUseId) } : {}),
          ...(asString(payload?.toolName) ? { toolName: asString(payload?.toolName) } : {}),
          ...(asString(payload?.summary) ? { summary: asString(payload?.summary) } : {}),
          ...(asNumber(payload?.elapsedSeconds) !== undefined
            ? { elapsedSeconds: asNumber(payload?.elapsedSeconds) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "item/tool/requestUserInput/answered") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "user-input.resolved",
        payload: {
          answers: toCanonicalUserInputAnswers(
            asObject(event.payload)?.answers as ProviderUserInputAnswers | undefined,
          ),
        },
      },
    ];
  }

  if (event.method === "codex/event/task_started") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id) ?? asString(msg?.turn_id);
    if (!taskId) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.started",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          ...(asString(msg?.collaboration_mode_kind)
            ? { taskType: asString(msg?.collaboration_mode_kind) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "codex/event/task_complete") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id) ?? asString(msg?.turn_id);
    if (!taskId) return [];
    const events: ProviderRuntimeEvent[] = [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.completed",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          status: "completed",
          ...(asString(msg?.last_agent_message)
            ? { summary: asString(msg?.last_agent_message) }
            : {}),
        },
      },
    ];
    return events;
  }

  if (event.method === "model/rerouted") {
    return [
      {
        type: "model.rerouted",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          fromModel: asString(payload?.fromModel) ?? "unknown",
          toModel: asString(payload?.toModel) ?? "unknown",
          reason: asString(payload?.reason) ?? "unknown",
        },
      },
    ];
  }

  if (event.method === "deprecationNotice") {
    return [
      {
        type: "deprecation.notice",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: asString(payload?.summary) ?? "Deprecation notice",
          ...(asString(payload?.details) ? { details: asString(payload?.details) } : {}),
        },
      },
    ];
  }

  if (event.method === "configWarning") {
    return [
      {
        type: "config.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: asString(payload?.summary) ?? "Configuration warning",
          ...(asString(payload?.details) ? { details: asString(payload?.details) } : {}),
          ...(asString(payload?.path) ? { path: asString(payload?.path) } : {}),
          ...(payload?.range !== undefined ? { range: payload.range } : {}),
        },
      },
    ];
  }

  if (event.method === "account/updated") {
    return [
      {
        type: "account.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          account: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "account/rateLimits/updated") {
    return [
      {
        type: "account.rate-limits.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          rateLimits: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "mcpServer/oauthLogin/completed") {
    return [
      {
        type: "mcp.oauth.completed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          success: payload?.success === true,
          ...(asString(payload?.name) ? { name: asString(payload?.name) } : {}),
          ...(asString(payload?.error) ? { error: asString(payload?.error) } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/realtime/started") {
    const realtimeSessionId = asString(payload?.realtimeSessionId);
    return [
      {
        type: "thread.realtime.started",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          realtimeSessionId,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/itemAdded") {
    return [
      {
        type: "thread.realtime.item-added",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          item: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "thread/realtime/outputAudio/delta") {
    return [
      {
        type: "thread.realtime.audio.delta",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          audio: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "thread/realtime/error") {
    const message = asString(payload?.message) ?? event.message ?? "Realtime error";
    return [
      {
        type: "thread.realtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/closed") {
    return [
      {
        type: "thread.realtime.closed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          reason: event.message,
        },
      },
    ];
  }

  if (event.method === "error") {
    const message =
      asString(asObject(payload?.error)?.message) ?? event.message ?? "Provider runtime error";
    const willRetry = payload?.willRetry === true;
    if (isCodexToolAttemptFailure({ method: event.method, payload: event.payload })) {
      return [];
    }
    const warningClass = willRetry ? CODEX_ACTIONABLE_WARNING_CLASSES.providerRetry : undefined;
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        ...(warningClass
          ? {
              type: "runtime.warning" as const,
              payload: {
                message,
                ...(event.payload !== undefined ? { detail: event.payload } : {}),
              },
            }
          : {
              type: "runtime.error" as const,
              payload: {
                message,
                class: "provider_error" as const,
                terminal: true,
                ...(event.payload !== undefined ? { detail: event.payload } : {}),
              },
            }),
      },
    ];
  }

  if (event.method === "windows/worldWritableWarning") {
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: event.message ?? "Windows world-writable warning",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "windowsSandbox/setupCompleted") {
    const payloadRecord = asObject(event.payload);
    const success = payloadRecord?.success;
    const successMessage = event.message ?? "Windows sandbox setup completed";
    const failureMessage = event.message ?? "Windows sandbox setup failed";

    return [
      {
        type: "session.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state: success === false ? "error" : "ready",
          reason: success === false ? failureMessage : successMessage,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
      ...(success === false
        ? [
            {
              // A failed sandbox setup requires the user to repair their local
              // configuration before protected commands can run.
              type: "runtime.warning" as const,
              ...runtimeEventBase(event, canonicalThreadId),
              payload: {
                message: failureMessage,
                ...(event.payload !== undefined ? { detail: event.payload } : {}),
              },
            },
          ]
        : []),
    ];
  }

  return [];
}

const makeCodexAdapter = (options?: CodexAdapterLiveOptions) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* Effect.service(ServerConfig);
    // Optional so adapter tests can run without the gateway layer; when
    // present, every session gets the single penkra_exec_command gateway tool.
    const agentGatewayCredentials = Option.getOrUndefined(
      yield* Effect.serviceOption(AgentGatewayCredentials),
    );
    const agentGatewayToolBridge = Option.getOrUndefined(
      yield* Effect.serviceOption(AgentGatewayToolBridge),
    );
    if ((agentGatewayCredentials === undefined) !== (agentGatewayToolBridge === undefined)) {
      return yield* Effect.die(
        new Error(
          "ChatGPT's Penkra host-tool credentials and in-process dispatcher must be installed together.",
        ),
      );
    }
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const services = yield* Effect.services<never>();

    const manager = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        if (options?.manager) {
          return options.manager;
        }
        return (
          options?.makeManager?.(services) ??
          new CodexAppServerManager(services, {
            penkraSkillsDir: penkraSkillsDir(serverConfig.baseDir),
            stateDir: serverConfig.stateDir,
            ...(agentGatewayCredentials
              ? {
                  agentGatewayHostTool: {
                    acquireSessionLease: (threadId, lifecycleGeneration) =>
                      acquireAgentGatewaySessionLease(
                        agentGatewayCredentials,
                        threadId,
                        PROVIDER,
                        lifecycleGeneration,
                      )!,
                    beginTurn: (threadId, turnId, lifecycleGeneration) =>
                      agentGatewayCredentials.beginTurn(
                        threadId,
                        PROVIDER,
                        String(turnId),
                        lifecycleGeneration,
                      ),
                    requireNativeSurface: agentGatewayToolBridge!.requireSurface,
                  },
                }
              : {}),
          })
        );
      }),
      (manager) => Effect.promise(() => manager.stopAll()),
    );

    const pendingManagedRolloutAdoptions = new Map<
      ThreadId,
      {
        readonly launch: ProviderManagedLaunchContext;
        readonly nativeThreadId: string;
      }
    >();

    const prepareCodexManagerTurnInput = (
      input: ProviderSendTurnInput,
      method: "turn/start" | "turn/steer",
    ): Effect.Effect<CodexAppServerSendTurnInput, ProviderAdapterRequestError> =>
      Effect.gen(function* () {
        const imageBlocks = yield* loadProviderPromptImageBlocks({
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
          provider: PROVIDER,
          method,
          readFile: (attachmentPath) => fileSystem.readFile(attachmentPath),
          readErrorDetail: (cause) => toMessage(cause, "Failed to read attachment file."),
          invalidAttachmentError: (_attachment, cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method,
              detail: toMessage(cause, `${method} failed`),
              cause,
            }),
        });
        const nativeCodexAttachments = imageBlocks.map((attachment) => ({
          type: "image" as const,
          url: `data:${attachment.mimeType};base64,${attachment.data}`,
        }));
        const composedInput = composeCodexInputWithFileAttachments({
          input: input.input,
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
        });

        return {
          threadId: input.threadId,
          ...(input.clientMessageId !== undefined
            ? { clientMessageId: input.clientMessageId }
            : {}),
          ...(composedInput !== undefined ? { input: composedInput } : {}),
          ...(input.skills !== undefined ? { skills: input.skills } : {}),
          ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
          ...codexModelSelectionOverrides(input.modelSelection),
          ...(nativeCodexAttachments.length > 0 ? { attachments: nativeCodexAttachments } : {}),
        } satisfies CodexAppServerSendTurnInput;
      });

    const startSession: CodexAdapterShape["startSession"] = (input) => {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          }),
        );
      }

      const managerInput: CodexAppServerStartSessionInput = {
        threadId: input.threadId,
        provider: "codex",
        ...(input.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: input.lifecycleGeneration }
          : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
        ...(input.managedLaunch !== undefined ? { managedLaunch: input.managedLaunch } : {}),
        runtimeMode: input.runtimeMode,
        ...codexModelSelectionOverrides(input.modelSelection),
      };

      return Effect.callback<ProviderSession, ProviderAdapterProcessError>((resume, signal) => {
        let nativeStartEntered = false;
        const starting = (async () => {
          const resumeThreadId = codexResumeThreadId(input.resumeCursor);
          if (input.managedLaunch !== undefined && resumeThreadId !== null) {
            await prepareManagedCodexResume(input.managedLaunch, resumeThreadId);
          }
          signal.throwIfAborted();
          nativeStartEntered = true;
          const session = await manager.startSession(managerInput, signal);
          const nativeThreadId = codexResumeThreadId(session.resumeCursor);
          if (input.managedLaunch !== undefined) {
            if (nativeThreadId === null) {
              throw new Error("Codex did not return an exact native thread id.");
            }
            if (resumeThreadId === null) {
              pendingManagedRolloutAdoptions.set(input.threadId, {
                launch: input.managedLaunch,
                nativeThreadId,
              });
            }
          }
          return session;
        })();
        const settled = starting.then(
          (session) => resume(Effect.succeed(session)),
          (cause) =>
            resume(
              Effect.fail(
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: toMessage(cause, "Failed to start Codex adapter session."),
                  cause,
                }),
              ),
            ),
        );
        // Effect.tryPromise sends abort but does not await the promise's
        // cleanup. Ownership must survive that cleanup, including a native
        // start which won its race with abort and returned a live session.
        return Effect.promise(async () => {
          await settled;
          if (nativeStartEntered) await manager.stopSession(input.threadId);
          pendingManagedRolloutAdoptions.delete(input.threadId);
        });
      });
    };

    const sendTurn: CodexAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const managerInput = yield* prepareCodexManagerTurnInput(input, "turn/start");

        return yield* Effect.tryPromise({
          try: async () => {
            const result = await manager.sendTurn(managerInput);
            const pendingAdoption = pendingManagedRolloutAdoptions.get(input.threadId);
            if (pendingAdoption !== undefined) {
              await adoptManagedCodexRollout(
                pendingAdoption.launch,
                pendingAdoption.nativeThreadId,
                manager.getNativeThreadPath(input.threadId),
              );
              pendingManagedRolloutAdoptions.delete(input.threadId);
            }
            return result;
          },
          catch: (cause) => toRequestError(input.threadId, "turn/start", cause),
        }).pipe(
          Effect.map((result) => ({
            ...result,
            threadId: input.threadId,
          })),
        );
      });

    const steerTurn: CodexAdapterShape["steerTurn"] = (input) =>
      Effect.gen(function* () {
        const managerInput = yield* prepareCodexManagerTurnInput(input, "turn/steer");

        return yield* Effect.tryPromise({
          try: () => manager.steerTurn(managerInput),
          catch: (cause) => toRequestError(input.threadId, "turn/steer", cause),
        }).pipe(
          Effect.map((result) => ({
            ...result,
            threadId: input.threadId,
          })),
        );
      });

    const startReview: CodexAdapterShape["startReview"] = (input) =>
      Effect.tryPromise({
        try: () => manager.startReview(input),
        catch: (cause) => toRequestError(input.threadId, "review/start", cause),
      }).pipe(
        Effect.map((result) => ({
          ...result,
          threadId: input.threadId,
        })),
      );

    const interruptTurn: CodexAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.tryPromise({
        try: () => manager.interruptTurn(threadId, turnId),
        catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
      });

    const readThread: CodexAdapterShape["readThread"] = (threadId) =>
      Effect.tryPromise({
        try: () => manager.readThread(threadId),
        catch: (cause) => toRequestError(threadId, "thread/read", cause),
      }).pipe(
        Effect.map((snapshot) => ({
          threadId,
          turns: snapshot.turns,
          cwd: snapshot.cwd ?? null,
        })),
      );

    const rollbackThread: CodexAdapterShape["rollbackThread"] = (
      threadId,
      numTurns,
      beforeTurnId,
    ) => {
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          }),
        );
      }
      if (!beforeTurnId) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "Codex rewind requires the exact first excluded turn id.",
          }),
        );
      }

      return Effect.tryPromise({
        try: () => manager.revertThread(threadId, beforeTurnId),
        catch: (cause) => toRequestError(threadId, "thread/revert", cause),
      }).pipe(
        Effect.map((snapshot) => ({
          threadId,
          turns: snapshot.turns,
        })),
      );
    };

    const compactThread: NonNullable<CodexAdapterShape["compactThread"]> = (threadId) =>
      Effect.tryPromise({
        try: () => manager.compactThread(threadId),
        catch: (cause) => toRequestError(threadId, "thread/compact/start", cause),
      });

    const respondToUserInput: CodexAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.tryPromise({
        try: () => manager.respondToUserInput(threadId, requestId, answers),
        catch: (cause) => toRequestError(threadId, "item/tool/requestUserInput", cause),
      });

    const stopSession: CodexAdapterShape["stopSession"] = (threadId) =>
      Effect.tryPromise({
        try: async () => {
          pendingManagedRolloutAdoptions.delete(threadId);
          await manager.stopSession(threadId);
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: toMessage(cause, "Failed to stop Codex adapter session."),
            cause,
          }),
      });

    const listSessions: CodexAdapterShape["listSessions"] = () =>
      Effect.sync(() => manager.listSessions());

    const hasSession: CodexAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => manager.hasSession(threadId));

    const stopAccount: NonNullable<CodexAdapterShape["stopAccount"]> = (connectionId) =>
      Effect.tryPromise({
        try: () => manager.stopAccount(connectionId),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "stopAccount",
            detail: toMessage(cause, "Failed to stop the Codex account program."),
            cause,
          }),
      });

    const stopAll: CodexAdapterShape["stopAll"] = () =>
      Effect.tryPromise({
        try: async () => {
          pendingManagedRolloutAdoptions.clear();
          await manager.stopAll();
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: ThreadId.makeUnsafe("codex:all"),
            detail: toMessage(cause, "Failed to stop all Codex app-server processes."),
            cause,
          }),
      });

    const getComposerCapabilities: NonNullable<CodexAdapterShape["getComposerCapabilities"]> = () =>
      Effect.succeed(manager.getComposerCapabilities() satisfies ProviderComposerCapabilities);

    const getCapabilityHealth: NonNullable<CodexAdapterShape["getCapabilityHealth"]> = (input) =>
      Effect.tryPromise({
        try: async () => ({
          capabilities: [
            {
              id: "computer-use",
              ...(await manager.getComputerUseCapabilityHealth(
                ThreadId.makeUnsafe(input.threadId),
              )),
            },
          ],
          source: "codex-app-server",
        }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "mcpServerStatus/list",
            detail: toMessage(cause, "Computer Use capability preflight failed"),
            cause,
          }),
      });

    const catalogChanges = makeInvalidationHub<ProviderCatalogInvalidation>((event) =>
      JSON.stringify([event.connectionId, event.kinds]),
    );
    const catalogListener = (event: Omit<ProviderCatalogInvalidation, "provider">) =>
      catalogChanges.publish({ ...event, provider: PROVIDER });
    yield* Effect.acquireRelease(
      Effect.sync(() => manager.on("catalogInvalidated", catalogListener)),
      () =>
        Effect.sync(() => {
          manager.off("catalogInvalidated", catalogListener);
        }).pipe(Effect.andThen(catalogChanges.close)),
    );

    const loadCatalog: NonNullable<CodexAdapterShape["loadCatalog"]> = (input) =>
      Effect.tryPromise({
        try: () => manager.loadCatalog(input),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "catalog/load",
            detail: toMessage(cause, "Codex catalog load failed"),
            cause,
          }),
      });

    const probeTurnEndpoint: NonNullable<CodexAdapterShape["probeTurnEndpoint"]> = (input) =>
      Effect.tryPromise({
        try: () => manager.probeResponses(input),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "auth/probe-responses",
            detail: toMessage(cause, "Responses probe failed"),
            cause,
          }),
      });

    const transcribeVoice: NonNullable<CodexAdapterShape["transcribeVoice"]> = (input) =>
      Effect.tryPromise({
        try: () => manager.transcribeVoice(input),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "voice/transcribe",
            detail: toMessage(cause, "voice/transcribe failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ServerVoiceTranscriptionResult));

    const runtimeEventQueue = yield* Queue.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );

    const runtimeEventIngress = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const writeNativeEvent = (event: ProviderEvent) =>
          Effect.gen(function* () {
            if (!nativeEventLogger) {
              return;
            }
            yield* nativeEventLogger.write(event, event.threadId);
          });

        const ingress = yield* makeBoundedCallbackIngress<CodexRuntimeIngressItem, never, never>(
          (item) =>
            Effect.gen(function* () {
              yield* writeNativeEvent(item.nativeEvent).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Codex native event logging failed", {
                    threadId: item.nativeEvent.threadId,
                    method: item.nativeEvent.method,
                    cause: Cause.pretty(cause),
                  }),
                ),
              );
              const runtimeEvents = item.runtimeEvents;
              if (runtimeEvents.length === 0) {
                yield* Effect.logDebug("ignoring unhandled Codex provider event", {
                  method: item.nativeEvent.method,
                  threadId: item.nativeEvent.threadId,
                  turnId: item.nativeEvent.turnId,
                  itemId: item.nativeEvent.itemId,
                });
                return;
              }
              yield* Queue.offerAll(runtimeEventQueue, runtimeEvents);
            }),
          {
            capacity: PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
            maxBufferedBytes: PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES,
            terminalReserve: PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE,
            isTerminal: (item) => item.runtimeEvents.some(isTerminalProviderRuntimeEvent),
            sizeOf: codexRuntimeIngressItemBytes,
          },
        );
        const listener = (event: ProviderEvent) => {
          const runtimeEvents = assignDerivedProviderRuntimeEventIds(
            mapToRuntimeEvents(event, event.threadId),
          ).map(compactProviderRuntimeEventForIngress);
          // Codex assigns the turn id inside app-server. Its turn/started
          // notification is handled synchronously before the next protocol
          // message, including an immediate dynamic-tool request.
          for (const runtimeEvent of runtimeEvents) {
            if (
              runtimeEvent.type === "turn.started" &&
              runtimeEvent.turnId !== undefined &&
              runtimeEvent.providerRefs?.providerParentThreadId === undefined
            ) {
              agentGatewayCredentials?.beginTurn(
                runtimeEvent.threadId,
                PROVIDER,
                String(runtimeEvent.turnId),
                runtimeEvent.lifecycleGeneration,
              );
            } else if (
              (runtimeEvent.type === "turn.completed" || runtimeEvent.type === "turn.aborted") &&
              runtimeEvent.turnId !== undefined &&
              runtimeEvent.providerRefs?.providerParentThreadId === undefined
            ) {
              agentGatewayCredentials?.endTurn(
                runtimeEvent.threadId,
                PROVIDER,
                String(runtimeEvent.turnId),
                runtimeEvent.lifecycleGeneration,
              );
            } else if (
              runtimeEvent.type === "session.exited" &&
              runtimeEvent.providerRefs?.providerParentThreadId === undefined
            ) {
              agentGatewayCredentials?.endSession(
                runtimeEvent.threadId,
                PROVIDER,
                runtimeEvent.lifecycleGeneration,
              );
            }
          }
          const result = ingress.offer({
            nativeEvent: compactCodexNativeEventForIngress(event),
            runtimeEvents,
          });
          if (result === "terminal-overflow") {
            // This means the reserved terminal budget itself was exhausted.
            // The runtime reconciler remains the final recovery fence.
            void Effect.runPromise(
              Effect.logError("Codex callback ingress exhausted terminal reserve", {
                threadId: event.threadId,
                method: event.method,
                status: ingress.status(),
              }),
            );
          }
        };
        manager.on("event", listener);
        return { ingress, listener };
      }),
      ({ ingress, listener }) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            manager.off("event", listener);
          });
          yield* ingress.stop;
          yield* Queue.shutdown(runtimeEventQueue);
        }),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
        supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: true,
        supportsPluginDiscovery: true,
        supportsRuntimeModelList: true,
        supportsTurnSteering: true,
      },
      startSession,
      sendTurn,
      steerTurn,
      startReview,
      interruptTurn,
      readThread,
      rollbackThread,
      compactThread,

      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      stopAccount,
      drainRuntimeEvents: runtimeEventIngress.ingress.stop.pipe(
        Effect.andThen(
          awaitProviderRuntimeEventsDrained(
            Queue.size(runtimeEventQueue).pipe(Effect.map((size) => size === 0)),
          ),
        ),
      ),
      getComposerCapabilities,
      getCapabilityHealth,
      loadCatalog,
      catalogChanges: catalogChanges.stream(),
      probeTurnEndpoint,
      transcribeVoice,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies CodexAdapterShape;
  });

export const CodexAdapterLive = Layer.effect(CodexAdapter, makeCodexAdapter());

export function makeCodexAdapterLive(options?: CodexAdapterLiveOptions) {
  return Layer.effect(CodexAdapter, makeCodexAdapter(options));
}
