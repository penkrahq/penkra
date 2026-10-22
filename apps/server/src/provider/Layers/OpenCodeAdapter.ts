import { randomUUID } from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  type ProviderKind,
  type ProviderComposerCapabilities,
  type ProviderCatalogData,
  type ProviderModelDescriptor,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadTokenUsageSnapshot,
  type ProviderConnectionId,
  ThreadId,
  type ToolLifecycleItemType,
  TurnId,
  type UserInputQuestion,
} from "@penkra/contracts";
import { Cause, Deferred, Effect, Exit, Layer, Option, Queue, Ref, Scope, Stream } from "effect";
import type {
  AssistantMessage,
  OpencodeClient,
  Part,
  PermissionRequest,
  QuestionRequest,
  Todo,
} from "@opencode-ai/sdk/v2";

import { resolveProviderAttachmentPath } from "../providerAttachmentPaths.ts";
import { PENDING_INTERACTION_NOT_FOUND_FAILURE_CODE } from "@penkra/shared/threadSummary";
import { ServerConfig } from "../../config.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { takePenkraHostPolicyForSession } from "../../agentGateway/harnessPolicy.ts";
import { AgentGatewayToolBridge } from "../../agentGateway/Services/AgentGatewayToolBridge.ts";
import { ensureOpenCodeGatewayPlugin } from "../openCodeGatewayPlugin.ts";
import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { loadOpenCodeConfigContent } from "../openCodeSharedMcpConfig.ts";
import {
  acquireAgentGatewaySessionLease,
  type AgentGatewaySessionLease,
} from "../../agentGateway/sessionLease.ts";
import { OpenCodeAdapter, type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  awaitProviderRuntimeEventsDrained,
  PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
  type ProviderManagedLaunchContext,
} from "../Services/ProviderAdapter.ts";
import {
  buildOpenCodePermissionRules,
  type OpenCodeCompatibleCliSpec,
  OPENCODE_CLI_SPEC,
  type OpenCodeRuntimeShape,
  OpenCodeRuntime,
  OpenCodeRuntimeLive,
  OpenCodeRuntimeError,
  openCodeQuestionId,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  runOpenCodeSdk,
  toOpenCodeFileParts,
  toOpenCodeQuestionAnswers,
  type OpenCodeServerConnection,
} from "../opencodeRuntime.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { makeRuntimeTaskListItem, nonEmptyRuntimeTaskListPayload } from "../runtimeTaskList.ts";
import {
  buildOpenCodeModelContextLimitMap,
  flattenOpenCodeAgents,
  flattenOpenCodeCommands,
  flattenOpenCodeModels,
  resolvePreferredOpenCodeModelProviders,
} from "../OpenCodeDiscovery.ts";
import { nonNegativeFiniteNumber, nonNegativeInteger, positiveInteger } from "../tokenUsage.ts";
import { providerPermissionDecision } from "../providerPermissionPolicy.ts";

type OpenCodeCompatibleProvider = Extract<ProviderKind, "opencode">;

interface OpenCodeCompatibleAdapterConfig {
  readonly provider: OpenCodeCompatibleProvider;
  readonly displayName: string;
  readonly defaultBinaryPath: string;
  readonly providerOptionsKey: OpenCodeCompatibleProvider;
  readonly runtimeEventSource: "opencode.sdk.event";
  readonly turnIdPrefix: string;
  readonly defaultAgent: string;
  readonly planAgent: string;
  readonly cliSpec: OpenCodeCompatibleCliSpec;
}

const OPENCODE_ADAPTER_CONFIG: OpenCodeCompatibleAdapterConfig = {
  provider: "opencode",
  displayName: "OpenCode",
  defaultBinaryPath: "opencode",
  providerOptionsKey: "opencode",
  runtimeEventSource: "opencode.sdk.event",
  turnIdPrefix: "opencode-turn",
  defaultAgent: "build",
  planAgent: "plan",
  cliSpec: OPENCODE_CLI_SPEC,
};

const OPENCODE_MAX_RELATED_SESSIONS = 256;

const OPENCODE_ACTIONABLE_WARNING_CLASSES = {
  permissionPolicyFailure: "permission-policy-failure",
  providerRetry: "provider-retry",
} as const;

type OpenCodeActionableWarningClass =
  (typeof OPENCODE_ACTIONABLE_WARNING_CLASSES)[keyof typeof OPENCODE_ACTIONABLE_WARNING_CLASSES];

function openCodeActionableWarningMessage(
  warningClass: OpenCodeActionableWarningClass,
  message: string,
): string {
  switch (warningClass) {
    case OPENCODE_ACTIONABLE_WARNING_CLASSES.permissionPolicyFailure:
    case OPENCODE_ACTIONABLE_WARNING_CLASSES.providerRetry:
      return message;
  }
}

type OpenCodeSubscribedEvent =
  Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>> extends {
    readonly stream: AsyncIterable<infer TEvent>;
  }
    ? TEvent
    : never;

interface OpenCodeTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface OpenCodeSessionContext {
  readonly connectionId: ProviderConnectionId | null;
  hostPolicyDelivered?: boolean;
  gatewaySessionLease?: AgentGatewaySessionLease;
  session: ProviderSession;
  readonly lifecycleGeneration?: string;
  readonly client: OpencodeClient;
  readonly server: OpenCodeServerConnection;
  readonly directory: string;
  readonly openCodeSessionId: string;
  /** Permission request ids resolved by Penkra policy and never surfaced to the UI. */
  readonly policyResolvedPermissionIds: Set<string>;
  readonly pendingQuestions: Map<string, QuestionRequest>;
  readonly pendingTextDeltasByPartId: Map<string, string>;
  readonly messageRoleById: Map<string, "user" | "assistant">;
  readonly messageSnapshotKeyById: Map<string, string>;
  readonly partById: Map<string, Part>;
  readonly toolTurnById: Map<string, TurnId>;
  readonly childTurnBySessionId: Map<string, TurnId>;
  readonly partSnapshotKeyById: Map<string, string>;
  readonly emittedTextByPartId: Map<string, string>;
  readonly completedAssistantPartIds: Set<string>;
  readonly relatedSessionIds: Set<string>;
  readonly turns: Array<OpenCodeTurnSnapshot>;
  readonly modelContextLimitBySlug: Map<string, number>;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  lastEmittedTokenUsageKey: string | undefined;
  latestTurnCostUsd: number | undefined;
  activeTurnId: TurnId | undefined;
  turnSettled: Deferred.Deferred<void, ProviderAdapterRequestError> | undefined;
  /** The abort request whose provider-side `session.error: Aborted` echo is expected. */
  pendingAbortErrorTurnId: TurnId | undefined;
  activeAgent: string | undefined;
  activeVariant: string | undefined;
  readonly stopped: Ref.Ref<boolean>;
  readonly sessionScope: Scope.Closeable;
}

function releaseOpenCodeGatewayLease(context: OpenCodeSessionContext): void {
  context.gatewaySessionLease?.release();
  delete context.gatewaySessionLease;
}

interface OpenCodeMessageSnapshot {
  readonly info: {
    readonly id: string;
    readonly role: "user" | "assistant";
    readonly parentID?: string;
    readonly time?: {
      readonly completed?: number;
    };
    readonly finish?: string;
  };
  readonly parts: ReadonlyArray<Part>;
}

export interface OpenCodeAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly runtime?: OpenCodeRuntimeShape;
  readonly agentGatewayCredentials?: AgentGatewayCredentialsShape;
  readonly adapterConfig?: OpenCodeCompatibleAdapterConfig;
  readonly beforeSessionInstall?: Effect.Effect<void>;
  readonly loadSharedMcpConfig?: (homeDir: string) => Promise<string>;
  readonly prepareGatewayPlugin?: typeof ensureOpenCodeGatewayPlugin;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toRequestError(
  provider: OpenCodeCompatibleProvider,
  cause: OpenCodeRuntimeError,
): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider,
    method: cause.operation,
    detail: cause.detail,
    cause: cause.cause,
  });
}

function toProcessError(
  provider: OpenCodeCompatibleProvider,
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterProcessError {
  return new ProviderAdapterProcessError({
    provider,
    threadId,
    detail: OpenCodeRuntimeError.is(cause) ? cause.detail : openCodeRuntimeErrorDetail(cause),
    cause,
  });
}

function asRuntimeItemId(value: string) {
  return RuntimeItemId.makeUnsafe(value);
}

function buildProviderEventBase(input: {
  readonly provider: OpenCodeCompatibleProvider;
  readonly runtimeEventSource: "opencode.sdk.event";
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: unknown;
}): Pick<
  ProviderRuntimeEvent,
  "eventId" | "provider" | "threadId" | "createdAt" | "turnId" | "itemId" | "requestId" | "raw"
> {
  return {
    // OpenCode's event stream does not expose a provider occurrence id or replay cursor. A
    // cumulative native snapshot can also fan out into several canonical deltas, so hashing that
    // snapshot is neither unique per occurrence nor a safe replay identity. Assign identity at
    // this canonical emission boundary; completed text snapshots reconcile replayed fragments.
    eventId: EventId.makeUnsafe(randomUUID()),
    provider: input.provider,
    threadId: input.threadId,
    createdAt: input.createdAt ?? nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: asRuntimeItemId(input.itemId) } : {}),
    ...(input.requestId ? { requestId: RuntimeRequestId.makeUnsafe(input.requestId) } : {}),
    ...(input.raw !== undefined
      ? {
          raw: {
            source: input.runtimeEventSource,
            payload: input.raw,
          },
        }
      : {}),
  };
}

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) return "command_execution";
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }
  if (normalized.includes("web")) return "web_search";
  if (normalized.includes("mcp")) return "mcp_tool_call";
  if (normalized.includes("image")) return "image_view";
  if (
    normalized.includes("task") ||
    normalized.includes("agent") ||
    normalized.includes("subtask")
  ) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function resolveTurnSnapshot(
  context: OpenCodeSessionContext,
  turnId: TurnId,
): OpenCodeTurnSnapshot {
  const existing = context.turns.find((turn) => turn.id === turnId);
  if (existing) {
    return existing;
  }

  const created: OpenCodeTurnSnapshot = { id: turnId, items: [] };
  context.turns.push(created);
  return created;
}

function appendTurnItem(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
  item: unknown,
): void {
  if (!turnId) {
    return;
  }
  resolveTurnSnapshot(context, turnId).items.push(item);
}

function openCodeSnapshotKey(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function rememberOpenCodeMessageSnapshot(
  context: OpenCodeSessionContext,
  snapshot: OpenCodeMessageSnapshot,
): void {
  context.messageRoleById.set(snapshot.info.id, snapshot.info.role);
  context.messageSnapshotKeyById.set(snapshot.info.id, openCodeSnapshotKey(snapshot.info));

  for (const part of snapshot.parts) {
    context.partById.set(part.id, part);
    context.partSnapshotKeyById.set(part.id, openCodeSnapshotKey(part));

    const text = textFromPart(part);
    if (text !== undefined) {
      context.emittedTextByPartId.set(part.id, text);
    }
    if (
      part.type === "text" &&
      shouldProjectOpenCodeTextPart(part) &&
      part.time?.end !== undefined
    ) {
      context.completedAssistantPartIds.add(part.id);
    }
  }
}

function openCodeMessageSnapshotFromEntry(entry: {
  readonly info: {
    readonly id: string;
    readonly role: string;
    readonly parentID?: string;
    readonly time?: {
      readonly created?: number;
      readonly completed?: number;
    };
    readonly finish?: string;
  };
  readonly parts: ReadonlyArray<Part>;
}): OpenCodeMessageSnapshot | undefined {
  if (entry.info.role !== "user" && entry.info.role !== "assistant") {
    return undefined;
  }
  return {
    info: {
      ...entry.info,
      role: entry.info.role,
    },
    parts: entry.parts,
  };
}

function openCodeMessageSnapshotsFromResponse(
  entries: ReadonlyArray<{
    readonly info: {
      readonly id: string;
      readonly role: string;
      readonly time?: {
        readonly created?: number;
        readonly completed?: number;
      };
      readonly finish?: string;
    };
    readonly parts: ReadonlyArray<Part>;
  }>,
): ReadonlyArray<OpenCodeMessageSnapshot> {
  return entries.flatMap((entry) => {
    const snapshot = openCodeMessageSnapshotFromEntry(entry);
    return snapshot ? [snapshot] : [];
  });
}

function ensureSessionContext(
  provider: OpenCodeCompatibleProvider,
  sessions: ReadonlyMap<ThreadId, OpenCodeSessionContext>,
  threadId: ThreadId,
): OpenCodeSessionContext {
  const session = sessions.get(threadId);
  if (!session) {
    throw new ProviderAdapterSessionNotFoundError({
      provider,
      threadId,
    });
  }
  if (Ref.getUnsafe(session.stopped)) {
    throw new ProviderAdapterSessionClosedError({
      provider,
      threadId,
    });
  }
  return session;
}

function normalizeQuestionRequest(request: QuestionRequest): ReadonlyArray<UserInputQuestion> {
  return request.questions.map((question, index) => ({
    id: openCodeQuestionId(index, question),
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
    ...(question.multiple ? { multiSelect: true } : {}),
  }));
}

function normalizeOpenCodeTodoTasks(todos: ReadonlyArray<Todo>): {
  readonly tasks: ReadonlyArray<{
    readonly task: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
} | null {
  const tasks = todos.flatMap((todo) => {
    const task = makeRuntimeTaskListItem(todo.content, todo.status);
    return task ? [task] : [];
  });

  return nonEmptyRuntimeTaskListPayload(tasks);
}

function resolveTextStreamKind(part: Part | undefined): "assistant_text" | "reasoning_text" {
  return part?.type === "reasoning" ? "reasoning_text" : "assistant_text";
}

function shouldProjectOpenCodeTextPart(part: Part): boolean {
  // Synthetic/ignored text parts are local runtime progress, not assistant transcript.
  return part.type !== "text" || (!part.synthetic && !part.ignored);
}

function textFromPart(part: Part): string | undefined {
  switch (part.type) {
    case "text":
      return shouldProjectOpenCodeTextPart(part) ? part.text : undefined;
    case "reasoning":
      return part.text;
    default:
      return undefined;
  }
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function resolveLatestAssistantText(previousText: string | undefined, nextText: string): string {
  if (previousText && previousText.length > nextText.length && previousText.startsWith(nextText)) {
    return previousText;
  }
  return nextText;
}

function mergeOpenCodeAssistantText(
  previousText: string | undefined,
  nextText: string,
  options?: { readonly authoritative?: boolean },
): { readonly latestText: string; readonly deltaToEmit: string } {
  if (options?.authoritative) {
    const previous = previousText ?? "";
    return {
      latestText: nextText,
      // A terminal snapshot can safely extend an observed prefix. If it instead corrects or
      // shortens speculative deltas, emit no append: item.completed replaces the projection with
      // this authoritative snapshot.
      deltaToEmit: nextText.startsWith(previous) ? nextText.slice(previous.length) : "",
    };
  }
  const latestText = resolveLatestAssistantText(previousText, nextText);
  return {
    latestText,
    deltaToEmit: latestText.slice(commonPrefixLength(previousText ?? "", latestText)),
  };
}

function appendOpenCodeAssistantTextDelta(
  previousText: string,
  delta: string,
): { readonly nextText: string; readonly deltaToEmit: string } {
  return {
    // OpenCode's `*.delta` payload is an incremental token, not a cumulative
    // snapshot. Removing a prefix merely because it matches the preceding
    // suffix corrupts legitimate boundaries such as `STE` + `ERING`.
    // Duplicate transport events are rejected by event identity upstream.
    nextText: previousText + delta,
    deltaToEmit: delta,
  };
}

function bufferPendingTextDelta(
  context: OpenCodeSessionContext,
  partId: string,
  delta: string,
): void {
  if (delta.length === 0) {
    return;
  }
  const previousText = context.pendingTextDeltasByPartId.get(partId) ?? "";
  const { nextText } = appendOpenCodeAssistantTextDelta(previousText, delta);
  context.pendingTextDeltasByPartId.set(partId, nextText);
}

function applyPendingTextDeltaToPart(context: OpenCodeSessionContext, part: Part): Part {
  if (part.type !== "text" && part.type !== "reasoning") {
    context.pendingTextDeltasByPartId.delete(part.id);
    return part;
  }

  const pendingDelta = context.pendingTextDeltasByPartId.get(part.id);
  if (!pendingDelta || pendingDelta.length === 0) {
    return part;
  }

  context.pendingTextDeltasByPartId.delete(part.id);
  // A completed OpenCode part is the provider's authoritative snapshot. Deltas can arrive before
  // the corresponding message role, leaving the final fragment buffered; appending that fragment
  // to a terminal snapshot duplicates its suffix (for example `ABC` + buffered `C` => `ABCC`).
  if (part.type === "text" && part.time?.end !== undefined) {
    return part;
  }

  const previousPart = context.partById.get(part.id);
  const previousText =
    previousPart?.type === "text" || previousPart?.type === "reasoning" ? previousPart.text : "";
  const pendingText = appendOpenCodeAssistantTextDelta(previousText, pendingDelta).nextText;
  // Non-terminal snapshots and buffered deltas are two views of the same growing part. Preserve
  // whichever is the longer compatible prefix instead of blindly appending the delta twice.
  const nextText = resolveLatestAssistantText(pendingText, part.text);
  return nextText === part.text ? part : { ...part, text: nextText };
}

function isoFromEpochMs(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(value).toISOString();
}

function messageRoleForPart(
  context: OpenCodeSessionContext,
  part: Pick<Part, "messageID" | "type">,
): "assistant" | "user" | undefined {
  const known = context.messageRoleById.get(part.messageID);
  if (known) {
    return known;
  }
  return part.type === "tool" ? "assistant" : undefined;
}

function detailFromToolPart(part: Extract<Part, { type: "tool" }>): string | undefined {
  const normalizeDetail = (detail: string | undefined) => {
    const trimmed = detail?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
  };
  switch (part.state.status) {
    case "completed":
      return normalizeDetail(part.state.output);
    case "error":
      return normalizeDetail(part.state.error);
    case "running":
      return normalizeDetail(part.state.title);
    default:
      return undefined;
  }
}

function toolStateCreatedAt(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "running":
      return isoFromEpochMs(part.state.time.start);
    case "completed":
    case "error":
      return isoFromEpochMs(part.state.time.end);
    default:
      return undefined;
  }
}

function sessionErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "OpenCode session failed.";
  }
  const data = "data" in error && error.data && typeof error.data === "object" ? error.data : null;
  const message =
    data && "message" in data
      ? data.message
      : "message" in error
        ? error.message
        : "error" in error
          ? error.error
          : null;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : "OpenCode session failed.";
}

function isOpenCodeContextOverflowError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "ContextOverflowError"
  );
}

function updateProviderSession(
  context: OpenCodeSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): ProviderSession {
  const nextSession = {
    ...context.session,
    ...patch,
    updatedAt: nowIso(),
  } as ProviderSession & Record<string, unknown>;
  const mutableSession = nextSession as Record<string, unknown>;
  if (options?.clearActiveTurnId) {
    delete mutableSession.activeTurnId;
  }
  if (options?.clearLastError) {
    delete mutableSession.lastError;
  }
  context.session = nextSession;
  return nextSession;
}

function clearActiveTurnState(context: OpenCodeSessionContext): void {
  context.activeTurnId = undefined;
  context.activeAgent = undefined;
  context.activeVariant = undefined;
  context.latestTurnCostUsd = undefined;
  context.relatedSessionIds.clear();
  // Deliberately NOT cleared here: a permission policy-resolved at the tail of a turn can
  // have its permission.replied echo arrive after turn teardown, and dropping the id first
  // would misclassify that echo as a real resolution (orphaned "Approval resolved" in the
  // UI). Ids are unique per request so stale entries are inert; the set is freed with the
  // session context when the session is removed.
}

function openCodeNextTextItemId(turnId: TurnId): string {
  return `${turnId}-next-text`;
}

function isoFromOpenCodeTimestamp(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : undefined;
}

function openCodeToolContentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((item) =>
      item && typeof item === "object" && "type" in item && item.type === "text"
        ? [String((item as { text?: unknown }).text ?? "")]
        : [],
    )
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isOpenCodeTerminalStepFinish(value: unknown): boolean {
  const finish = trimNonEmptyString(value)?.toLowerCase().replace(/_/gu, "-");
  if (!finish) {
    return false;
  }
  return !["tool-call", "tool-calls", "function-call", "continue", "unknown"].includes(finish);
}

function extractResumeSessionId(resumeCursor: unknown): string | undefined {
  if (typeof resumeCursor === "string" && resumeCursor.trim().length > 0) {
    return resumeCursor.trim();
  }
  if (
    resumeCursor &&
    typeof resumeCursor === "object" &&
    "openCodeSessionId" in resumeCursor &&
    typeof resumeCursor.openCodeSessionId === "string" &&
    resumeCursor.openCodeSessionId.trim().length > 0
  ) {
    return resumeCursor.openCodeSessionId.trim();
  }
  return undefined;
}

function extractResumeCwd(resumeCursor: unknown): string | undefined {
  if (
    resumeCursor &&
    typeof resumeCursor === "object" &&
    "cwd" in resumeCursor &&
    typeof resumeCursor.cwd === "string" &&
    resumeCursor.cwd.trim().length > 0
  ) {
    return resumeCursor.cwd.trim();
  }
  return undefined;
}

function openCodeRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function rememberRelatedOpenCodeSession(
  context: OpenCodeSessionContext,
  part: Extract<Part, { type: "tool" }>,
  turnId?: TurnId,
): void {
  const state = openCodeRecord(part.state);
  const metadata = openCodeRecord(state?.metadata) ?? openCodeRecord(part.metadata);
  const childSessionId =
    trimNonEmptyString(metadata?.sessionId) ?? trimNonEmptyString(metadata?.sessionID);
  if (!childSessionId || childSessionId === context.openCodeSessionId) {
    return;
  }
  context.relatedSessionIds.add(childSessionId);
  if (turnId && !context.childTurnBySessionId.has(childSessionId))
    context.childTurnBySessionId.set(childSessionId, turnId);
}

function subscribedEventSessionId(event: OpenCodeSubscribedEvent): string | undefined {
  if (!("properties" in event)) {
    return undefined;
  }

  const properties = event.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return undefined;
  }

  const sessionId = (properties as { readonly sessionID?: unknown }).sessionID;
  return typeof sessionId === "string" ? sessionId : undefined;
}

function shouldHandleRelatedOpenCodeSessionEvent(event: OpenCodeSubscribedEvent): boolean {
  if (event.type.startsWith("session.next.tool.") || event.type.startsWith("session.next.shell.")) {
    return true;
  }
  if (event.type === "message.part.updated") {
    return event.properties.part.type === "tool";
  }
  return (
    event.type === "permission.asked" ||
    event.type === "permission.replied" ||
    event.type === "question.asked" ||
    event.type === "question.replied" ||
    event.type === "question.rejected" ||
    event.type === "session.error"
  );
}

function shouldHandleSubscribedEvent(
  context: OpenCodeSessionContext,
  event: OpenCodeSubscribedEvent,
): boolean {
  const sessionId = subscribedEventSessionId(event);
  if (sessionId !== undefined) {
    return (
      sessionId === context.openCodeSessionId ||
      (context.relatedSessionIds.has(sessionId) && shouldHandleRelatedOpenCodeSessionEvent(event))
    );
  }

  return (
    context.activeTurnId !== undefined &&
    (event.type === "session.error" || event.type === "session.idle")
  );
}

type OpenCodeAssistantTokens = AssistantMessage["tokens"];

interface NormalizedOpenCodeTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

function readOpenCodeTokens(tokens: unknown): NormalizedOpenCodeTokens | undefined {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    return undefined;
  }
  const tokenRecord = tokens as Partial<OpenCodeAssistantTokens>;
  const inputTokens = nonNegativeInteger(tokenRecord.input);
  const outputTokens = nonNegativeInteger(tokenRecord.output);
  const reasoningOutputTokens = nonNegativeInteger(tokenRecord.reasoning);
  const cacheReadTokens = nonNegativeInteger(tokenRecord.cache?.read);
  const cacheWriteTokens = nonNegativeInteger(tokenRecord.cache?.write);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    reasoningOutputTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

export function normalizeOpenCodeTokenUsage(
  tokens: unknown,
  maxTokens?: number | undefined,
): ThreadTokenUsageSnapshot | undefined {
  const normalizedTokens = readOpenCodeTokens(tokens);
  if (!normalizedTokens) {
    return undefined;
  }

  const { inputTokens, outputTokens, reasoningOutputTokens, cacheReadTokens, cacheWriteTokens } =
    normalizedTokens;
  const cachedInputTokens = cacheReadTokens + cacheWriteTokens;
  const totalProcessedTokens =
    inputTokens + cachedInputTokens + outputTokens + reasoningOutputTokens;
  if (totalProcessedTokens <= 0) {
    return undefined;
  }

  const normalizedMaxTokens = positiveInteger(maxTokens);
  const usedTokens =
    normalizedMaxTokens !== undefined
      ? Math.min(totalProcessedTokens, normalizedMaxTokens)
      : totalProcessedTokens;

  return {
    usedTokens,
    totalProcessedTokens,
    ...(normalizedMaxTokens !== undefined ? { maxTokens: normalizedMaxTokens } : {}),
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    lastUsedTokens: usedTokens,
    lastInputTokens: inputTokens,
    lastCachedInputTokens: cachedInputTokens,
    lastOutputTokens: outputTokens,
    lastReasoningOutputTokens: reasoningOutputTokens,
  };
}

function buildOpenCodeTokenUsageKey(input: {
  readonly messageId: string;
  readonly tokens: OpenCodeAssistantTokens;
  readonly maxTokens?: number | undefined;
}): string | undefined {
  const normalizedTokens = readOpenCodeTokens(input.tokens);
  if (!normalizedTokens) {
    return undefined;
  }

  const { inputTokens, outputTokens, reasoningOutputTokens, cacheReadTokens, cacheWriteTokens } =
    normalizedTokens;
  return [
    input.messageId,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningOutputTokens,
    positiveInteger(input.maxTokens) ?? "",
  ].join(":");
}

function replaceModelContextLimits(
  context: OpenCodeSessionContext,
  limits: ReadonlyMap<string, number>,
): void {
  context.modelContextLimitBySlug.clear();
  for (const [slug, limit] of limits) {
    context.modelContextLimitBySlug.set(slug, limit);
  }
}

function buildOpenCodeThreadSnapshot(input: {
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<OpenCodeMessageSnapshot>;
  readonly cwd?: string | null;
}) {
  return {
    threadId: input.threadId,
    turns: input.messages.map((entry) => ({
      id: TurnId.makeUnsafe(entry.info.id),
      items: [entry],
    })),
    cwd: input.cwd ?? null,
  };
}

const stopOpenCodeContext = Effect.fn("stopOpenCodeContext")(function* (
  context: OpenCodeSessionContext,
) {
  if (yield* Ref.getAndSet(context.stopped, true)) {
    return;
  }

  yield* runOpenCodeSdk("session.abort", () =>
    context.client.session.abort({ sessionID: context.openCodeSessionId }),
  ).pipe(Effect.ignore({ log: true }));

  yield* Scope.close(context.sessionScope, Exit.void).pipe(
    Effect.ensuring(Effect.sync(() => releaseOpenCodeGatewayLease(context))),
  );
});

export function makeOpenCodeAdapterLive(options?: OpenCodeAdapterLiveOptions) {
  const adapterConfig = options?.adapterConfig ?? OPENCODE_ADAPTER_CONFIG;
  return Layer.effect(
    OpenCodeAdapter,
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const openCodeRuntime = yield* OpenCodeRuntime;
      const agentGatewayCredentials =
        Option.getOrUndefined(yield* Effect.serviceOption(AgentGatewayCredentials)) ??
        options?.agentGatewayCredentials;
      const gatewayToolBridge = yield* AgentGatewayToolBridge;
      const provider = adapterConfig.provider;
      const prepareManagedProcess = (launch: ProviderManagedLaunchContext) =>
        Effect.gen(function* () {
          if (!agentGatewayCredentials)
            return yield* new OpenCodeRuntimeError({
              operation: "agentGateway.setup",
              detail: "OpenCode requires registered Penkra gateway ownership.",
            });
          const processEnv = launch.childEnvironment(process.env);
          const configContent = yield* Effect.tryPromise({
            try: async () => {
              const pluginPath = await (
                options?.prepareGatewayPlugin ?? ensureOpenCodeGatewayPlugin
              )(launch.profileRoot, gatewayToolBridge.requireSurface().definitions);
              const config = JSON.parse(
                await (options?.loadSharedMcpConfig ?? loadOpenCodeConfigContent)(
                  serverConfig.homeDir,
                ),
              ) as Record<string, unknown>;
              if (!config || typeof config !== "object" || Array.isArray(config))
                throw new Error("OpenCode configuration must be an object.");
              const plugins = config.plugin ?? [];
              if (!Array.isArray(plugins) || !plugins.every((plugin) => typeof plugin === "string"))
                throw new Error("OpenCode plugin configuration must contain file paths.");
              return JSON.stringify({ ...config, plugin: [...plugins, pluginPath] });
            },
            catch: (cause) =>
              new OpenCodeRuntimeError({
                operation: "agentGateway.setup",
                detail: "Could not prepare native gateway declarations.",
                cause,
              }),
          });
          processEnv.OPENCODE_CONFIG_CONTENT = configContent;
          return {
            processEnv,
            assertCurrentCredentials: launch.assertCurrentCredentials,
            gateway: {
              url: agentGatewayCredentials.mcpEndpointUrl,
              issue: () => agentGatewayCredentials.processes.issue(provider),
              revoke: agentGatewayCredentials.processes.revoke,
            },
          };
        });
      const buildEventBase = (
        input: Omit<
          Parameters<typeof buildProviderEventBase>[0],
          "provider" | "runtimeEventSource"
        >,
      ) =>
        buildProviderEventBase({
          provider,
          runtimeEventSource: adapterConfig.runtimeEventSource,
          ...input,
        });
      const toAdapterRequestError = (cause: OpenCodeRuntimeError) =>
        toRequestError(provider, cause);
      const toAdapterProcessError = (threadId: ThreadId, cause: unknown) =>
        toProcessError(provider, threadId, cause);
      const ensureAdapterSessionContext = (threadId: ThreadId) =>
        ensureSessionContext(provider, sessions, threadId);
      const nativeEventLogger =
        options?.nativeEventLogger ??
        (options?.nativeEventLogPath !== undefined
          ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
              stream: "native",
            })
          : undefined);
      const managedNativeEventLogger =
        options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
      const runtimeEvents = yield* Queue.bounded<ProviderRuntimeEvent>(
        PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
      );
      const sessions = new Map<ThreadId, OpenCodeSessionContext>();

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const contexts = [...sessions.values()];
          sessions.clear();
          yield* Effect.forEach(
            contexts,
            (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
            { concurrency: "unbounded", discard: true },
          );
          if (managedNativeEventLogger !== undefined) {
            yield* managedNativeEventLogger.close();
          }
        }),
      );

      const emit = (context: OpenCodeSessionContext, event: ProviderRuntimeEvent) => {
        const settled = context.turnSettled;
        return Effect.sync(() => {
          if (event.providerRefs?.providerParentThreadId !== undefined) return;
          if (
            (event.type === "turn.completed" || event.type === "turn.aborted") &&
            event.turnId !== undefined
          ) {
            agentGatewayCredentials?.endTurn(
              context.session.threadId,
              provider,
              String(event.turnId),
              context.lifecycleGeneration,
            );
          } else if (event.type === "session.exited") {
            agentGatewayCredentials?.endSession(
              context.session.threadId,
              provider,
              context.lifecycleGeneration,
            );
          }
        }).pipe(
          Effect.andThen(
            Queue.offer(runtimeEvents, {
              ...event,
              ...(context.lifecycleGeneration !== undefined
                ? { lifecycleGeneration: context.lifecycleGeneration }
                : {}),
            }),
          ),
          Effect.tap(() =>
            Effect.sync(() => {
              if (settled === undefined) return;
              if (event.type === "session.exited") {
                Deferred.doneUnsafe(
                  settled,
                  Effect.fail(
                    new ProviderAdapterRequestError({
                      provider,
                      method: "interruptTurn",
                      detail: event.payload.reason ?? "Session exited before becoming idle.",
                    }),
                  ),
                );
              } else if (
                (event.type === "turn.completed" || event.type === "turn.aborted") &&
                event.turnId !== undefined
              ) {
                Deferred.doneUnsafe(settled, Effect.void);
              }
            }),
          ),
          Effect.asVoid,
        );
      };
      const writeNativeEvent = (
        threadId: ThreadId,
        event: {
          readonly observedAt: string;
          readonly event: Record<string, unknown>;
        },
      ) => (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void);
      const writeNativeEventBestEffort = (
        threadId: ThreadId,
        event: {
          readonly observedAt: string;
          readonly event: Record<string, unknown>;
        },
      ) => writeNativeEvent(threadId, event).pipe(Effect.catchCause(() => Effect.void));

      const emitContextCompactionProgress = Effect.fn("emitContextCompactionProgress")(function* (
        context: OpenCodeSessionContext,
        input: {
          readonly turnId?: TurnId | undefined;
          readonly detail?: string | undefined;
          readonly raw?: unknown;
          readonly data?: unknown;
        },
      ) {
        yield* emit(context, {
          ...buildEventBase({
            threadId: context.session.threadId,
            turnId: input.turnId,
            raw: input.raw,
          }),
          type: "item.updated",
          payload: {
            itemType: "context_compaction",
            status: "inProgress",
            detail: input.detail ?? "Compacting context",
            ...(input.data !== undefined ? { data: input.data } : {}),
          },
        });
      });

      const emitContextCompacted = Effect.fn("emitContextCompacted")(function* (
        context: OpenCodeSessionContext,
        input: {
          readonly turnId?: TurnId | undefined;
          readonly raw?: unknown;
        },
      ) {
        updateProviderSession(
          context,
          {
            status: context.activeTurnId ? "running" : "ready",
          },
          { clearLastError: true },
        );
        yield* emit(context, {
          ...buildEventBase({
            threadId: context.session.threadId,
            turnId: input.turnId,
            raw: input.raw,
          }),
          type: "thread.state.changed",
          payload: {
            state: "compacted",
            detail: { source: provider },
          },
        });
      });

      const emitUnexpectedExit = Effect.fn("emitUnexpectedExit")(function* (
        context: OpenCodeSessionContext,
        message: string,
      ) {
        if (yield* Ref.getAndSet(context.stopped, true)) {
          return;
        }
        agentGatewayCredentials?.endSession(
          context.session.threadId,
          provider,
          context.lifecycleGeneration,
        );
        const turnId = context.activeTurnId;
        sessions.delete(context.session.threadId);
        yield* emit(context, {
          ...buildEventBase({ threadId: context.session.threadId, turnId }),
          type: "runtime.error",
          payload: {
            message,
            terminal: true,
            class: "transport_error",
          },
        }).pipe(Effect.ignore);
        yield* emit(context, {
          ...buildEventBase({ threadId: context.session.threadId, turnId }),
          type: "session.exited",
          payload: {
            reason: message,
            recoverable: false,
            exitKind: "error",
          },
        }).pipe(Effect.ignore);
        yield* runOpenCodeSdk("session.abort", () =>
          context.client.session.abort({
            sessionID: context.openCodeSessionId,
          }),
        ).pipe(Effect.ignore({ log: true }));
        yield* Scope.close(context.sessionScope, Exit.void).pipe(
          Effect.ensuring(Effect.sync(() => releaseOpenCodeGatewayLease(context))),
        );
      });

      const emitAssistantTextDelta = Effect.fn("emitAssistantTextDelta")(function* (
        context: OpenCodeSessionContext,
        part: Part,
        turnId: TurnId | undefined,
        raw: unknown,
      ) {
        const text = textFromPart(part);
        if (text === undefined) {
          return;
        }
        const nextTextItemId =
          turnId && part.type === "text" ? openCodeNextTextItemId(turnId) : undefined;
        const itemId =
          nextTextItemId && context.emittedTextByPartId.has(nextTextItemId)
            ? nextTextItemId
            : part.id;
        const previousText = context.emittedTextByPartId.get(itemId);
        const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text, {
          authoritative: part.type === "text" && part.time?.end !== undefined,
        });
        context.emittedTextByPartId.set(itemId, latestText);
        if (itemId !== part.id) {
          context.emittedTextByPartId.set(part.id, latestText);
        }
        if (latestText !== text) {
          context.partById.set(
            part.id,
            (part.type === "text" || part.type === "reasoning"
              ? { ...part, text: latestText }
              : part) satisfies Part,
          );
        }
        if (deltaToEmit.length > 0) {
          yield* emit(context, {
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId,
              createdAt:
                part.type === "text" || part.type === "reasoning"
                  ? isoFromEpochMs(part.time?.start)
                  : undefined,
              raw,
            }),
            type: "content.delta",
            payload: {
              streamKind: resolveTextStreamKind(part),
              delta: deltaToEmit,
            },
          });
        }

        if (
          part.type === "text" &&
          part.time?.end !== undefined &&
          !context.completedAssistantPartIds.has(itemId)
        ) {
          context.completedAssistantPartIds.add(itemId);
          if (itemId !== part.id) {
            context.completedAssistantPartIds.add(part.id);
          }
          yield* emit(context, {
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId,
              createdAt: isoFromEpochMs(part.time.end),
              raw,
            }),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
              ...(latestText.length > 0 ? { detail: latestText } : {}),
            },
          });
        }
      });

      const emitRecoveredAssistantTextDelta = Effect.fn("emitRecoveredAssistantTextDelta")(
        function* (context: OpenCodeSessionContext, part: Part, turnId: TurnId, raw: unknown) {
          const text = textFromPart(part);
          const nextTextItemId = openCodeNextTextItemId(turnId);
          if (
            text === undefined ||
            part.type !== "text" ||
            !context.emittedTextByPartId.has(nextTextItemId)
          ) {
            yield* emitAssistantTextDelta(context, part, turnId, raw);
            return;
          }

          const previousText = context.emittedTextByPartId.get(nextTextItemId);
          const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text, {
            authoritative: part.time?.end !== undefined,
          });
          context.emittedTextByPartId.set(nextTextItemId, latestText);
          context.emittedTextByPartId.set(part.id, latestText);
          context.partById.set(part.id, { ...part, text: latestText });
          if (deltaToEmit.length > 0) {
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: nextTextItemId,
                createdAt: isoFromEpochMs(part.time?.start),
                raw,
              }),
              type: "content.delta",
              payload: {
                streamKind: "assistant_text",
                delta: deltaToEmit,
              },
            });
          }

          if (part.time?.end !== undefined) {
            if (context.completedAssistantPartIds.has(nextTextItemId)) {
              context.completedAssistantPartIds.add(part.id);
              return;
            }
            context.completedAssistantPartIds.add(nextTextItemId);
            context.completedAssistantPartIds.add(part.id);
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: nextTextItemId,
                createdAt: isoFromEpochMs(part.time.end),
                raw,
              }),
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                status: "completed",
                title: "Assistant message",
                ...(latestText.length > 0 ? { detail: latestText } : {}),
              },
            });
          }
        },
      );

      const completeOpenCodeTurn = Effect.fn("completeOpenCodeTurn")(function* (
        context: OpenCodeSessionContext,
        input: {
          readonly turnId: TurnId;
          readonly raw: unknown;
          readonly totalCostUsd?: number | undefined;
          readonly errorMessage?: string | undefined;
        },
      ) {
        if (context.activeTurnId !== input.turnId) {
          return false;
        }
        clearActiveTurnState(context);
        updateProviderSession(
          context,
          input.errorMessage
            ? { status: "error", lastError: input.errorMessage }
            : { status: "ready" },
          { clearActiveTurnId: true },
        );
        yield* emit(context, {
          ...buildEventBase({
            threadId: context.session.threadId,
            turnId: input.turnId,
            raw: input.raw,
          }),
          type: "turn.completed",
          payload: input.errorMessage
            ? {
                state: "failed",
                errorMessage: input.errorMessage,
              }
            : {
                state: "completed",
                ...(input.totalCostUsd !== undefined ? { totalCostUsd: input.totalCostUsd } : {}),
              },
        });
        return true;
      });

      const submitOpenCodePromptAsync = Effect.fn("submitOpenCodePromptAsync")(function* (
        context: OpenCodeSessionContext,
        input: {
          readonly turnId: TurnId;
          readonly promptInput: Parameters<OpencodeClient["session"]["promptAsync"]>[0];
        },
      ) {
        yield* runOpenCodeSdk("session.promptAsync", () =>
          context.client.session.promptAsync(input.promptInput),
        ).pipe(
          Effect.mapError(toAdapterRequestError),
          Effect.tapError((requestError) =>
            Effect.gen(function* () {
              if ((yield* Ref.get(context.stopped)) || context.activeTurnId !== input.turnId)
                return;
              clearActiveTurnState(context);
              updateProviderSession(
                context,
                { status: "ready", lastError: requestError.detail },
                { clearActiveTurnId: true },
              );
              yield* emit(context, {
                ...buildEventBase({ threadId: context.session.threadId, turnId: input.turnId }),
                type: "turn.aborted",
                payload: { reason: requestError.detail },
              });
            }),
          ),
        );
      });

      const refreshRelatedOpenCodeSessions = Effect.fn("refreshRelatedOpenCodeSessions")(function* (
        context: OpenCodeSessionContext,
      ) {
        const discovered = new Set<string>();
        const pending = [context.openCodeSessionId];
        while (pending.length > 0 && discovered.size < OPENCODE_MAX_RELATED_SESSIONS) {
          const parentSessionId = pending.shift();
          if (!parentSessionId) {
            break;
          }
          const response = yield* runOpenCodeSdk("session.children", () =>
            context.client.session.children({ sessionID: parentSessionId }),
          );
          for (const child of response.data ?? []) {
            if (
              child.id === context.openCodeSessionId ||
              discovered.has(child.id) ||
              discovered.size >= OPENCODE_MAX_RELATED_SESSIONS
            ) {
              continue;
            }
            discovered.add(child.id);
            pending.push(child.id);
          }
        }
        for (const sessionId of discovered) {
          context.relatedSessionIds.add(sessionId);
        }
      });

      const handleSubscribedEvent = Effect.fn("handleSubscribedEvent")(function* (
        context: OpenCodeSessionContext,
        event: OpenCodeSubscribedEvent,
      ) {
        if (!shouldHandleSubscribedEvent(context, event)) {
          const sessionId = subscribedEventSessionId(event);
          const canBelongToUndiscoveredChild =
            sessionId !== undefined &&
            (event.type === "permission.asked" || event.type === "question.asked");
          if (!canBelongToUndiscoveredChild) {
            return;
          }
          const refreshExit = yield* Effect.exit(refreshRelatedOpenCodeSessions(context));
          if (Exit.isFailure(refreshExit)) {
            yield* Effect.logWarning(
              `${adapterConfig.displayName} failed to reconcile child sessions`,
              Cause.squash(refreshExit.cause),
            );
          }
          if (!shouldHandleSubscribedEvent(context, event)) {
            return;
          }
        }

        const turnId = context.activeTurnId;
        yield* writeNativeEventBestEffort(context.session.threadId, {
          observedAt: nowIso(),
          event: {
            provider,
            threadId: context.session.threadId,
            providerThreadId: context.openCodeSessionId,
            type: event.type,
            ...(turnId ? { turnId } : {}),
            payload: event,
          },
        });

        switch (event.type) {
          case "message.updated": {
            const messageSnapshotKey = openCodeSnapshotKey(event.properties.info);
            if (
              context.messageSnapshotKeyById.get(event.properties.info.id) === messageSnapshotKey
            ) {
              break;
            }
            context.messageRoleById.set(event.properties.info.id, event.properties.info.role);
            context.messageSnapshotKeyById.set(event.properties.info.id, messageSnapshotKey);
            if (event.properties.info.role === "assistant") {
              const assistantMessage = event.properties.info;
              const selectedModel = context.session.model;
              const maxTokens =
                selectedModel !== undefined
                  ? context.modelContextLimitBySlug.get(selectedModel)
                  : undefined;
              const normalizedUsage = normalizeOpenCodeTokenUsage(
                assistantMessage.tokens,
                maxTokens,
              );
              const usageKey =
                normalizedUsage !== undefined
                  ? buildOpenCodeTokenUsageKey({
                      messageId: assistantMessage.id,
                      tokens: assistantMessage.tokens,
                      maxTokens,
                    })
                  : undefined;
              const cost = nonNegativeFiniteNumber(assistantMessage.cost);
              if (cost !== undefined) {
                context.latestTurnCostUsd = cost;
              }
              if (
                normalizedUsage !== undefined &&
                usageKey !== undefined &&
                usageKey !== context.lastEmittedTokenUsageKey
              ) {
                context.lastKnownTokenUsage = normalizedUsage;
                context.lastEmittedTokenUsageKey = usageKey;
                yield* emit(context, {
                  ...buildEventBase({
                    threadId: context.session.threadId,
                    turnId,
                    raw: event,
                  }),
                  type: "thread.token-usage.updated",
                  payload: {
                    usage: normalizedUsage,
                  },
                });
              }

              for (const part of context.partById.values()) {
                if (part.messageID !== event.properties.info.id) {
                  continue;
                }
                const resolvedPart = applyPendingTextDeltaToPart(context, part);
                if (resolvedPart !== part) {
                  context.partById.set(resolvedPart.id, resolvedPart);
                }
                yield* emitAssistantTextDelta(context, resolvedPart, turnId, event);
              }
            }
            break;
          }

          case "message.removed": {
            context.messageRoleById.delete(event.properties.messageID);
            context.messageSnapshotKeyById.delete(event.properties.messageID);
            break;
          }

          case "message.part.delta": {
            const delta = event.properties.delta;
            if (delta.length === 0) {
              break;
            }
            const existingPart = context.partById.get(event.properties.partID);
            if (!existingPart) {
              bufferPendingTextDelta(context, event.properties.partID, delta);
              break;
            }
            const resolvedPart = applyPendingTextDeltaToPart(context, existingPart);
            if (resolvedPart !== existingPart) {
              context.partById.set(event.properties.partID, resolvedPart);
            }
            const role = messageRoleForPart(context, resolvedPart);
            if (role !== "assistant") {
              bufferPendingTextDelta(context, event.properties.partID, delta);
              break;
            }
            if (!shouldProjectOpenCodeTextPart(resolvedPart)) {
              break;
            }
            const streamKind = resolveTextStreamKind(resolvedPart);
            const previousText =
              context.emittedTextByPartId.get(event.properties.partID) ??
              textFromPart(resolvedPart) ??
              "";
            const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(previousText, delta);
            if (deltaToEmit.length === 0) {
              break;
            }
            context.emittedTextByPartId.set(event.properties.partID, nextText);
            if (resolvedPart.type === "text" || resolvedPart.type === "reasoning") {
              const nextPart = {
                ...resolvedPart,
                text: nextText,
              } satisfies Part;
              context.partById.set(event.properties.partID, nextPart);
              context.partSnapshotKeyById.set(
                event.properties.partID,
                openCodeSnapshotKey(nextPart),
              );
            }
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.partID,
                raw: event,
              }),
              type: "content.delta",
              payload: {
                streamKind,
                delta: deltaToEmit,
              },
            });
            break;
          }

          case "message.part.updated": {
            const part = applyPendingTextDeltaToPart(context, event.properties.part);
            const partSnapshotKey = openCodeSnapshotKey(part);
            if (context.partSnapshotKeyById.get(part.id) === partSnapshotKey) {
              break;
            }
            context.partById.set(part.id, part);
            context.partSnapshotKeyById.set(part.id, partSnapshotKey);
            const messageRole = messageRoleForPart(context, part);

            if (messageRole === "assistant") {
              yield* emitAssistantTextDelta(context, part, turnId, event);
            }

            if (part.type === "tool") {
              const startTurnId =
                context.childTurnBySessionId.get(event.properties.sessionID) ??
                (part.state.status === "pending" || part.state.status === "running"
                  ? turnId
                  : undefined);
              if (!context.toolTurnById.has(part.callID) && startTurnId)
                context.toolTurnById.set(part.callID, startTurnId);
              const toolTurnId = context.toolTurnById.get(part.callID);
              rememberRelatedOpenCodeSession(context, part, toolTurnId);
              const itemType = toToolLifecycleItemType(part.tool);
              const title =
                part.state.status === "running" ? (part.state.title ?? part.tool) : part.tool;
              const detail = detailFromToolPart(part);
              const payload = {
                itemType,
                ...(part.state.status === "error"
                  ? { status: "failed" as const }
                  : part.state.status === "completed"
                    ? { status: "completed" as const }
                    : { status: "inProgress" as const }),
                ...(title ? { title } : {}),
                ...(detail ? { detail } : {}),
                ...("input" in part.state ? { input: part.state.input } : {}),
                data: {
                  tool: part.tool,
                  toolName: part.tool,
                  toolCallId: part.callID,
                  callID: part.callID,
                  ...("input" in part.state ? { input: part.state.input } : {}),
                  state: part.state,
                },
              };
              const runtimeEvent: ProviderRuntimeEvent = {
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId: toolTurnId,
                  itemId: part.callID,
                  createdAt: toolStateCreatedAt(part),
                  raw: event,
                }),
                type:
                  part.state.status === "pending"
                    ? "item.started"
                    : part.state.status === "completed" || part.state.status === "error"
                      ? "item.completed"
                      : "item.updated",
                payload,
              };
              appendTurnItem(context, toolTurnId, part);
              yield* emit(context, runtimeEvent);
            }

            if (part.type === "compaction") {
              yield* emitContextCompactionProgress(context, {
                turnId,
                raw: event,
                detail: part.overflow
                  ? "Compacting context after provider context overflow"
                  : "Compacting context",
                data: {
                  auto: part.auto,
                  ...(part.overflow !== undefined ? { overflow: part.overflow } : {}),
                  ...(part.tail_start_id ? { tailStartId: part.tail_start_id } : {}),
                },
              });
            }
            break;
          }

          case "permission.asked": {
            if (context.policyResolvedPermissionIds.has(event.properties.id)) {
              break;
            }
            const replyPermission = (policyReply: "once" | "reject") =>
              Effect.gen(function* () {
                context.policyResolvedPermissionIds.add(event.properties.id);
                const replyExit = yield* Effect.exit(
                  runOpenCodeSdk("permission.reply", () =>
                    context.client.permission.reply({
                      requestID: event.properties.id,
                      reply: policyReply,
                    }),
                  ),
                );
                if (Exit.isSuccess(replyExit)) {
                  return;
                }
                context.policyResolvedPermissionIds.delete(event.properties.id);
                const detail = openCodeRuntimeErrorDetail(Cause.squash(replyExit.cause));
                yield* Effect.logWarning(
                  `${adapterConfig.displayName} permission policy reply failed`,
                  Cause.squash(replyExit.cause),
                );
                // Full Access must never degrade into a human approval. Abort the
                // provider turn and surface an actionable failure instead.
                yield* runOpenCodeSdk("session.abort", () =>
                  context.client.session.abort({
                    sessionID: context.openCodeSessionId,
                  }),
                ).pipe(Effect.ignore({ log: true }));
                if (turnId !== undefined && context.activeTurnId === turnId) {
                  yield* completeOpenCodeTurn(context, {
                    turnId,
                    raw: event,
                    errorMessage: `${adapterConfig.displayName} could not apply ${policyReply === "reject" ? "Plan-mode" : "Full-access"} permission policy: ${detail}`,
                  });
                } else {
                  yield* emit(context, {
                    ...buildEventBase({
                      threadId: context.session.threadId,
                      raw: event,
                    }),
                    type: "runtime.warning",
                    payload: {
                      message: openCodeActionableWarningMessage(
                        OPENCODE_ACTIONABLE_WARNING_CLASSES.permissionPolicyFailure,
                        `${adapterConfig.displayName} could not apply its permission policy.`,
                      ),
                      detail,
                    },
                  });
                }
              });
            if (context.activeTurnId === undefined) {
              // A persistent OpenCode server can replay a permission after its turn ended.
              yield* replyPermission("reject");
              break;
            }
            yield* replyPermission(
              providerPermissionDecision(context.session.runtimeMode) === "accept"
                ? "once"
                : "reject",
            );
            break;
          }

          case "permission.replied": {
            context.policyResolvedPermissionIds.delete(event.properties.requestID);
            break;
          }

          case "question.asked": {
            if (context.pendingQuestions.has(event.properties.id)) {
              break;
            }
            context.pendingQuestions.set(event.properties.id, event.properties);
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                requestId: event.properties.id,
                raw: event,
              }),
              type: "user-input.requested",
              payload: {
                questions: normalizeQuestionRequest(event.properties),
              },
            });
            break;
          }

          case "question.replied": {
            const request = context.pendingQuestions.get(event.properties.requestID);
            context.pendingQuestions.delete(event.properties.requestID);
            const answers = Object.fromEntries(
              (request?.questions ?? []).map((question, index) => [
                openCodeQuestionId(index, question),
                event.properties.answers[index]?.join(", ") ?? "",
              ]),
            );
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                requestId: event.properties.requestID,
                raw: event,
              }),
              type: "user-input.resolved",
              payload: { answers },
            });
            break;
          }

          case "question.rejected": {
            context.pendingQuestions.delete(event.properties.requestID);
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                requestId: event.properties.requestID,
                raw: event,
              }),
              type: "user-input.resolved",
              payload: { answers: {} },
            });
            break;
          }

          case "todo.updated": {
            const tasksPayload = normalizeOpenCodeTodoTasks(event.properties.todos);
            if (!tasksPayload) {
              break;
            }
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              }),
              type: "turn.tasks.updated",
              payload: tasksPayload,
            });
            break;
          }

          case "session.status": {
            if (event.properties.status.type === "busy") {
              updateProviderSession(context, {
                status: "running",
                activeTurnId: turnId,
              });
            }

            if (event.properties.status.type === "retry") {
              yield* emit(context, {
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  raw: event,
                }),
                type: "runtime.warning",
                payload: {
                  message: openCodeActionableWarningMessage(
                    OPENCODE_ACTIONABLE_WARNING_CLASSES.providerRetry,
                    event.properties.status.message,
                  ),
                  detail: event.properties.status,
                },
              });
              break;
            }

            if (event.properties.status.type === "idle" && turnId) {
              if (
                context.pendingAbortErrorTurnId === turnId &&
                event.properties.sessionID === context.openCodeSessionId
              ) {
                context.pendingAbortErrorTurnId = undefined;
                clearActiveTurnState(context);
                updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
                yield* emit(context, {
                  ...buildEventBase({ threadId: context.session.threadId, turnId, raw: event }),
                  type: "turn.aborted",
                  payload: { reason: "Interrupted by user." },
                });
                break;
              }
              yield* completeOpenCodeTurn(context, {
                turnId,
                raw: event,
                totalCostUsd: context.latestTurnCostUsd,
              });
            }
            break;
          }

          case "session.idle": {
            if (turnId) {
              if (
                context.pendingAbortErrorTurnId === turnId &&
                event.properties.sessionID === context.openCodeSessionId
              ) {
                context.pendingAbortErrorTurnId = undefined;
                clearActiveTurnState(context);
                updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
                yield* emit(context, {
                  ...buildEventBase({ threadId: context.session.threadId, turnId, raw: event }),
                  type: "turn.aborted",
                  payload: { reason: "Interrupted by user." },
                });
                break;
              }
              yield* completeOpenCodeTurn(context, {
                turnId,
                raw: event,
                totalCostUsd: context.latestTurnCostUsd,
              });
            }
            break;
          }

          // Newer OpenCode servers can emit session.next.* events for the active
          // agent loop. Mirror them into Penkra's canonical transcript stream.
          case "session.next.text.delta": {
            if (!turnId || event.properties.delta.length === 0) {
              break;
            }
            const itemId = openCodeNextTextItemId(turnId);
            const previousText = context.emittedTextByPartId.get(itemId) ?? "";
            const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(
              previousText,
              event.properties.delta,
            );
            if (deltaToEmit.length === 0) {
              break;
            }
            context.emittedTextByPartId.set(itemId, nextText);
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: "content.delta",
              payload: {
                streamKind: "assistant_text",
                delta: deltaToEmit,
              },
            });
            break;
          }

          case "session.next.text.ended": {
            if (!turnId) {
              break;
            }
            const itemId = openCodeNextTextItemId(turnId);
            const text = event.properties.text;
            const previousText = context.emittedTextByPartId.get(itemId) ?? "";
            const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text);
            context.emittedTextByPartId.set(itemId, latestText);
            if (deltaToEmit.length > 0) {
              yield* emit(context, {
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId,
                  createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                  raw: event,
                }),
                type: "content.delta",
                payload: {
                  streamKind: "assistant_text",
                  delta: deltaToEmit,
                },
              });
            }
            if (!context.completedAssistantPartIds.has(itemId)) {
              context.completedAssistantPartIds.add(itemId);
              yield* emit(context, {
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId,
                  createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                  raw: event,
                }),
                type: "item.completed",
                payload: {
                  itemType: "assistant_message",
                  status: "completed",
                  title: "Assistant message",
                  ...(latestText.length > 0 ? { detail: latestText } : {}),
                },
              });
            }
            break;
          }

          case "session.next.reasoning.delta": {
            if (!turnId || event.properties.delta.length === 0) {
              break;
            }
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.reasoningID,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: "content.delta",
              payload: {
                streamKind: "reasoning_text",
                delta: event.properties.delta,
              },
            });
            break;
          }

          case "session.next.reasoning.ended": {
            if (!turnId) {
              break;
            }
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.reasoningID,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: "item.completed",
              payload: {
                itemType: "reasoning",
                status: "completed",
                title: "Reasoning",
                ...(event.properties.text ? { detail: event.properties.text } : {}),
              },
            });
            break;
          }

          case "session.next.shell.started": {
            if (!turnId) {
              break;
            }
            context.toolTurnById.set(event.properties.callID, turnId);
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.callID,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: "item.started",
              payload: {
                itemType: "command_execution",
                status: "inProgress",
                title: "Ran command",
                detail: event.properties.command,
                data: {
                  tool: "shell",
                  toolName: "shell",
                  toolCallId: event.properties.callID,
                  callID: event.properties.callID,
                  command: event.properties.command,
                  sessionID: event.properties.sessionID,
                },
              },
            });
            break;
          }

          case "session.next.shell.ended": {
            const turnId = context.toolTurnById.get(event.properties.callID);
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.callID,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: "item.completed",
              payload: {
                itemType: "command_execution",
                status: "completed",
                title: "Ran command",
                ...(event.properties.output ? { detail: event.properties.output } : {}),
                data: {
                  tool: "shell",
                  toolName: "shell",
                  toolCallId: event.properties.callID,
                  callID: event.properties.callID,
                  output: event.properties.output,
                  sessionID: event.properties.sessionID,
                },
              },
            });
            break;
          }

          case "session.next.tool.called": {
            if (!turnId) {
              break;
            }
            context.toolTurnById.set(event.properties.callID, turnId);
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.callID,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: "item.started",
              payload: {
                itemType: toToolLifecycleItemType(event.properties.tool),
                status: "inProgress",
                title: event.properties.tool,
                data: {
                  tool: event.properties.tool,
                  toolName: event.properties.tool,
                  toolCallId: event.properties.callID,
                  callID: event.properties.callID,
                  input: event.properties.input,
                  provider: event.properties.provider,
                },
              },
            });
            break;
          }

          case "session.next.tool.progress":
          case "session.next.tool.success": {
            const turnId = context.toolTurnById.get(event.properties.callID);
            const detail = openCodeToolContentText(event.properties.content);
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.callID,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: event.type === "session.next.tool.success" ? "item.completed" : "item.updated",
              payload: {
                itemType: "dynamic_tool_call",
                status: event.type === "session.next.tool.success" ? "completed" : "inProgress",
                ...(detail ? { detail } : {}),
                data: {
                  toolCallId: event.properties.callID,
                  callID: event.properties.callID,
                  structured: event.properties.structured,
                  content: event.properties.content,
                  ...("provider" in event.properties
                    ? { provider: event.properties.provider }
                    : {}),
                },
              },
            });
            break;
          }

          case "session.next.tool.failed": {
            const turnId = context.toolTurnById.get(event.properties.callID);
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.callID,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: "item.completed",
              payload: {
                itemType: "dynamic_tool_call",
                status: "failed",
                detail: event.properties.error.message,
                data: {
                  toolCallId: event.properties.callID,
                  callID: event.properties.callID,
                  error: event.properties.error,
                  provider: event.properties.provider,
                },
              },
            });
            break;
          }

          case "session.next.step.ended": {
            if (!turnId) {
              break;
            }
            const selectedModel = context.session.model;
            const maxTokens =
              selectedModel !== undefined
                ? context.modelContextLimitBySlug.get(selectedModel)
                : undefined;
            const normalizedUsage = normalizeOpenCodeTokenUsage(event.properties.tokens, maxTokens);
            if (normalizedUsage !== undefined) {
              context.lastKnownTokenUsage = normalizedUsage;
              yield* emit(context, {
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                  raw: event,
                }),
                type: "thread.token-usage.updated",
                payload: {
                  usage: normalizedUsage,
                },
              });
            }
            context.latestTurnCostUsd = nonNegativeFiniteNumber(event.properties.cost);
            if (isOpenCodeTerminalStepFinish(event.properties.finish)) {
              yield* completeOpenCodeTurn(context, {
                turnId,
                raw: event,
                totalCostUsd: context.latestTurnCostUsd,
              });
            }
            break;
          }

          case "session.next.step.failed": {
            const message = event.properties.error.message || "OpenCode session failed.";
            if (turnId) {
              yield* completeOpenCodeTurn(context, {
                turnId,
                raw: event,
                errorMessage: message,
              });
            } else {
              updateProviderSession(
                context,
                {
                  status: "error",
                  lastError: message,
                },
                { clearActiveTurnId: true },
              );
            }
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                raw: event,
              }),
              type: "runtime.error",
              payload: {
                message,
                terminal: true,
                class: "provider_error",
                detail: event.properties.error,
              },
            });
            break;
          }

          case "session.next.retried": {
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: "runtime.warning",
              payload: {
                message: openCodeActionableWarningMessage(
                  OPENCODE_ACTIONABLE_WARNING_CLASSES.providerRetry,
                  event.properties.error.message,
                ),
                detail: event.properties,
              },
            });
            break;
          }

          case "session.compacted": {
            yield* emitContextCompacted(context, { turnId, raw: event });
            break;
          }

          case "session.error": {
            const message = sessionErrorMessage(event.properties.error);
            if (isOpenCodeContextOverflowError(event.properties.error)) {
              updateProviderSession(
                context,
                {
                  status: "running",
                },
                { clearLastError: true },
              );
              yield* emitContextCompactionProgress(context, {
                turnId,
                raw: event,
                detail: message,
                data: {
                  state: "context_overflow",
                },
              });
              break;
            }
            const expectedAbortTurnId = context.pendingAbortErrorTurnId;
            if (
              expectedAbortTurnId !== undefined &&
              context.activeTurnId === expectedAbortTurnId &&
              event.properties.sessionID === context.openCodeSessionId &&
              event.properties.error?.name === "MessageAbortedError"
            ) {
              // OpenCode reports a user-requested session.abort as a session
              // error before the abort RPC has actually finished. Suppress the
              // echo here, but let interruptTurn publish the terminal event
              // only after that RPC resolves. Publishing it early lets the
              // queued steering replacement race the still-aborting session,
              // and OpenCode then rejects the new prompt as interrupted too.
              break;
            }
            const activeTurnId = context.activeTurnId;
            clearActiveTurnState(context);
            updateProviderSession(
              context,
              {
                status: "error",
                lastError: message,
              },
              { clearActiveTurnId: true },
            );
            if (activeTurnId) {
              yield* emit(context, {
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId: activeTurnId,
                  raw: event,
                }),
                type: "turn.completed",
                payload: {
                  state: "failed",
                  errorMessage: message,
                },
              });
            }
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                raw: event,
              }),
              type: "runtime.error",
              payload: {
                message,
                terminal: true,
                class: "provider_error",
                detail: event.properties.error,
              },
            });
            break;
          }

          default:
            yield* Effect.logDebug(`${adapterConfig.displayName} ignored SDK event`, {
              threadId: context.session.threadId,
              eventType:
                typeof (event as { readonly type?: unknown }).type === "string"
                  ? (event as { readonly type: string }).type
                  : "unknown",
              event,
            });
            break;
        }
      });

      const reconcilePendingOpenCodeInteractions = Effect.fn(
        "reconcilePendingOpenCodeInteractions",
      )(function* (context: OpenCodeSessionContext) {
        yield* refreshRelatedOpenCodeSessions(context).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `${adapterConfig.displayName} pending child-session reconciliation failed`,
              Cause.squash(cause),
            ),
          ),
        );
        const [permissions, questions] = yield* Effect.all([
          runOpenCodeSdk("permission.list", () => context.client.permission.list()).pipe(
            Effect.map((response) => response.data ?? []),
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `${adapterConfig.displayName} pending permission reconciliation failed`,
                Cause.squash(cause),
              ).pipe(Effect.as([] as ReadonlyArray<PermissionRequest>)),
            ),
          ),
          runOpenCodeSdk("question.list", () => context.client.question.list()).pipe(
            Effect.map((response) => response.data ?? []),
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `${adapterConfig.displayName} pending question reconciliation failed`,
                Cause.squash(cause),
              ).pipe(Effect.as([] as ReadonlyArray<QuestionRequest>)),
            ),
          ),
        ]);
        const belongsToSessionTree = (sessionId: string) =>
          sessionId === context.openCodeSessionId || context.relatedSessionIds.has(sessionId);

        for (const request of permissions) {
          if (!belongsToSessionTree(request.sessionID)) {
            continue;
          }
          yield* handleSubscribedEvent(context, {
            type: "permission.asked",
            properties: request,
          } as OpenCodeSubscribedEvent);
        }
        for (const request of questions) {
          if (!belongsToSessionTree(request.sessionID)) {
            continue;
          }
          yield* handleSubscribedEvent(context, {
            type: "question.asked",
            properties: request,
          } as OpenCodeSubscribedEvent);
        }
      });

      const startEventPump = Effect.fn("startEventPump")(function* (
        context: OpenCodeSessionContext,
      ) {
        const eventsAbortController = new AbortController();
        yield* Scope.addFinalizer(
          context.sessionScope,
          Effect.sync(() => eventsAbortController.abort()),
        );

        yield* Effect.gen(function* () {
          const subscriptionExit = yield* Effect.exit(
            Effect.gen(function* () {
              const subscription = yield* runOpenCodeSdk("event.subscribe", () =>
                context.client.event.subscribe(undefined, {
                  signal: eventsAbortController.signal,
                }),
              );
              yield* reconcilePendingOpenCodeInteractions(context).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(
                    `${adapterConfig.displayName} pending interaction reconciliation failed`,
                    Cause.squash(cause),
                  ),
                ),
              );
              yield* Stream.fromAsyncIterable(
                subscription.stream,
                (cause) =>
                  new OpenCodeRuntimeError({
                    operation: "event.subscribe",
                    detail: openCodeRuntimeErrorDetail(cause),
                    cause,
                  }),
              ).pipe(Stream.runForEach((event) => handleSubscribedEvent(context, event)));
            }),
          );
          if (eventsAbortController.signal.aborted || (yield* Ref.get(context.stopped))) return;
          const detail = Exit.isFailure(subscriptionExit)
            ? openCodeRuntimeErrorDetail(Cause.squash(subscriptionExit.cause))
            : `${adapterConfig.displayName} event stream ended.`;
          yield* emitUnexpectedExit(context, `${detail} Retry the connection to continue.`);
        }).pipe(Effect.forkIn(context.sessionScope));

        if (!context.server.external && context.server.exitCode !== null) {
          yield* context.server.exitCode.pipe(
            Effect.flatMap((code) =>
              Effect.gen(function* () {
                if (yield* Ref.get(context.stopped)) {
                  return;
                }
                yield* emitUnexpectedExit(
                  context,
                  `${adapterConfig.displayName} server exited unexpectedly (${code}).`,
                );
              }),
            ),
            Effect.forkIn(context.sessionScope),
          );
        }
      });

      const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn("startSession")(
        function* (input) {
          const launch = input.managedLaunch;
          if (!launch)
            return yield* Effect.fail(
              new ProviderAdapterValidationError({
                provider,
                operation: "startSession",
                issue: "OpenCode session start requires a resolved managed launch.",
              }),
            );
          const binaryPath = launch.binaryPath;
          const experimentalWebSockets =
            adapterConfig.providerOptionsKey === "opencode"
              ? input.providerOptions?.opencode?.experimentalWebSockets
              : undefined;
          const resumeDirectory = extractResumeCwd(input.resumeCursor);
          const directory = input.cwd ?? resumeDirectory ?? serverConfig.cwd;
          const initialParsedModel =
            input.modelSelection?.provider === adapterConfig.provider
              ? parseOpenCodeModelSlug(input.modelSelection.model)
              : null;
          const initialAgent =
            input.modelSelection?.provider === adapterConfig.provider
              ? input.modelSelection.options?.agent
              : undefined;
          const initialVariant =
            input.modelSelection?.provider === adapterConfig.provider
              ? input.modelSelection.options?.variant
              : undefined;
          const existing = sessions.get(input.threadId);
          if (existing) {
            yield* stopOpenCodeContext(existing);
            sessions.delete(input.threadId);
          }

          const resumedSessionId = extractResumeSessionId(input.resumeCursor);
          const prepared = yield* prepareManagedProcess(launch).pipe(
            Effect.mapError((cause) => toAdapterProcessError(input.threadId, cause)),
          );
          const agentGatewaySessionLease = acquireAgentGatewaySessionLease(
            agentGatewayCredentials,
            input.threadId,
            provider,
            input.lifecycleGeneration,
          );
          if (!agentGatewaySessionLease) {
            return yield* Effect.fail(
              toAdapterProcessError(
                input.threadId,
                new OpenCodeRuntimeError({
                  operation: "agentGateway.setup",
                  detail: "The native session requires registered Penkra gateway ownership.",
                }),
              ),
            );
          }
          const poolIsolationKey = launch.isolationKey;

          let sessionScopeTransferred = false;
          const installed = yield* Effect.acquireUseRelease(
            Scope.make(),
            (sessionScope) =>
              Effect.gen(function* () {
                const startedExit = yield* Effect.exit(
                  Effect.gen(function* () {
                    const server = yield* openCodeRuntime.connectToOpenCodeServer({
                      binaryPath,
                      cliSpec: adapterConfig.cliSpec,
                      cwd: directory,
                      ...(provider === "opencode" && experimentalWebSockets
                        ? { experimentalWebSockets: true }
                        : {}),
                      poolIsolationKey,
                      ...(launch.connectionId ? { connectionId: launch.connectionId } : {}),
                      ...prepared,
                    });
                    const client = openCodeRuntime.createOpenCodeSdkClient({
                      baseUrl: server.url,
                      directory,
                      cliSpec: adapterConfig.cliSpec,
                    });
                    if (server.gatewayProcessToken === undefined)
                      return yield* new OpenCodeRuntimeError({
                        operation: "agentGateway.setup",
                        detail: "The native server has no registered gateway process.",
                      });
                    const createSessionId = resumedSessionId
                      ? runOpenCodeSdk("session.update", () =>
                          client.session.update({
                            sessionID: resumedSessionId,
                            permission: buildOpenCodePermissionRules(input.runtimeMode),
                          }),
                        ).pipe(
                          Effect.tapError(() =>
                            runOpenCodeSdk("session.abort", () =>
                              client.session.abort({
                                sessionID: resumedSessionId,
                              }),
                            ).pipe(Effect.ignore({ log: true })),
                          ),
                          Effect.as(resumedSessionId),
                        )
                      : runOpenCodeSdk("session.create", () => {
                          const sessionCreateInput = {
                            ...(initialParsedModel
                              ? {
                                  model: {
                                    providerID: initialParsedModel.providerID,
                                    id: initialParsedModel.modelID,
                                    ...(initialVariant ? { variant: initialVariant } : {}),
                                  },
                                }
                              : {}),
                            ...(initialAgent ? { agent: initialAgent } : {}),
                            permission: buildOpenCodePermissionRules(input.runtimeMode),
                            title: `Penkra ${input.threadId}`,
                          };
                          return client.session.create(
                            sessionCreateInput as unknown as Parameters<
                              typeof client.session.create
                            >[0],
                          );
                        }).pipe(
                          Effect.flatMap((sessionResult) =>
                            sessionResult.data?.id
                              ? Effect.succeed(sessionResult.data.id)
                              : Effect.fail(
                                  new OpenCodeRuntimeError({
                                    operation: "session.create",
                                    detail: `${adapterConfig.displayName} session.create returned no session payload.`,
                                  }),
                                ),
                          ),
                        );
                    const loadModelContextLimits = openCodeRuntime
                      .loadOpenCodeProviderList(client)
                      .pipe(
                        Effect.map((providerList) =>
                          buildOpenCodeModelContextLimitMap({ providerList }),
                        ),
                        Effect.catchCause(() => Effect.succeed(new Map<string, number>())),
                      );
                    // Session creation and metadata discovery are independent once the server is up.
                    const [openCodeSessionId, modelContextLimitBySlug] = yield* Effect.all(
                      [createSessionId, loadModelContextLimits],
                      { concurrency: "unbounded" },
                    );
                    const unregister = yield* Effect.sync(() =>
                      agentGatewayCredentials!.processes.register(
                        server.gatewayProcessToken!,
                        openCodeSessionId,
                        agentGatewaySessionLease.connection.bearerToken,
                      ),
                    );
                    yield* Scope.addFinalizer(sessionScope, Effect.sync(unregister));

                    return {
                      sessionScope,
                      server,
                      client,
                      openCodeSessionId,
                      modelContextLimitBySlug,
                    };
                  }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
                );
                if (Exit.isFailure(startedExit)) {
                  return yield* toAdapterProcessError(
                    input.threadId,
                    Cause.squash(startedExit.cause),
                  );
                }

                const started = startedExit.value;
                if (options?.beforeSessionInstall) {
                  yield* options.beforeSessionInstall;
                }

                const raceWinner = sessions.get(input.threadId);
                if (raceWinner) {
                  yield* runOpenCodeSdk("session.abort", () =>
                    started.client.session.abort({
                      sessionID: started.openCodeSessionId,
                    }),
                  ).pipe(Effect.ignore);
                  return {
                    kind: "race-winner" as const,
                    session: raceWinner.session,
                  };
                }

                const createdAt = nowIso();
                const session: ProviderSession = {
                  provider,
                  status: "ready",
                  runtimeMode: input.runtimeMode,
                  cwd: directory,
                  ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
                  threadId: input.threadId,
                  resumeCursor: {
                    openCodeSessionId: started.openCodeSessionId,
                    cwd: directory,
                  },
                  createdAt,
                  updatedAt: createdAt,
                };

                const context: OpenCodeSessionContext = {
                  connectionId: launch.connectionId ?? null,
                  session,
                  gatewaySessionLease: agentGatewaySessionLease,
                  ...(input.lifecycleGeneration !== undefined
                    ? { lifecycleGeneration: input.lifecycleGeneration }
                    : {}),
                  client: started.client,
                  server: started.server,
                  directory,
                  openCodeSessionId: started.openCodeSessionId,
                  policyResolvedPermissionIds: new Set(),
                  pendingQuestions: new Map(),
                  pendingTextDeltasByPartId: new Map(),
                  partById: new Map(),
                  toolTurnById: new Map(),
                  childTurnBySessionId: new Map(),
                  partSnapshotKeyById: new Map(),
                  emittedTextByPartId: new Map(),
                  messageRoleById: new Map(),
                  messageSnapshotKeyById: new Map(),
                  completedAssistantPartIds: new Set(),
                  relatedSessionIds: new Set(),
                  turns: [],
                  modelContextLimitBySlug: started.modelContextLimitBySlug,
                  lastKnownTokenUsage: undefined,
                  lastEmittedTokenUsageKey: undefined,
                  latestTurnCostUsd: undefined,
                  activeTurnId: undefined,
                  turnSettled: undefined,
                  pendingAbortErrorTurnId: undefined,
                  activeAgent: undefined,
                  activeVariant: undefined,
                  stopped: yield* Ref.make(false),
                  sessionScope: started.sessionScope,
                };
                if (resumedSessionId) {
                  const existingMessages = yield* runOpenCodeSdk("session.messages", () =>
                    started.client.session.messages({
                      sessionID: started.openCodeSessionId,
                    }),
                  ).pipe(Effect.mapError(toAdapterRequestError));
                  for (const snapshot of openCodeMessageSnapshotsFromResponse(
                    existingMessages.data ?? [],
                  )) {
                    rememberOpenCodeMessageSnapshot(context, snapshot);
                  }
                }
                sessions.set(input.threadId, context);
                sessionScopeTransferred = true;
                return {
                  kind: "installed" as const,
                  session,
                  context,
                };
              }),
            (sessionScope) =>
              sessionScopeTransferred
                ? Effect.void
                : Scope.close(sessionScope, Exit.void).pipe(
                    Effect.ignore,
                    Effect.ensuring(Effect.sync(() => agentGatewaySessionLease?.release())),
                  ),
          );

          if (installed.kind === "race-winner") {
            return installed.session;
          }

          const { context, session } = installed;
          yield* startEventPump(context);

          yield* emit(context, {
            ...buildEventBase({ threadId: input.threadId }),
            type: "session.started",
            payload: {
              message: resumedSessionId
                ? `${adapterConfig.displayName} session resumed`
                : `${adapterConfig.displayName} session started`,
              resume: { openCodeSessionId: context.openCodeSessionId },
            },
          });
          yield* emit(context, {
            ...buildEventBase({ threadId: input.threadId }),
            type: "thread.started",
            payload: {
              providerThreadId: context.openCodeSessionId,
            },
          });

          return session;
        },
      );

      const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
        const context = ensureAdapterSessionContext(input.threadId);
        const turnId = TurnId.makeUnsafe(`${adapterConfig.turnIdPrefix}-${randomUUID()}`);
        const modelSelection =
          input.modelSelection ??
          (context.session.model ? { provider, model: context.session.model } : undefined);
        const parsedModel = parseOpenCodeModelSlug(modelSelection?.model);
        if (!parsedModel) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "sendTurn",
            issue: `${adapterConfig.displayName} model selection must use the 'provider/model' format.`,
          });
        }

        const baseText = input.input?.trim() ?? "";
        const text =
          appendFileAttachmentsPromptBlock({
            text: baseText,
            attachments: input.attachments,
            attachmentsDir: serverConfig.attachmentsDir,
            include: "all-files",
          })?.trim() ?? "";
        const fileParts = toOpenCodeFileParts({
          attachments: input.attachments,
          resolveAttachmentPath: (attachment) =>
            resolveProviderAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            }),
        });
        if ((!text || text.length === 0) && fileParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "sendTurn",
            issue: `${adapterConfig.displayName} turns require text input or at least one attachment.`,
          });
        }
        const hostPolicy = takePenkraHostPolicyForSession(context);
        const providerText = [hostPolicy, text].filter(Boolean).join("\n\n");

        const requestedAgent =
          input.modelSelection?.provider === provider
            ? input.modelSelection.options?.agent
            : undefined;
        const variant =
          input.modelSelection?.provider === provider
            ? input.modelSelection.options?.variant
            : undefined;

        context.turnSettled = yield* Deferred.make<void, ProviderAdapterRequestError>();
        context.activeTurnId = turnId;
        // Penkra has one execution mode. A stale provider option that requests
        // OpenCode's read-only agent is normalized to the primary agent.
        context.activeAgent =
          requestedAgent === adapterConfig.planAgent
            ? adapterConfig.defaultAgent
            : (requestedAgent ?? adapterConfig.defaultAgent);
        context.activeVariant = variant;
        updateProviderSession(
          context,
          {
            status: "running",
            activeTurnId: turnId,
            model: modelSelection?.model ?? context.session.model,
          },
          { clearLastError: true },
        );

        yield* emit(context, {
          ...buildEventBase({ threadId: input.threadId, turnId }),
          type: "turn.started",
          payload: {
            model: modelSelection?.model ?? context.session.model,
            ...(variant ? { effort: variant } : {}),
          },
        });

        const providerMessageId = `msg_${randomUUID()}`;
        // promptAsync can run tools as soon as it is called. Register the
        // execution before giving the prompt to OpenCode.
        agentGatewayCredentials?.beginTurn(
          input.threadId,
          provider,
          String(turnId),
          context.lifecycleGeneration,
        );
        yield* submitOpenCodePromptAsync(context, {
          turnId,
          promptInput: {
            sessionID: context.openCodeSessionId,
            messageID: providerMessageId,
            model: parsedModel,
            ...(context.activeAgent ? { agent: context.activeAgent } : {}),
            ...(context.activeVariant ? { variant: context.activeVariant } : {}),
            // 0.14.4: subagents are disabled; agents use `penkra threads` instead.
            tools: { task: false },
            parts: [
              ...(providerText ? [{ type: "text" as const, text: providerText }] : []),
              ...fileParts,
            ],
          },
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? Effect.sync(() =>
                  agentGatewayCredentials?.endTurn(
                    input.threadId,
                    provider,
                    String(turnId),
                    context.lifecycleGeneration,
                  ),
                )
              : Effect.void,
          ),
        );

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: {
            openCodeSessionId: context.openCodeSessionId,
            cwd: context.directory,
          },
        };
      });

      const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
        function* (threadId, turnId) {
          const context = ensureAdapterSessionContext(threadId);
          const activeTurnId = turnId ?? context.activeTurnId;
          const settled = context.turnSettled;
          context.pendingAbortErrorTurnId = activeTurnId;
          yield* runOpenCodeSdk("session.abort", () =>
            context.client.session.abort({
              sessionID: context.openCodeSessionId,
            }),
          ).pipe(
            Effect.mapError(toAdapterRequestError),
            Effect.tapError(() =>
              Effect.sync(() => {
                if (context.pendingAbortErrorTurnId === activeTurnId) {
                  context.pendingAbortErrorTurnId = undefined;
                }
              }),
            ),
          );
          // The abort RPC is an acknowledgement; native idle settles the turn.
          if (activeTurnId && settled !== undefined) yield* Deferred.await(settled);
        },
      );

      const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = Effect.fn(
        "respondToUserInput",
      )(function* (threadId, requestId, answers) {
        const context = ensureAdapterSessionContext(threadId);
        const request = context.pendingQuestions.get(requestId);
        if (!request) {
          return yield* new ProviderAdapterRequestError({
            provider,
            method: "question.reply",
            code: PENDING_INTERACTION_NOT_FOUND_FAILURE_CODE,
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }

        yield* runOpenCodeSdk("question.reply", () =>
          context.client.question.reply({
            requestID: requestId,
            answers: toOpenCodeQuestionAnswers(request, answers),
          }),
        ).pipe(Effect.mapError(toAdapterRequestError));
      });

      const stopSession: OpenCodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
        function* (threadId) {
          const context = sessions.get(threadId);
          if (!context) return;
          const wasStopped = yield* Ref.get(context.stopped);
          yield* stopOpenCodeContext(context);
          sessions.delete(threadId);
          if (!wasStopped) {
            yield* emit(context, {
              ...buildEventBase({ threadId }),
              type: "session.exited",
              payload: {
                reason: "Session stopped.",
                recoverable: false,
                exitKind: "graceful",
              },
            });
          }
        },
      );

      const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
        Effect.sync(() => [...sessions.values()].map((context) => context.session));

      const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
        Effect.sync(() => sessions.has(threadId));

      const readThread: OpenCodeAdapterShape["readThread"] = Effect.fn("readThread")(
        function* (threadId) {
          const context = ensureAdapterSessionContext(threadId);
          const messages = yield* runOpenCodeSdk("session.messages", () =>
            context.client.session.messages({
              sessionID: context.openCodeSessionId,
            }),
          ).pipe(Effect.mapError(toAdapterRequestError));

          return buildOpenCodeThreadSnapshot({
            threadId,
            messages: (messages.data ?? []).flatMap((entry) =>
              entry.info.role === "user" || entry.info.role === "assistant"
                ? [
                    {
                      info: {
                        id: entry.info.id,
                        role: entry.info.role,
                      },
                      parts: entry.parts,
                    } satisfies OpenCodeMessageSnapshot,
                  ]
                : [],
            ),
            cwd: context.directory,
          });
        },
      );

      const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
        function* (threadId, numTurns) {
          const context = ensureAdapterSessionContext(threadId);
          const messages = yield* runOpenCodeSdk("session.messages", () =>
            context.client.session.messages({
              sessionID: context.openCodeSessionId,
            }),
          ).pipe(Effect.mapError(toAdapterRequestError));

          const assistantMessages = (messages.data ?? []).filter(
            (entry) => entry.info.role === "assistant",
          );
          const targetIndex = assistantMessages.length - numTurns - 1;
          const target = targetIndex >= 0 ? assistantMessages[targetIndex] : null;
          yield* runOpenCodeSdk("session.revert", () =>
            context.client.session.revert({
              sessionID: context.openCodeSessionId,
              ...(target ? { messageID: target.info.id } : {}),
            }),
          ).pipe(Effect.mapError(toAdapterRequestError));

          return yield* readThread(threadId);
        },
      );

      const compactThread: NonNullable<OpenCodeAdapterShape["compactThread"]> = (threadId) =>
        Effect.gen(function* () {
          const context = ensureAdapterSessionContext(threadId);
          const parsedModel = parseOpenCodeModelSlug(context.session.model);
          if (!parsedModel) {
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "compactThread",
              issue: `${adapterConfig.displayName} compaction requires a current 'provider/model' selection.`,
            });
          }

          yield* runOpenCodeSdk("session.summarize", () =>
            context.client.session.summarize({
              sessionID: context.openCodeSessionId,
              providerID: parsedModel.providerID,
              modelID: parsedModel.modelID,
            }),
          ).pipe(Effect.mapError(toAdapterRequestError));
        });

      const withDiscoveryClient = <A>(
        input: { readonly cwd: string; readonly managedLaunch: ProviderManagedLaunchContext },
        fn: (input: {
          readonly client: OpencodeClient;
          readonly server: OpenCodeServerConnection;
        }) => Effect.Effect<A, ProviderAdapterRequestError>,
      ): Effect.Effect<A, ProviderAdapterRequestError> =>
        Effect.scoped(
          Effect.gen(function* () {
            const prepared = yield* prepareManagedProcess(input.managedLaunch).pipe(
              Effect.mapError(toAdapterRequestError),
            );
            const server = yield* openCodeRuntime
              .connectToOpenCodeServer({
                binaryPath: input.managedLaunch.binaryPath,
                cliSpec: adapterConfig.cliSpec,
                cwd: input.cwd,
                poolIsolationKey: input.managedLaunch.isolationKey,
                ...(input.managedLaunch.connectionId
                  ? { connectionId: input.managedLaunch.connectionId }
                  : {}),
                ...prepared,
              })
              .pipe(Effect.mapError(toAdapterRequestError));
            const client = openCodeRuntime.createOpenCodeSdkClient({
              baseUrl: server.url,
              directory: input.cwd,
              cliSpec: adapterConfig.cliSpec,
            });
            return yield* fn({ client, server });
          }),
        );

      const probeTurnEndpoint: NonNullable<OpenCodeAdapterShape["probeTurnEndpoint"]> = (input) => {
        const parsedModel = parseOpenCodeModelSlug(input.model);
        if (!parsedModel) {
          return Effect.fail(
            new ProviderAdapterRequestError({
              provider,
              method: "auth/probe",
              detail: "The selected OpenCode probe model has no provider route.",
            }),
          );
        }
        return withDiscoveryClient(
          { cwd: input.cwd, managedLaunch: input.managedLaunch },
          ({ client, server }) =>
            Effect.gen(function* () {
              if (!server.gatewayProcessToken || !agentGatewayCredentials)
                return yield* new ProviderAdapterRequestError({
                  provider,
                  method: "auth/probe",
                  detail: "The probe has no owned gateway process.",
                });
              const created = yield* runOpenCodeSdk("session.create", () =>
                client.session.create({
                  directory: input.cwd,
                  title: "Penkra connectivity probe",
                  model: {
                    providerID: parsedModel.providerID,
                    id: parsedModel.modelID,
                    ...(input.effort ? { variant: input.effort } : {}),
                  },
                  permission: [{ permission: "*", pattern: "*", action: "deny" }],
                }),
              ).pipe(Effect.mapError(toAdapterRequestError));
              const sessionID = created.data?.id;
              if (!sessionID) return false;
              const unregisterProbe = yield* Effect.sync(() =>
                agentGatewayCredentials.processes.registerProbe(
                  server.gatewayProcessToken!,
                  sessionID,
                ),
              );
              return yield* runOpenCodeSdk("session.prompt", () =>
                client.session.prompt({
                  sessionID,
                  directory: input.cwd,
                  model: parsedModel,
                  ...(input.effort ? { variant: input.effort } : {}),
                  tools: { "*": false },
                  parts: [{ type: "text", text: "Reply OK." }],
                }),
              ).pipe(
                Effect.ensuring(Effect.sync(unregisterProbe)),
                Effect.map(
                  (response) =>
                    response.data?.info !== undefined &&
                    response.data.info.error === undefined &&
                    !response.data.parts.some((part) => part.type === "tool"),
                ),
                Effect.mapError(toAdapterRequestError),
                Effect.ensuring(
                  runOpenCodeSdk("session.delete", () =>
                    client.session.delete({ sessionID, directory: input.cwd }),
                  ).pipe(Effect.ignore),
                ),
              );
            }),
        ).pipe(
          Effect.timeoutOption(20_000),
          Effect.map((result) => Option.getOrElse(result, () => false)),
        );
      };

      const loadCatalog: NonNullable<OpenCodeAdapterShape["loadCatalog"]> = (input) => {
        const kinds = new Set(input.kinds);
        if (!kinds.has("models") && !kinds.has("commands") && !kinds.has("agents"))
          return Effect.succeed({});
        return withDiscoveryClient(
          { cwd: input.cwd, managedLaunch: input.managedLaunch },
          ({ client }) =>
            Effect.gen(function* () {
              const data: { -readonly [K in keyof ProviderCatalogData]: ProviderCatalogData[K] } =
                {};
              if (kinds.has("models")) {
                const response = yield* runOpenCodeSdk("provider.list", () =>
                  client.provider.list(),
                ).pipe(Effect.mapError(toAdapterRequestError));
                if (!response.data)
                  return yield* new ProviderAdapterRequestError({
                    provider,
                    method: "provider.list",
                    detail: "OpenCode provider.list returned no catalog.",
                  });
                const credentialProviderIDs = yield* openCodeRuntime
                  .loadOpenCodeCredentialProviderIDs(client, adapterConfig.cliSpec)
                  .pipe(Effect.mapError(toAdapterRequestError));
                data.models = flattenOpenCodeModels({
                  inventory: { providerList: response.data, consoleState: null },
                  credentialProviderIDs,
                  ...(input.scope.connectionId === null ? { freeOnlyProviderID: "opencode" } : {}),
                }).filter(
                  (model) =>
                    input.internalProviderId === null ||
                    model.upstreamProviderId === input.internalProviderId,
                );
              }
              if (kinds.has("commands")) {
                const response = yield* runOpenCodeSdk("command.list", () =>
                  client.command.list(),
                ).pipe(Effect.mapError(toAdapterRequestError));
                if (!response.data)
                  return yield* new ProviderAdapterRequestError({
                    provider,
                    method: "command.list",
                    detail: "OpenCode command.list returned no catalog.",
                  });
                data.commands = flattenOpenCodeCommands(response.data);
              }
              if (kinds.has("agents")) {
                const response = yield* runOpenCodeSdk("app.agents", () =>
                  client.app.agents(),
                ).pipe(Effect.mapError(toAdapterRequestError));
                if (!response.data)
                  return yield* new ProviderAdapterRequestError({
                    provider,
                    method: "app.agents",
                    detail: "OpenCode app.agents returned no catalog.",
                  });
                data.agents = flattenOpenCodeAgents(response.data);
              }
              return data;
            }),
        );
      };

      const getComposerCapabilities: NonNullable<
        OpenCodeAdapterShape["getComposerCapabilities"]
      > = () =>
        Effect.succeed({
          provider,
          supportsSkillMentions: false,
          supportsSkillDiscovery: false,
          supportsNativeSlashCommandDiscovery: provider === "opencode",
          supportsPluginMentions: false,
          supportsPluginDiscovery: false,
          supportsRuntimeModelList: true,
          supportsThreadCompaction: true,
          supportsThreadImport: false,
        } satisfies ProviderComposerCapabilities);

      const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
        Effect.gen(function* () {
          const contexts = [...sessions.values()];
          sessions.clear();
          yield* Effect.forEach(
            contexts,
            (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
            { concurrency: "unbounded", discard: true },
          );
          yield* openCodeRuntime.stopAll().pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider,
                  method: "stopAll",
                  detail: String(cause),
                  cause,
                }),
            ),
          );
        });

      const stopAccount: NonNullable<OpenCodeAdapterShape["stopAccount"]> = (connectionId) =>
        Effect.gen(function* () {
          for (const context of sessions.values()) {
            if (context.connectionId !== connectionId) continue;
            yield* stopSession(context.session.threadId);
          }
          yield* openCodeRuntime.stopAccount(connectionId).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider,
                  method: "stopAccount",
                  detail: String(cause),
                  cause,
                }),
            ),
          );
        });

      return {
        provider,
        capabilities: {
          sessionModelSwitch: "in-session",
          supportsRuntimeModelList: true,
          supportsNativeSlashCommandDiscovery: provider === "opencode",
        },
        startSession,
        sendTurn,
        interruptTurn,
        respondToUserInput,
        stopSession,
        listSessions,
        hasSession,
        readThread,
        rollbackThread,
        compactThread,
        stopAll,
        stopAccount,
        drainRuntimeEvents: awaitProviderRuntimeEventsDrained(
          Queue.size(runtimeEvents).pipe(Effect.map((size) => size === 0)),
        ),
        probeTurnEndpoint,
        getComposerCapabilities,
        loadCatalog,
        get streamEvents() {
          return Stream.fromQueue(runtimeEvents);
        },
      } as OpenCodeAdapterShape;
    }),
  ).pipe(
    Layer.provide(
      options?.runtime ? Layer.succeed(OpenCodeRuntime, options.runtime) : OpenCodeRuntimeLive,
    ),
    Layer.provide(NodeServices.layer),
  );
}

export const OpenCodeAdapterLive = makeOpenCodeAdapterLive();
