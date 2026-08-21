import {
  type AssistantDeliveryMode,
  CommandId,
  EventId,
  isToolLifecycleItemType,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
  type RuntimeMode,
} from "@penkra/contracts";
import { createHash } from "node:crypto";
import { Cache, Cause, Deferred, Duration, Effect, Layer, Option, Ref, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeDrainableWorker, startDrainableWorkerProducers } from "@penkra/shared/DrainableWorker";
import { providerSupportsNativeTurnSteering } from "@penkra/shared/providerMetadata";
import {
  buildSubagentIdentityDirectory,
  collectSubagentProviderThreadIds,
  extractSubagentIdentityHints,
  resolveSubagentIdentityFromDirectory,
} from "@penkra/shared/subagents";

import {
  generatedImageMarkdown,
  generatedImagePathFromRuntimeEvent,
  isCodexGeneratedImageArtifact,
} from "../../codexGeneratedImages.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  classifyTerminalTurnApplicability,
  isStartedTurnApplicable,
} from "../../provider/terminalTurnApplicability.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProviderRuntimeEventRepositoryLive } from "../../persistence/Layers/ProviderRuntimeEvents.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  PROVIDER_RUNTIME_INGESTION_CONSUMER,
  ProviderRuntimeEventRepository,
} from "../../persistence/Services/ProviderRuntimeEvents.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionGeneratedImageActivityRecord,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import {
  projectProviderRuntimeActivities,
  providerActivityUpdateDedupeKey,
  providerActivityUpdateFingerprint,
  readableReasoningDetail,
  runtimePayloadRecord,
  runtimeTurnState,
} from "../providerRuntimeActivityProjection.ts";

// FILE: ProviderRuntimeIngestion.ts
// Purpose: Projects provider runtime events into orchestration read-model updates and thread activity.
// Layer: Server orchestration ingestion
// Exports: ProviderRuntimeIngestionLive
// Depends on: ProviderRuntimeEvent contracts, OrchestrationEngine, Projection repositories

const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;
const providerCommandId = (event: ProviderRuntimeEvent, tag: string, target = "event"): CommandId =>
  CommandId.makeUnsafe(`provider:${event.eventId}:${tag}:${target}`);

const DEFAULT_ASSISTANT_DELIVERY_MODE: AssistantDeliveryMode = "buffered";
const PROVIDER_RUNTIME_INGESTION_CAPACITY = 1_024;
const PROVIDER_RUNTIME_REPLAY_PAGE_SIZE = 128;
const PROVIDER_RUNTIME_REPLAY_POLL_INTERVAL = Duration.millis(250);
const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 2_048;
const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(60);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 1_024;
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(60);
const BUFFERED_TOOL_OUTPUT_BY_KEY_CACHE_CAPACITY = 2_048;
const BUFFERED_TOOL_OUTPUT_BY_KEY_TTL = Duration.minutes(60);
const BUFFERED_REASONING_SUMMARY_BY_KEY_CACHE_CAPACITY = 2_048;
const BUFFERED_REASONING_SUMMARY_BY_KEY_TTL = Duration.minutes(60);
const PENDING_GENERATED_IMAGES_CACHE_CAPACITY = 512;
// Hot-path cache only. Turn settlement also reads durable activity records, so
// TTL expiry or a server restart cannot discard the transcript reference.
const PENDING_GENERATED_IMAGES_TTL = Duration.minutes(60);
const ACTIVITY_UPDATE_FINGERPRINT_CACHE_CAPACITY = 4_096;
const ACTIVITY_UPDATE_FINGERPRINT_TTL = Duration.minutes(360);
const MAX_NATIVE_CHILDREN_PER_PARENT_TURN = 20;
const NATIVE_CHILD_IDS_BY_SOURCE_TURN_CACHE_CAPACITY = 2_048;
const NATIVE_CHILD_IDS_BY_SOURCE_TURN_TTL = Duration.minutes(360);
const ASSISTANT_DELIVERY_MODE_BY_TURN_CACHE_CAPACITY = 2_048;
const ASSISTANT_DELIVERY_MODE_BY_TURN_TTL = Duration.minutes(60);
// One turn realistically produces a handful of images; the cap only bounds a
// pathological provider replaying image completions in a loop.
const MAX_PENDING_GENERATED_IMAGES_PER_TURN = 32;
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
const MAX_BUFFERED_TOOL_OUTPUT_CHARS = 24_000;
const MAX_BUFFERED_REASONING_SUMMARY_CHARS = 8_000;
const MAX_BUFFERED_REASONING_SUMMARY_PARTS = 24;
const BUFFERED_TEXT_TRUNCATION_MARKER = "... [truncated]";
const STRICT_PROVIDER_LIFECYCLE_GUARD = process.env.PENKRA_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";

type RuntimeIngestionDomainEvent = Extract<
  OrchestrationEvent,
  {
    type: "thread.turn-start-requested" | "thread.conversation-rolled-back";
  }
>;

type RuntimeIngestionInput =
  | {
      source: "runtime";
      sequence: number;
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: RuntimeIngestionDomainEvent;
    };

type BufferedToolOutput = {
  readonly text: string;
  readonly truncated: boolean;
};

type CanonicalOperationStatus =
  | "started"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "aborted"
  | "interrupted";

function canonicalOperationStatus(event: ProviderRuntimeEvent): CanonicalOperationStatus {
  if (event.type === "tool.progress") return "running";
  if (event.type === "item.started") return "started";
  if (event.type === "item.updated") return "running";
  if (event.type !== "item.completed") return "running";
  const status = String(event.payload.status).toLowerCase();
  if (status === "failed" || status === "error") return "failed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "aborted") return "aborted";
  if (status === "interrupted") return "interrupted";
  return "completed";
}

function canonicalOperationFromRuntimeEvent(event: ProviderRuntimeEvent) {
  if (event.type === "tool.progress") {
    if (!event.payload.toolUseId) return null;
    const activity = projectProviderRuntimeActivities(event)[0];
    if (!activity) return null;
    return {
      providerOperationId: event.payload.toolUseId,
      threadId: event.threadId,
      turnId: event.turnId ?? null,
      provider: event.provider,
      itemType: "mcp_tool_call",
      title: event.payload.toolName ?? event.payload.summary ?? null,
      status: "running" as const,
      inputJson: null,
      activityJson: JSON.stringify(activity),
      startedAt: event.createdAt,
      endedAt: null,
      sourceEventId: event.eventId,
      updatedAt: event.createdAt,
    } as const;
  }
  if (
    (event.type !== "item.started" &&
      event.type !== "item.updated" &&
      event.type !== "item.completed") ||
    event.itemId === undefined ||
    !isToolLifecycleItemType(event.payload.itemType)
  ) {
    return null;
  }
  const activity = projectProviderRuntimeActivities(event)[0];
  if (!activity) return null;
  const status = canonicalOperationStatus(event);
  const terminal =
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "aborted" ||
    status === "interrupted";
  return {
    providerOperationId: event.itemId,
    threadId: event.threadId,
    turnId: event.turnId ?? null,
    provider: event.provider,
    itemType: event.payload.itemType,
    title: event.payload.title ?? null,
    status,
    inputJson: event.payload.input === undefined ? null : JSON.stringify(event.payload.input),
    activityJson: JSON.stringify(activity),
    startedAt: event.createdAt,
    endedAt: terminal ? event.createdAt : null,
    sourceEventId: event.eventId,
    updatedAt: event.createdAt,
  } as const;
}
type BufferedReasoningSummary = {
  readonly parts: ReadonlyMap<number, string>;
  readonly sourceEvent: Extract<ProviderRuntimeEvent, { readonly type: "content.delta" }>;
};
type AssistantDeliveryModeBindingState = {
  readonly pendingModesByThreadId: ReadonlyMap<ThreadId, ReadonlyArray<AssistantDeliveryMode>>;
  readonly unmatchedTurnIdsByThreadId: ReadonlyMap<ThreadId, ReadonlyArray<TurnId>>;
  readonly settledUnmatchedRequestDebtByThreadId: ReadonlyMap<ThreadId, number>;
};
type NativeChildSlotState = {
  initialized: boolean;
  readonly childIds: Set<string>;
};

/**
 * Promote a cheap thread *shell* into a full {@link OrchestrationThread} by
 * filling the heavy arrays with empties. Only valid for events that do not read
 * those arrays (see {@link eventNeedsHeavyThreadDetail}); the empties are never
 * observed on those code paths.
 */
function threadDetailFromShell(shell: OrchestrationThreadShell): OrchestrationThread {
  return {
    ...shell,
    deletedAt: null,
    messages: [],
    activities: [],
  };
}

/**
 * PERF: ingesting one runtime event used to load the full thread detail, which
 * decodes every message's text. For a long turn that streams a large output
 * (tens of thousands of deltas over a growing transcript) this is quadratic, so
 * the live transcript — and crucially the `turn.completed` event — fall minutes
 * behind the provider even though the turn already finished.
 *
 * The overwhelming majority of events (assistant deltas, tool-call lifecycle,
 * message parts) only ever read thread *shell* fields. Only the handlers for the
 * event types below read the heavy message array,
 * so only those pay for the full
 * detail; everything else uses the cheap shell.
 */
function eventNeedsHeavyThreadDetail(event: ProviderRuntimeEvent): boolean {
  if (event.type === "item.completed") {
    // assistant_message completion reads thread.messages to decide whether to
    // apply fallback completion text; image_generation completion scans
    // thread.messages to attach the generated-image reference.
    return (
      event.payload.itemType === "assistant_message" ||
      generatedImagePathFromRuntimeEvent(event) !== undefined
    );
  }
  // Session exits and runtime errors flush the turn's pending generated images
  // into the terminal assistant message, which requires thread.messages.
  return (
    event.type === "turn.completed" ||
    event.type === "turn.aborted" ||
    event.type === "session.exited" ||
    event.type === "runtime.error"
  );
}

function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.makeUnsafe(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  return typeof left === "string" && typeof right === "string" && left === right;
}

function inferRuntimeModeFromUserInputAnswers(
  answers: Record<string, unknown> | undefined,
): RuntimeMode | null {
  const sandboxMode = typeof answers?.sandbox_mode === "string" ? answers.sandbox_mode : null;
  const approvalPolicy =
    typeof answers?.approval_policy === "string" ? answers.approval_policy : null;

  if (sandboxMode === "danger-full-access") {
    return approvalPolicy === null || approvalPolicy === "never"
      ? "full-access"
      : "approval-required";
  }
  if (sandboxMode === "read-only" || sandboxMode === "workspace-write") {
    return "approval-required";
  }
  if (approvalPolicy === "never") {
    return "full-access";
  }
  if (
    approvalPolicy === "untrusted" ||
    approvalPolicy === "on-failure" ||
    approvalPolicy === "on-request"
  ) {
    return "approval-required";
  }
  return null;
}

export function appendCappedBufferedText(existing: string, delta: string, limit: number): string {
  const normalizedLimit = Math.max(0, Math.floor(limit));
  if (normalizedLimit === 0) {
    return "";
  }
  const next = `${existing}${delta}`;
  if (next.length <= normalizedLimit) {
    return next;
  }
  if (normalizedLimit <= BUFFERED_TEXT_TRUNCATION_MARKER.length) {
    return BUFFERED_TEXT_TRUNCATION_MARKER.slice(0, normalizedLimit);
  }
  return `${next.slice(
    0,
    normalizedLimit - BUFFERED_TEXT_TRUNCATION_MARKER.length,
  )}${BUFFERED_TEXT_TRUNCATION_MARKER}`;
}

function reasoningSummaryBufferKey(
  event: ProviderRuntimeEvent,
  threadId = event.threadId,
): string | null {
  if ((event.provider !== "codex" && event.provider !== "antigravity") || !event.itemId) {
    return null;
  }
  if (
    event.type === "content.delta" &&
    (event.payload.streamKind === "reasoning_summary_text" ||
      (event.provider === "antigravity" && event.payload.streamKind === "reasoning_text"))
  ) {
    return [threadId, event.turnId ?? "no-turn", event.itemId].join(":");
  }
  if (
    (event.type === "item.started" ||
      event.type === "item.updated" ||
      event.type === "item.completed") &&
    event.payload.itemType === "reasoning"
  ) {
    return [threadId, event.turnId ?? "no-turn", event.itemId].join(":");
  }
  return null;
}

function joinedBufferedReasoningSummary(
  summary: BufferedReasoningSummary | undefined,
): string | undefined {
  if (!summary) return undefined;
  return readableReasoningDetail(
    Array.from(summary.parts.entries())
      .sort(([left], [right]) => left - right)
      .map(([, text]) => text.trim())
      .filter((text) => text.length > 0)
      .join("\n\n"),
  );
}

function withBufferedReasoningSummary(
  event: ProviderRuntimeEvent,
  summary: BufferedReasoningSummary | undefined,
): ProviderRuntimeEvent {
  if (
    event.type !== "item.completed" ||
    (event.provider !== "codex" && event.provider !== "antigravity") ||
    event.payload.itemType !== "reasoning" ||
    readableReasoningDetail(event.payload.detail)
  ) {
    return event;
  }
  const bufferedDetail = joinedBufferedReasoningSummary(summary);
  if (!bufferedDetail) {
    return event;
  }
  return {
    ...event,
    payload: {
      ...event.payload,
      detail: bufferedDetail,
    },
  };
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function mergeBufferedToolOutputData(
  data: unknown,
  bufferedOutput: BufferedToolOutput,
): Record<string, unknown> {
  const baseData = isJsonObject(data) ? data : {};
  const existingRawOutput = isJsonObject(baseData.rawOutput)
    ? baseData.rawOutput
    : typeof baseData.rawOutput === "string" && baseData.rawOutput.trim().length > 0
      ? { output: baseData.rawOutput }
      : {};
  const hasStructuredOutput =
    hasNonEmptyString(existingRawOutput.output) ||
    hasNonEmptyString(existingRawOutput.stdout) ||
    hasNonEmptyString(existingRawOutput.stderr);
  return {
    ...baseData,
    rawOutput: {
      ...existingRawOutput,
      ...(hasStructuredOutput ? {} : { output: bufferedOutput.text }),
      ...(bufferedOutput.truncated ? { truncated: true } : {}),
    },
  };
}

function withBufferedToolOutputData(
  event: ProviderRuntimeEvent,
  bufferedOutput: BufferedToolOutput | undefined,
): ProviderRuntimeEvent {
  if (!bufferedOutput) {
    return event;
  }
  if (event.type !== "item.updated" && event.type !== "item.completed") {
    return event;
  }
  if (event.payload.itemType !== "command_execution" && event.payload.itemType !== "file_change") {
    return event;
  }
  return {
    ...event,
    payload: {
      ...event.payload,
      data: mergeBufferedToolOutputData(event.payload.data, bufferedOutput),
    },
  } as ProviderRuntimeEvent;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeNonEmptyString(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function hasRenderableAssistantText(text: string | undefined): boolean {
  return (text?.trim().length ?? 0) > 0;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return isJsonObject(value) ? value : undefined;
}

/**
 * Resolves persisted image tool records to their provider artifact paths. The
 * query supplying these records is turn-scoped and independent of the bounded
 * thread-detail activity window.
 */
export function collectPersistedGeneratedImagePaths(
  records: ReadonlyArray<ProjectionGeneratedImageActivityRecord>,
): string[] {
  const paths: string[] = [];
  const seenPaths = new Set<string>();
  const addPath = (path: string) => {
    if (!seenPaths.has(path)) {
      seenPaths.add(path);
      paths.push(path);
    }
  };

  for (const record of records) {
    if (record.kind !== "tool.completed") {
      continue;
    }
    const payload = asObject(record.payload);
    if (payload?.itemType !== "image_generation") {
      continue;
    }
    const artifact = isCodexGeneratedImageArtifact(payload.data) ? payload.data : undefined;
    if (!artifact) {
      continue;
    }
    addPath(artifact.path);
  }

  return paths;
}

interface SubagentIdentity {
  readonly providerThreadId: string;
  readonly agentId?: string;
  readonly nickname?: string;
  readonly role?: string;
  readonly model?: string;
  readonly modelIsRequestedHint?: boolean;
}

function extractCollabPayload(event: ProviderRuntimeEvent): Record<string, unknown> | undefined {
  const payload = runtimePayloadRecord(event);
  return asObject(payload?.data);
}

function extractSubagentIdentity(
  event: ProviderRuntimeEvent,
  providerThreadId: string,
): SubagentIdentity | undefined {
  const collabPayload = extractCollabPayload(event);
  const item = asObject(collabPayload?.item) ?? collabPayload;
  if (!item) {
    return undefined;
  }
  return resolveSubagentIdentityFromDirectory(
    buildSubagentIdentityDirectory(extractSubagentIdentityHints(item)),
    {
      providerThreadId,
    },
  ) as SubagentIdentity | undefined;
}

function subagentThreadTitle(identity: {
  nickname?: string | undefined;
  role?: string | undefined;
  providerThreadId?: string | undefined;
}): string {
  if (identity.nickname && identity.role) {
    return `${identity.nickname} [${identity.role}]`;
  }
  if (identity.nickname) {
    return identity.nickname;
  }
  if (identity.role) {
    return `Subagent [${identity.role}]`;
  }
  return identity.providerThreadId ? `Subagent ${identity.providerThreadId}` : "Subagent";
}

const takeCached = <Key, Value>(cache: Cache.Cache<Key, Value>, key: Key) =>
  Cache.getOption(cache, key).pipe(
    Effect.flatMap((value) => Cache.invalidate(cache, key).pipe(Effect.as(value))),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const runtimeEvents = yield* ProviderRuntimeEventRepository;
  const commandReceipts = yield* OrchestrationCommandReceiptRepository;

  const materializeCanonicalOperation = (event: ProviderRuntimeEvent) => {
    const operation = canonicalOperationFromRuntimeEvent(event);
    if (operation === null) return Effect.succeed(false);
    return sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* sql<{
          readonly operationId: string;
          readonly lastSourceEventId: string;
        }>`
          SELECT operation_id AS "operationId", last_source_event_id AS "lastSourceEventId"
          FROM operations
          WHERE provider = ${operation.provider}
            AND thread_id = ${operation.threadId}
            AND COALESCE(turn_id, '') = COALESCE(${operation.turnId}, '')
            AND provider_operation_id = ${operation.providerOperationId}
        `;
        if (existing[0]?.lastSourceEventId === operation.sourceEventId) return true;
        const operationId = existing[0]?.operationId ?? `operation:${crypto.randomUUID()}`;

        yield* sql`
          INSERT INTO operations (
            operation_id, provider_operation_id, thread_id, turn_id, provider,
            item_type, title, status, input_json, started_at,
            activity_json, ended_at, last_source_event_id, updated_at
          ) VALUES (
            ${operationId}, ${operation.providerOperationId}, ${operation.threadId},
            ${operation.turnId}, ${operation.provider}, ${operation.itemType}, ${operation.title},
            ${operation.status}, ${operation.inputJson}, ${operation.startedAt},
            ${operation.activityJson}, ${operation.endedAt},
            ${operation.sourceEventId},
            ${operation.updatedAt}
          )
          ON CONFLICT DO UPDATE SET
            item_type = excluded.item_type,
            title = COALESCE(excluded.title, operations.title),
            status = CASE
              WHEN operations.status IN (
                'completed', 'failed', 'cancelled', 'aborted', 'interrupted'
              ) AND excluded.status IN ('started', 'running')
                THEN operations.status
              ELSE excluded.status
            END,
            input_json = CASE
              WHEN operations.status IN (
                'completed', 'failed', 'cancelled', 'aborted', 'interrupted'
              ) AND excluded.status IN ('started', 'running')
                THEN operations.input_json
              ELSE COALESCE(excluded.input_json, operations.input_json)
            END,
            activity_json = CASE
              WHEN operations.status IN (
                'completed', 'failed', 'cancelled', 'aborted', 'interrupted'
              ) AND excluded.status IN ('started', 'running')
                THEN operations.activity_json
              ELSE excluded.activity_json
            END,
            ended_at = COALESCE(operations.ended_at, excluded.ended_at),
            last_source_event_id = excluded.last_source_event_id,
            updated_at = excluded.updated_at
        `;
        return true;
      }),
    );
  };

  const materializeCanonicalNotice = (event: ProviderRuntimeEvent) => {
    if (event.type !== "runtime.warning") return Effect.succeed(false);
    const activity = projectProviderRuntimeActivities(event)[0];
    if (!activity) return Effect.succeed(false);
    return sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* sql<{ readonly present: number }>`
          SELECT 1 AS present FROM notices WHERE notice_id = ${event.eventId}
        `;
        if (existing.length > 0) return true;
        yield* sql`
          INSERT INTO notices (
            notice_id, thread_id, turn_id, kind, tone, summary,
            detail_json, created_at
          ) VALUES (
            ${event.eventId}, ${event.threadId}, ${event.turnId ?? null},
            ${activity.kind}, ${activity.tone}, ${activity.summary},
            ${JSON.stringify(activity.payload)}, ${event.createdAt}
          )
        `;
        return true;
      }),
    );
  };

  const resolveEventConnectionId = (event: ProviderRuntimeEvent) =>
    sql<{ readonly connectionId: string }>`
      SELECT connection_id AS "connectionId"
      FROM thread_runtime_bindings
      WHERE thread_id = ${event.threadId} AND connection_id IS NOT NULL
      LIMIT 1
    `.pipe(Effect.map((rows) => rows[0]?.connectionId));

  const materializeConnectionFacts = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      if (
        event.type !== "account.rate-limits.updated" &&
        event.type !== "thread.token-usage.updated" &&
        event.type !== "turn.completed"
      ) {
        return;
      }
      const connectionId = yield* resolveEventConnectionId(event);
      if (connectionId === undefined) {
        yield* Effect.logWarning("provider account fact has no bound connection", {
          threadId: event.threadId,
          eventType: event.type,
          eventId: event.eventId,
        });
        return;
      }
      const utcDay = event.createdAt.slice(0, 10);

      if (event.type === "account.rate-limits.updated") {
        const rateLimits = event.payload.rateLimits;
        const status =
          rateLimits !== null && typeof rateLimits === "object" && "status" in rateLimits
            ? String((rateLimits as { readonly status?: unknown }).status ?? "") || null
            : null;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{ readonly sourceEventId: string }>`
              SELECT last_source_event_id AS "sourceEventId"
              FROM connection_rate_limits WHERE connection_id = ${connectionId}
            `;
            if (existing[0]?.sourceEventId === event.eventId) return;
            yield* sql`
              INSERT INTO connection_rate_limits (
                connection_id, provider, limits_json, status,
                last_source_event_id, updated_at
              ) VALUES (
                ${connectionId}, ${event.provider}, ${JSON.stringify(rateLimits)}, ${status},
                ${event.eventId}, ${event.createdAt}
              )
              ON CONFLICT(connection_id) DO UPDATE SET
                provider = excluded.provider,
                limits_json = excluded.limits_json,
                status = excluded.status,
                last_source_event_id = excluded.last_source_event_id,
                updated_at = excluded.updated_at
            `;
          }),
        );
        return;
      }

      if (event.type === "thread.token-usage.updated") {
        const usage = event.payload.usage;
        const currentInput = usage.inputTokens ?? 0;
        const currentOutput = usage.outputTokens ?? 0;
        const currentReasoning = usage.reasoningOutputTokens ?? 0;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const cursors = yield* sql<{
              readonly inputTokens: number;
              readonly outputTokens: number;
              readonly reasoningOutputTokens: number;
              readonly sourceEventId: string;
            }>`
              SELECT input_tokens AS "inputTokens", output_tokens AS "outputTokens",
                     reasoning_output_tokens AS "reasoningOutputTokens",
                     last_source_event_id AS "sourceEventId"
              FROM connection_usage_cursors
              WHERE thread_id = ${event.threadId} AND connection_id = ${connectionId}
            `;
            const previous = cursors[0];
            if (previous?.sourceEventId === event.eventId) return;
            const delta = (current: number, prior: number | undefined) =>
              prior === undefined || current < prior ? current : current - prior;
            const inputDelta = delta(currentInput, previous?.inputTokens);
            const outputDelta = delta(currentOutput, previous?.outputTokens);
            const reasoningDelta = delta(currentReasoning, previous?.reasoningOutputTokens);
            yield* sql`
              INSERT INTO connection_usage_daily (
                utc_day, connection_id, provider, input_tokens, output_tokens,
                reasoning_output_tokens, turns, updated_at
              ) VALUES (
                ${utcDay}, ${connectionId}, ${event.provider}, ${inputDelta}, ${outputDelta},
                ${reasoningDelta}, 0, ${event.createdAt}
              )
              ON CONFLICT(utc_day, connection_id) DO UPDATE SET
                input_tokens = connection_usage_daily.input_tokens + excluded.input_tokens,
                output_tokens = connection_usage_daily.output_tokens + excluded.output_tokens,
                reasoning_output_tokens =
                  connection_usage_daily.reasoning_output_tokens + excluded.reasoning_output_tokens,
                updated_at = excluded.updated_at
            `;
            yield* sql`
              INSERT INTO connection_usage_cursors (
                thread_id, connection_id, input_tokens, output_tokens,
                reasoning_output_tokens, last_source_event_id, updated_at
              ) VALUES (
                ${event.threadId}, ${connectionId}, ${currentInput}, ${currentOutput},
                ${currentReasoning}, ${event.eventId}, ${event.createdAt}
              )
              ON CONFLICT(thread_id, connection_id) DO UPDATE SET
                input_tokens = excluded.input_tokens,
                output_tokens = excluded.output_tokens,
                reasoning_output_tokens = excluded.reasoning_output_tokens,
                last_source_event_id = excluded.last_source_event_id,
                updated_at = excluded.updated_at
            `;
          }),
        );
        return;
      }

      yield* sql.withTransaction(
        Effect.gen(function* () {
          const inserted = yield* sql<{ readonly sourceEventId: string }>`
            INSERT INTO connection_usage_turn_events (source_event_id, connection_id, utc_day)
            VALUES (${event.eventId}, ${connectionId}, ${utcDay})
            ON CONFLICT(source_event_id) DO NOTHING
            RETURNING source_event_id AS "sourceEventId"
          `;
          if (inserted.length === 0) return;
          yield* sql`
            INSERT INTO connection_usage_daily (
              utc_day, connection_id, provider, input_tokens, output_tokens,
              reasoning_output_tokens, turns, updated_at
            ) VALUES (
              ${utcDay}, ${connectionId}, ${event.provider}, 0, 0, 0, 1,
              ${event.createdAt}
            )
            ON CONFLICT(utc_day, connection_id) DO UPDATE SET
              turns = connection_usage_daily.turns + 1,
              updated_at = excluded.updated_at
          `;
        }),
      );
    });
  const outstandingTurnIdsByThreadRef = yield* Ref.make<ReadonlyMap<ThreadId, ReadonlySet<TurnId>>>(
    new Map(),
  );

  const rememberOutstandingTurn = (threadId: ThreadId, turnId: TurnId) =>
    Ref.update(outstandingTurnIdsByThreadRef, (state) => {
      const next = new Map(state);
      next.set(threadId, new Set([...(next.get(threadId) ?? []), turnId]));
      return next;
    });
  const forgetOutstandingTurn = (threadId: ThreadId, turnId: TurnId) =>
    Ref.update(outstandingTurnIdsByThreadRef, (state) => {
      const current = state.get(threadId);
      if (!current?.has(turnId)) return state;
      const next = new Map(state);
      const remaining = new Set(current);
      remaining.delete(turnId);
      if (remaining.size === 0) next.delete(threadId);
      else next.set(threadId, remaining);
      return next;
    });
  const clearOutstandingTurns = (threadId: ThreadId) =>
    Ref.update(outstandingTurnIdsByThreadRef, (state) => {
      if (!state.has(threadId)) return state;
      const next = new Map(state);
      next.delete(threadId);
      return next;
    });

  // Match request modes and provider turn ids from either arrival direction.
  // Provider turns and domain events can race, and ProviderService permits more
  // than one outstanding send per thread, so neither a global mode nor the
  // session's generic active turn is a valid correlation key.
  const assistantDeliveryModeBindingsRef = yield* Ref.make<AssistantDeliveryModeBindingState>({
    pendingModesByThreadId: new Map(),
    unmatchedTurnIdsByThreadId: new Map(),
    settledUnmatchedRequestDebtByThreadId: new Map(),
  });
  const cloneAssistantDeliveryModeBindings = (state: AssistantDeliveryModeBindingState) => ({
    pendingModesByThreadId: new Map(state.pendingModesByThreadId),
    unmatchedTurnIdsByThreadId: new Map(state.unmatchedTurnIdsByThreadId),
    settledUnmatchedRequestDebtByThreadId: new Map(state.settledUnmatchedRequestDebtByThreadId),
  });
  const shiftThreadQueue = <Value>(
    queues: Map<ThreadId, ReadonlyArray<Value>>,
    threadId: ThreadId,
  ): Value | undefined => {
    const values = queues.get(threadId) ?? [];
    const value = values[0];
    if (value === undefined) return undefined;
    if (values.length === 1) queues.delete(threadId);
    else queues.set(threadId, values.slice(1));
    return value;
  };
  const assistantDeliveryModeByTurnKey = yield* Cache.make<string, AssistantDeliveryMode>({
    capacity: ASSISTANT_DELIVERY_MODE_BY_TURN_CACHE_CAPACITY,
    timeToLive: ASSISTANT_DELIVERY_MODE_BY_TURN_TTL,
    lookup: () => Effect.succeed(DEFAULT_ASSISTANT_DELIVERY_MODE),
  });

  const matchAssistantDeliveryModeRequest = (threadId: ThreadId, mode: AssistantDeliveryMode) =>
    Effect.gen(function* () {
      const matchedTurnId = yield* Ref.modify(assistantDeliveryModeBindingsRef, (state) => {
        const nextState = cloneAssistantDeliveryModeBindings(state);
        const {
          pendingModesByThreadId,
          unmatchedTurnIdsByThreadId,
          settledUnmatchedRequestDebtByThreadId,
        } = nextState;
        const settledRequestDebt = settledUnmatchedRequestDebtByThreadId.get(threadId) ?? 0;
        if (settledRequestDebt > 0) {
          if (settledRequestDebt === 1) {
            settledUnmatchedRequestDebtByThreadId.delete(threadId);
          } else {
            settledUnmatchedRequestDebtByThreadId.set(threadId, settledRequestDebt - 1);
          }
          return [undefined, nextState] as const;
        }
        const unmatchedTurnId = shiftThreadQueue(unmatchedTurnIdsByThreadId, threadId);
        if (!unmatchedTurnId) {
          pendingModesByThreadId.set(threadId, [
            ...(pendingModesByThreadId.get(threadId) ?? []),
            mode,
          ]);
        }
        return [unmatchedTurnId, nextState] as const;
      });
      if (matchedTurnId) {
        yield* Cache.set(
          assistantDeliveryModeByTurnKey,
          providerTurnKey(threadId, matchedTurnId),
          mode,
        );
      }
      return matchedTurnId;
    });

  const matchStartedTurnAssistantDeliveryMode = (
    threadId: ThreadId,
    turnId: TurnId,
    options: { readonly recordUnmatched?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      const key = providerTurnKey(threadId, turnId);
      if (Option.isSome(yield* Cache.getOption(assistantDeliveryModeByTurnKey, key))) {
        return;
      }
      const mode = yield* Ref.modify(assistantDeliveryModeBindingsRef, (state) => {
        const nextState = cloneAssistantDeliveryModeBindings(state);
        const {
          pendingModesByThreadId,
          unmatchedTurnIdsByThreadId,
          settledUnmatchedRequestDebtByThreadId,
        } = nextState;
        const pendingMode = shiftThreadQueue(pendingModesByThreadId, threadId);
        if (pendingMode === undefined) {
          if (options.recordUnmatched === false) {
            // A turn observed before its request may already be waiting on the
            // unmatched side. Once that exact turn terminates it must not be
            // claimable by a later, unrelated request.
            const unmatchedTurnIds = unmatchedTurnIdsByThreadId.get(threadId) ?? [];
            const remainingTurnIds = unmatchedTurnIds.filter(
              (unmatchedTurnId) => unmatchedTurnId !== turnId,
            );
            if (remainingTurnIds.length === 0) {
              unmatchedTurnIdsByThreadId.delete(threadId);
            } else if (remainingTurnIds.length !== unmatchedTurnIds.length) {
              unmatchedTurnIdsByThreadId.set(threadId, remainingTurnIds);
            }
            if (remainingTurnIds.length !== unmatchedTurnIds.length) {
              settledUnmatchedRequestDebtByThreadId.set(
                threadId,
                (settledUnmatchedRequestDebtByThreadId.get(threadId) ?? 0) + 1,
              );
            }
            return [undefined, nextState] as const;
          }
          const unmatchedTurnIds = unmatchedTurnIdsByThreadId.get(threadId) ?? [];
          if (!unmatchedTurnIds.includes(turnId)) {
            unmatchedTurnIdsByThreadId.set(threadId, [...unmatchedTurnIds, turnId]);
          }
          return [undefined, nextState] as const;
        }
        return [pendingMode, nextState] as const;
      });
      if (mode) {
        yield* Cache.set(assistantDeliveryModeByTurnKey, key, mode);
      }
    });

  const getAssistantDeliveryMode = (threadId: ThreadId, turnId: TurnId | undefined) =>
    turnId
      ? Cache.getOption(assistantDeliveryModeByTurnKey, providerTurnKey(threadId, turnId)).pipe(
          Effect.map(Option.getOrElse(() => DEFAULT_ASSISTANT_DELIVERY_MODE)),
        )
      : Effect.succeed(DEFAULT_ASSISTANT_DELIVERY_MODE);

  const clearAssistantDeliveryModeBindingsForThread = (threadId: ThreadId) =>
    Ref.update(assistantDeliveryModeBindingsRef, (state) => {
      if (
        !state.pendingModesByThreadId.has(threadId) &&
        !state.unmatchedTurnIdsByThreadId.has(threadId) &&
        !state.settledUnmatchedRequestDebtByThreadId.has(threadId)
      ) {
        return state;
      }
      const nextState = cloneAssistantDeliveryModeBindings(state);
      nextState.pendingModesByThreadId.delete(threadId);
      nextState.unmatchedTurnIdsByThreadId.delete(threadId);
      nextState.settledUnmatchedRequestDebtByThreadId.delete(threadId);
      return nextState;
    });

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
  });

  const bufferedAssistantTextByMessageId = yield* Cache.make<MessageId, string>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(""),
  });

  const bufferedToolOutputByKey = yield* Cache.make<string, BufferedToolOutput | undefined>({
    capacity: BUFFERED_TOOL_OUTPUT_BY_KEY_CACHE_CAPACITY,
    timeToLive: BUFFERED_TOOL_OUTPUT_BY_KEY_TTL,
    lookup: () => Effect.succeed(undefined),
  });
  const bufferedReasoningSummaryByKey = yield* Cache.make<
    string,
    BufferedReasoningSummary | undefined
  >({
    capacity: BUFFERED_REASONING_SUMMARY_BY_KEY_CACHE_CAPACITY,
    timeToLive: BUFFERED_REASONING_SUMMARY_BY_KEY_TTL,
    lookup: () => Effect.succeed(undefined),
  });
  // Display paths of generated images completed during a still-running turn, keyed by
  // providerTurnKey. Flushed into the turn's terminal assistant message when the turn
  // settles, so the visible final row owns the image instead of collapsed narration.
  const pendingGeneratedImagesByTurnKey = yield* Cache.make<string, ReadonlyArray<string>>({
    capacity: PENDING_GENERATED_IMAGES_CACHE_CAPACITY,
    timeToLive: PENDING_GENERATED_IMAGES_TTL,
    lookup: () => Effect.succeed([]),
  });
  const latestActivityUpdateFingerprintByKey = yield* Cache.make<string, string | undefined>({
    capacity: ACTIVITY_UPDATE_FINGERPRINT_CACHE_CAPACITY,
    timeToLive: ACTIVITY_UPDATE_FINGERPRINT_TTL,
    lookup: () => Effect.succeed(undefined),
  });
  const nativeChildIdsBySourceTurn = yield* Cache.make<string, NativeChildSlotState>({
    capacity: NATIVE_CHILD_IDS_BY_SOURCE_TURN_CACHE_CAPACITY,
    timeToLive: NATIVE_CHILD_IDS_BY_SOURCE_TURN_TTL,
    lookup: () => Effect.succeed({ initialized: false, childIds: new Set<string>() }),
  });

  /**
   * A runtime event can span several independently committed orchestration commands before its
   * journal cursor advances. If the process stops between those commits, replay must continue
   * after the commands that are already durable instead of recomputing their payloads from the
   * now-mutated thread projection and colliding with their deterministic command IDs.
   *
   * Rejected receipts are deliberately not skipped: no durable effect was accepted, and the
   * engine must preserve its normal identity/invariant checks for the retry.
   */
  const dispatchProviderCommandOnce = Effect.fnUntraced(function* (command: OrchestrationCommand) {
    const existingReceipt = yield* commandReceipts.getByCommandId({
      commandId: command.commandId,
    });
    if (Option.isSome(existingReceipt) && existingReceipt.value.status === "accepted") {
      return { sequence: existingReceipt.value.resultSequence };
    }
    return yield* orchestrationEngine.dispatch(command);
  });

  const claimNativeChildSlot = Effect.fnUntraced(function* (
    parentThreadId: ThreadId,
    sourceTurnId: TurnId | null,
    childThreadId: ThreadId,
  ) {
    const budgetKey = `${parentThreadId}:${sourceTurnId ?? "session"}`;
    const slotState = yield* Cache.get(nativeChildIdsBySourceTurn, budgetKey);
    if (!slotState.initialized) {
      const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
      for (const thread of snapshot.threads) {
        if (
          thread.parentThreadId === parentThreadId &&
          (thread.sourceTurnId ?? null) === sourceTurnId
        ) {
          slotState.childIds.add(thread.id);
        }
      }
      slotState.initialized = true;
    }
    const childIds = slotState.childIds;
    if (childIds.has(childThreadId)) {
      return { admitted: true, budgetKey } as const;
    }
    if (childIds.size >= MAX_NATIVE_CHILDREN_PER_PARENT_TURN) {
      return { admitted: false, budgetKey } as const;
    }
    childIds.add(childThreadId);
    return { admitted: true, budgetKey } as const;
  });

  const dispatchActivityUpdate = Effect.fnUntraced(function* (
    event: ProviderRuntimeEvent,
    threadId: ThreadId,
    activity: OrchestrationThreadActivity,
  ) {
    const commandId = providerCommandId(
      event,
      "thread-activity-append",
      `${threadId}:${activity.kind}:${activity.id}`,
    );
    // The provider event id is the durable identity of this projection. Its
    // presentation payload may include bounded process-local aggregation (for
    // example streamed command output). If the exact source event was already
    // accepted before a crash, its durable activity is complete; do not
    // recompute and redispatch it from a shorter retained aggregation window.
    const existingReceipt = yield* commandReceipts.getByCommandId({ commandId });
    if (Option.isSome(existingReceipt) && existingReceipt.value.status === "accepted") {
      return;
    }
    const key = providerActivityUpdateDedupeKey(event, threadId, activity);
    const fingerprint = key ? providerActivityUpdateFingerprint(activity) : undefined;
    if (key && fingerprint) {
      const previous = yield* Cache.getOption(latestActivityUpdateFingerprintByKey, key);
      if (Option.isSome(previous) && previous.value === fingerprint) {
        return;
      }
    }

    yield* dispatchProviderCommandOnce({
      type: "thread.activity.append",
      commandId,
      threadId,
      activity,
      createdAt: activity.createdAt,
    });
    if (key && fingerprint) {
      yield* Cache.set(latestActivityUpdateFingerprintByKey, key, fingerprint);
    }
  });

  const clearActivityUpdateFingerprints = Effect.fnUntraced(function* (threadId: ThreadId) {
    const keyPrefix = `${threadId}:`;
    yield* Effect.forEach(
      Array.from(yield* Cache.keys(latestActivityUpdateFingerprintByKey)),
      (key) =>
        key.startsWith(keyPrefix)
          ? Cache.invalidate(latestActivityUpdateFingerprintByKey, key)
          : Effect.void,
    );
  });

  const getThreadDetail = Effect.fnUntraced(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<OrchestrationThread | undefined> {
    return Option.getOrUndefined(
      yield* projectionSnapshotQuery
        .getThreadDetailById(threadId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none()))),
    );
  });

  // PERF: cheap counterpart to getThreadDetail for events that never read the
  // heavy thread arrays. Loads only the shell projection and promotes it with
  // empty arrays. See eventNeedsHeavyThreadDetail.
  const getThreadShellDetail = Effect.fnUntraced(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<OrchestrationThread | undefined> {
    const shell = Option.getOrUndefined(
      yield* projectionSnapshotQuery
        .getThreadShellById(threadId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none()))),
    );
    return shell ? threadDetailFromShell(shell) : undefined;
  });

  const rememberAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Cache.set(
          turnMessageIdsByTurnKey,
          providerTurnKey(threadId, turnId),
          Option.match(existingIds, {
            onNone: () => new Set([messageId]),
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.add(messageId);
              return nextIds;
            },
          }),
        ),
      ),
    );

  const forgetAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Option.match(existingIds, {
          onNone: () => Effect.void,
          onSome: (ids) => {
            const nextIds = new Set(ids);
            nextIds.delete(messageId);
            if (nextIds.size === 0) {
              return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));
            }
            return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId), nextIds);
          },
        }),
      ),
    );

  const getAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));

  const appendBufferedAssistantText = (messageId: MessageId, delta: string) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Effect.gen(function* () {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });
          if (nextText.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
            yield* Cache.set(bufferedAssistantTextByMessageId, messageId, nextText);
            return "";
          }

          // Safety valve: flush full buffered text as an assistant delta to cap memory.
          yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
          return nextText;
        }),
      ),
    );

  const takeBufferedAssistantText = (messageId: MessageId) =>
    takeCached(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.map(Option.getOrElse(() => "")),
    );

  const appendBufferedToolOutput = (key: string, delta: string) =>
    Cache.getOption(bufferedToolOutputByKey, key).pipe(
      Effect.flatMap((existingEntry) => {
        const existing = Option.getOrUndefined(existingEntry);
        const existingText = existing?.text ?? "";
        const truncated = existingText.length + delta.length > MAX_BUFFERED_TOOL_OUTPUT_CHARS;
        return Cache.set(bufferedToolOutputByKey, key, {
          text: appendCappedBufferedText(existingText, delta, MAX_BUFFERED_TOOL_OUTPUT_CHARS),
          truncated: existing?.truncated === true || truncated,
        });
      }),
    );

  const getBufferedToolOutput = (key: string) =>
    Cache.getOption(bufferedToolOutputByKey, key).pipe(
      Effect.map((existingEntry) => Option.getOrUndefined(existingEntry)),
    );

  const takeBufferedToolOutput = (key: string) =>
    takeCached(bufferedToolOutputByKey, key).pipe(Effect.map(Option.getOrUndefined));

  const appendBufferedReasoningSummary = (
    key: string,
    event: Extract<ProviderRuntimeEvent, { readonly type: "content.delta" }>,
  ) =>
    Cache.getOption(bufferedReasoningSummaryByKey, key).pipe(
      Effect.flatMap((existingEntry) => {
        const summaryIndex = event.payload.summaryIndex ?? 0;
        const delta = event.payload.delta;
        if (
          summaryIndex < 0 ||
          summaryIndex >= MAX_BUFFERED_REASONING_SUMMARY_PARTS ||
          delta.length === 0
        ) {
          return Effect.void;
        }
        const existingSummary = Option.getOrUndefined(existingEntry);
        const parts = new Map(existingSummary?.parts ?? []);
        const existingPart = parts.get(summaryIndex) ?? "";
        const otherChars = Array.from(parts.entries()).reduce(
          (total, [index, text]) => total + (index === summaryIndex ? 0 : text.length),
          0,
        );
        const partLimit = Math.max(0, MAX_BUFFERED_REASONING_SUMMARY_CHARS - otherChars);
        if (partLimit === 0) {
          return Effect.void;
        }
        parts.set(summaryIndex, appendCappedBufferedText(existingPart, delta, partLimit));
        return Cache.set(bufferedReasoningSummaryByKey, key, {
          parts,
          sourceEvent: event,
        });
      }),
    );

  const takeBufferedReasoningSummary = (key: string) =>
    takeCached(bufferedReasoningSummaryByKey, key).pipe(Effect.map(Option.getOrUndefined));

  const settleBufferedReasoningSummaries = (
    threadId: ThreadId,
    terminalEvent: ProviderRuntimeEvent,
    turnId?: TurnId,
  ) => {
    const prefix = turnId ? `${threadId}:${turnId}:` : `${threadId}:`;
    const status =
      terminalEvent.type === "runtime.error" ||
      terminalEvent.type === "turn.aborted" ||
      (terminalEvent.type === "turn.completed" && terminalEvent.payload.state !== "completed") ||
      (terminalEvent.type === "session.exited" && terminalEvent.payload.exitKind === "error")
        ? "failed"
        : "completed";
    return Cache.keys(bufferedReasoningSummaryByKey).pipe(
      Effect.flatMap((keys) =>
        Effect.forEach(
          Array.from(keys).filter((key) => key.startsWith(prefix)),
          (key) =>
            takeBufferedReasoningSummary(key).pipe(
              Effect.flatMap((summary) => {
                const detail = joinedBufferedReasoningSummary(summary);
                if (!summary || !detail || !summary.sourceEvent.itemId) {
                  return Effect.void;
                }
                const completionEvent: ProviderRuntimeEvent = {
                  ...summary.sourceEvent,
                  eventId: EventId.makeUnsafe(
                    `${terminalEvent.eventId}:reasoning:${summary.sourceEvent.itemId}`,
                  ),
                  threadId,
                  type: "item.completed",
                  payload: {
                    itemType: "reasoning",
                    status,
                    title: "Reasoning",
                    detail,
                  },
                };
                return Effect.forEach(
                  projectProviderRuntimeActivities(completionEvent),
                  (activity) => dispatchActivityUpdate(completionEvent, threadId, activity),
                ).pipe(Effect.asVoid);
              }),
            ),
        ).pipe(Effect.asVoid),
      ),
    );
  };

  const clearAssistantMessageState = (messageId: MessageId) =>
    Cache.invalidate(bufferedAssistantTextByMessageId, messageId);

  const resolveAssistantCompletionMessageId = (input: {
    event: ProviderRuntimeEvent;
    thread: OrchestrationThread;
    turnId?: TurnId;
  }) =>
    Effect.gen(function* () {
      if (input.turnId) {
        const knownAssistantMessageIds = yield* getAssistantMessageIdsForTurn(
          input.thread.id,
          input.turnId,
        );
        if (input.event.itemId) {
          const eventMessageId = MessageId.makeUnsafe(`assistant:${input.event.itemId}`);
          if (knownAssistantMessageIds.has(eventMessageId)) {
            return eventMessageId;
          }
        }
        if (knownAssistantMessageIds.size === 1) {
          const [onlyMessageId] = knownAssistantMessageIds;
          if (onlyMessageId) {
            return onlyMessageId;
          }
        }
        if (knownAssistantMessageIds.size > 1) {
          const preferredKnownMessage = input.thread.messages
            .filter(
              (message: OrchestrationThread["messages"][number]) =>
                message.role === "assistant" &&
                message.turnId === input.turnId &&
                knownAssistantMessageIds.has(message.id),
            )
            .toSorted(
              (
                left: OrchestrationThread["messages"][number],
                right: OrchestrationThread["messages"][number],
              ) => {
                if (left.streaming !== right.streaming) {
                  return left.streaming ? -1 : 1;
                }
                return (
                  right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
                );
              },
            )[0];
          if (preferredKnownMessage) {
            return preferredKnownMessage.id;
          }
        }
        return input.event.itemId
          ? MessageId.makeUnsafe(`assistant:${input.event.itemId}`)
          : MessageId.makeUnsafe(`assistant:${input.turnId}`);
      }

      if (input.event.itemId) {
        return MessageId.makeUnsafe(`assistant:${input.event.itemId}`);
      }

      return MessageId.makeUnsafe(`assistant:${input.event.eventId}`);
    });

  const flushBufferedAssistantMessageDelta = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      if (!hasRenderableAssistantText(bufferedText)) {
        return false;
      }

      yield* dispatchProviderCommandOnce({
        type: "thread.message.assistant.delta",
        commandId: providerCommandId(input.event, input.commandTag, input.messageId),
        threadId: input.threadId,
        messageId: input.messageId,
        delta: bufferedText,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
      return true;
    });

  const flushBufferedAssistantMessagesForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const assistantMessageIds = yield* getAssistantMessageIdsForTurn(
        input.threadId,
        input.turnId,
      );
      for (const assistantMessageId of assistantMessageIds) {
        yield* flushBufferedAssistantMessageDelta({
          event: input.event,
          threadId: input.threadId,
          messageId: assistantMessageId,
          turnId: input.turnId,
          createdAt: input.createdAt,
          commandTag: input.commandTag,
        });
      }
    });

  const finalizeBufferedAssistantMessagesForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
  }) =>
    Effect.gen(function* () {
      const assistantMessageIds = yield* getAssistantMessageIdsForTurn(
        input.threadId,
        input.turnId,
      );
      yield* Effect.forEach(assistantMessageIds, (assistantMessageId) =>
        finalizeAssistantMessage({
          event: input.event,
          threadId: input.threadId,
          messageId: assistantMessageId,
          turnId: input.turnId,
          createdAt: input.createdAt,
          commandTag: input.commandTag,
          finalDeltaCommandTag: input.finalDeltaCommandTag,
        }),
      );
      yield* clearAssistantMessageIdsForTurn(input.threadId, input.turnId);
    });

  const finalizeAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    fallbackText?: string;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      const authoritativeText =
        (input.fallbackText?.trim().length ?? 0) > 0 ? input.fallbackText : undefined;
      const text = authoritativeText ?? bufferedText;

      // A completed assistant item is an authoritative accumulated snapshot. In buffered mode it
      // can replace the entire in-memory assembly directly; in streaming mode the terminal event
      // replaces whatever fragments were already projected. Only synthesize a final delta when a
      // provider did not supply completion text.
      if (authoritativeText === undefined && hasRenderableAssistantText(text)) {
        yield* dispatchProviderCommandOnce({
          type: "thread.message.assistant.delta",
          commandId: providerCommandId(input.event, input.finalDeltaCommandTag, input.messageId),
          threadId: input.threadId,
          messageId: input.messageId,
          delta: text,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }

      yield* dispatchProviderCommandOnce({
        type: "thread.message.assistant.complete",
        commandId: providerCommandId(input.event, input.commandTag, input.messageId),
        threadId: input.threadId,
        messageId: input.messageId,
        ...(authoritativeText !== undefined ? { finalText: authoritativeText } : {}),
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
      yield* clearAssistantMessageState(input.messageId);
    });

  /**
   * Appends generated-image markdown to one explicit assistant message (creating it
   * when it does not exist yet) and finalizes it. Image markdown already present on
   * the target is skipped, so provider replays never duplicate references or re-emit
   * message-sent events for untouched, already-finalized targets.
   */
  const appendGeneratedImagesToAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    targetMessage:
      | Pick<OrchestrationThread["messages"][number], "id" | "text" | "streaming">
      | undefined;
    newMessageId: MessageId;
    imagePaths: ReadonlyArray<string>;
    turnId?: TurnId;
    createdAt: string;
  }) =>
    Effect.gen(function* () {
      const targetMessageId = input.targetMessage?.id ?? input.newMessageId;
      const targetMessageText = input.targetMessage?.text ?? "";
      const targetIsStreaming = input.targetMessage?.streaming ?? false;

      const missingMarkdown: string[] = [];
      for (const imagePath of input.imagePaths) {
        const markdown = generatedImageMarkdown(imagePath);
        if (
          targetMessageText.includes(imagePath) ||
          targetMessageText.includes(markdown) ||
          missingMarkdown.includes(markdown)
        ) {
          continue;
        }
        missingMarkdown.push(markdown);
      }

      let dispatchedDelta = false;
      if (missingMarkdown.length > 0) {
        const joined = missingMarkdown.join("\n\n");
        yield* dispatchProviderCommandOnce({
          type: "thread.message.assistant.delta",
          commandId: providerCommandId(input.event, "generated-image-delta", targetMessageId),
          threadId: input.threadId,
          messageId: targetMessageId,
          delta: targetMessageText.trim().length > 0 ? `\n\n${joined}` : joined,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
        dispatchedDelta = true;
      }

      // Only finalize when we actually changed the message (delta dispatched, or we
      // just created a brand-new image-only message), or when the existing target was
      // still streaming. Skipping complete on already-finalized targets keeps replays
      // and duplicate provider notifications from emitting redundant message-sent events.
      const shouldComplete = dispatchedDelta || !input.targetMessage || targetIsStreaming;
      if (shouldComplete) {
        yield* dispatchProviderCommandOnce({
          type: "thread.message.assistant.complete",
          commandId: providerCommandId(input.event, "generated-image-complete", targetMessageId),
          threadId: input.threadId,
          messageId: targetMessageId,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }
    });

  const rememberPendingGeneratedImage = (threadId: ThreadId, turnId: TurnId, imagePath: string) =>
    Cache.getOption(pendingGeneratedImagesByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingPaths) => {
        const paths = Option.getOrElse(existingPaths, (): ReadonlyArray<string> => []);
        if (paths.includes(imagePath) || paths.length >= MAX_PENDING_GENERATED_IMAGES_PER_TURN) {
          return Effect.void;
        }
        return Cache.set(pendingGeneratedImagesByTurnKey, providerTurnKey(threadId, turnId), [
          ...paths,
          imagePath,
        ]);
      }),
    );

  const takePendingGeneratedImages = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(pendingGeneratedImagesByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingPaths) =>
        Cache.invalidate(pendingGeneratedImagesByTurnKey, providerTurnKey(threadId, turnId)).pipe(
          Effect.as(Option.getOrElse(existingPaths, (): ReadonlyArray<string> => [])),
        ),
      ),
    );

  /**
   * Codex emits generated images as artifacts, so the turn's final assistant item is
   * often intentionally empty: the image IS the answer. Attaching images eagerly to
   * whatever narration exists mid-turn hands them to a message the settled-turn UI
   * collapses into the "Worked for…" disclosure, leaving the visible terminal row as
   * "(empty response)". Flushing at turn settle targets the actual terminal message
   * — including an empty one, whose body becomes the image markdown. Persisted
   * activity recovery complements the hot cache for long turns and restarts.
   */
  const flushPendingGeneratedImagesForTurn = (input: {
    event: ProviderRuntimeEvent;
    thread: OrchestrationThread;
    turnId: TurnId;
    createdAt: string;
  }) =>
    Effect.gen(function* () {
      const cachedImagePaths = yield* takePendingGeneratedImages(input.thread.id, input.turnId);
      const persistedRecords = yield* projectionSnapshotQuery
        .listGeneratedImageActivitiesByTurn(input.thread.id, input.turnId)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to recover persisted generated-image references", {
              threadId: input.thread.id,
              turnId: input.turnId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as<ReadonlyArray<ProjectionGeneratedImageActivityRecord>>([])),
          ),
        );
      const imagePaths = [
        ...new Set([...cachedImagePaths, ...collectPersistedGeneratedImagePaths(persistedRecords)]),
      ];
      if (imagePaths.length === 0) {
        return;
      }
      // The terminal assistant message is the newest of the turn: the transcript UI
      // gives the last assistant row ownership of the settled turn and folds every
      // earlier assistant row, so this is the only row that stays visible.
      const terminalMessage = input.thread.messages
        .filter((message) => message.role === "assistant" && message.turnId === input.turnId)
        .toSorted(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
        )[0];
      yield* appendGeneratedImagesToAssistantMessage({
        event: input.event,
        threadId: input.thread.id,
        targetMessage: terminalMessage,
        newMessageId: MessageId.makeUnsafe(`assistant:image:${input.turnId}`),
        imagePaths,
        turnId: input.turnId,
        createdAt: input.createdAt,
      });
    });

  const clearTurnStateForSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const prefix = `${threadId}:`;
      yield* Effect.forEach(Array.from(yield* Cache.keys(turnMessageIdsByTurnKey)), (key) =>
        Effect.gen(function* () {
          if (!key.startsWith(prefix)) {
            return;
          }

          const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
          if (Option.isSome(messageIds)) {
            yield* Effect.forEach(messageIds.value, clearAssistantMessageState);
          }

          yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
        }),
      );
      yield* Effect.forEach(Array.from(yield* Cache.keys(pendingGeneratedImagesByTurnKey)), (key) =>
        key.startsWith(prefix)
          ? Cache.invalidate(pendingGeneratedImagesByTurnKey, key)
          : Effect.void,
      );
    });

  const commitCanonicalRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      yield* materializeCanonicalOperation(event);
      yield* materializeCanonicalNotice(event);
      yield* materializeConnectionFacts(event);
    });

  const processRuntimeEvent = (
    event: ProviderRuntimeEvent,
    commitCanonical: (
      event: ProviderRuntimeEvent,
    ) => Effect.Effect<void, unknown> = commitCanonicalRuntimeEvent,
  ) =>
    Effect.gen(function* () {
      const now = event.createdAt;
      // Load the full (heavy) detail only when this event's handlers actually read
      // thread.messages; otherwise use the cheap
      // shell so high-frequency streaming events don't re-decode the whole
      // transcript. See eventNeedsHeavyThreadDetail for the safety rationale.
      const needsHeavyThreadDetail = eventNeedsHeavyThreadDetail(event);
      const parentThread = needsHeavyThreadDetail
        ? yield* getThreadDetail(event.threadId)
        : yield* getThreadShellDetail(event.threadId);
      if (!parentThread) return;

      const ensureSubagentThread = (
        providerThreadId: string,
        identity?: Pick<
          SubagentIdentity,
          "agentId" | "nickname" | "role" | "model" | "modelIsRequestedHint"
        >,
      ) =>
        Effect.gen(function* () {
          const childThreadId = ThreadId.makeUnsafe(
            `subagent:${parentThread.id}:${providerThreadId}`,
          );
          const sourceTurnId = toTurnId(event.turnId) ?? null;
          // A single provider event can describe the child both as a collab receiver and
          // as the event's provider thread, so re-read after any earlier dispatch in this handler.
          // Mirror the parent load: only this event's heavy-detail handlers read the
          // child's message array, so otherwise use the cheap shell.
          const existingThread = needsHeavyThreadDetail
            ? yield* projectionSnapshotQuery.getThreadDetailById(childThreadId)
            : Option.map(
                yield* projectionSnapshotQuery.getThreadShellById(childThreadId),
                threadDetailFromShell,
              );
          const resolvedModelSelection =
            identity?.model && identity.modelIsRequestedHint !== true
              ? {
                  provider: parentThread.modelSelection.provider,
                  model: identity.model,
                }
              : undefined;

          if (Option.isNone(existingThread)) {
            const slot = yield* claimNativeChildSlot(parentThread.id, sourceTurnId, childThreadId);
            if (!slot.admitted) {
              const overflowId = EventId.makeUnsafe(
                `provider-native-child-overflow:${slot.budgetKey}`,
              );
              yield* dispatchProviderCommandOnce({
                type: "thread.activity.append",
                commandId: CommandId.makeUnsafe(`provider:native-child-overflow:${slot.budgetKey}`),
                threadId: parentThread.id,
                activity: {
                  id: overflowId,
                  tone: "error",
                  kind: "subagent.materialization.capped",
                  summary: `Penkra limited this provider turn to ${MAX_NATIVE_CHILDREN_PER_PARENT_TURN} visible native subagents.`,
                  payload: {
                    source: "provider_native",
                    cap: MAX_NATIVE_CHILDREN_PER_PARENT_TURN,
                  },
                  turnId: sourceTurnId,
                  createdAt: now,
                },
                createdAt: now,
              });
              return undefined;
            }
            yield* dispatchProviderCommandOnce({
              type: "thread.create",
              commandId: providerCommandId(event, "subagent-thread-create", childThreadId),
              threadId: childThreadId,
              projectId: parentThread.projectId,
              title: subagentThreadTitle({
                nickname: identity?.nickname,
                role: identity?.role,
                providerThreadId,
              }),
              modelSelection: resolvedModelSelection ?? parentThread.modelSelection,
              runtimeMode: parentThread.runtimeMode,
              workingDirectory: parentThread.workingDirectory ?? null,
              parentThreadId: parentThread.id,
              creationSource: "provider_native",
              sourceThreadId: parentThread.id,
              ...(sourceTurnId !== null ? { sourceTurnId } : {}),
              subagentAgentId: identity?.agentId ?? null,
              subagentNickname: identity?.nickname ?? null,
              subagentRole: identity?.role ?? null,
              createdAt: now,
            });
          } else {
            const existingThreadShell = existingThread.value;
            if (
              identity?.agentId !== undefined ||
              identity?.nickname !== undefined ||
              identity?.role !== undefined ||
              (identity?.model !== undefined && identity.modelIsRequestedHint !== true)
            ) {
              yield* dispatchProviderCommandOnce({
                type: "thread.meta.update",
                commandId: providerCommandId(event, "subagent-thread-meta-update", childThreadId),
                threadId: childThreadId,
                ...(identity?.nickname !== undefined || identity?.role !== undefined
                  ? {
                      title: subagentThreadTitle({
                        nickname:
                          identity?.nickname ?? existingThreadShell.subagentNickname ?? undefined,
                        role: identity?.role ?? existingThreadShell.subagentRole ?? undefined,
                        providerThreadId,
                      }),
                    }
                  : {}),
                parentThreadId: parentThread.id,
                ...(resolvedModelSelection !== undefined &&
                existingThreadShell.modelSelection.model !== resolvedModelSelection.model
                  ? { modelSelection: resolvedModelSelection }
                  : {}),
                ...(identity?.agentId !== undefined ? { subagentAgentId: identity.agentId } : {}),
                ...(identity?.nickname !== undefined
                  ? { subagentNickname: identity.nickname }
                  : {}),
                ...(identity?.role !== undefined ? { subagentRole: identity.role } : {}),
              });
            }
          }

          return {
            threadId: childThreadId,
            thread: Option.match(existingThread, {
              onSome: (thread) => thread,
              onNone: () => ({
                ...parentThread,
                id: childThreadId,
                title: subagentThreadTitle({
                  nickname: identity?.nickname,
                  role: identity?.role,
                  providerThreadId,
                }),
                parentThreadId: parentThread.id,
                creationSource: "provider_native" as const,
                sourceThreadId: parentThread.id,
                sourceTurnId,
                gatewayOperationId: null,
                gatewayOperationIndex: null,
                subagentAgentId: identity?.agentId ?? null,
                subagentNickname: identity?.nickname ?? null,
                subagentRole: identity?.role ?? null,
                modelSelection: resolvedModelSelection ?? parentThread.modelSelection,
                latestTurn: null,
                messages: [],
                activities: [],
                session: null,
                createdAt: now,
                updatedAt: now,
              }),
            }),
          };
        });

      const collabPayload = extractCollabPayload(event);
      const collabItem = asObject(collabPayload?.item) ?? collabPayload;
      const isCollabToolEvent =
        (event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed") &&
        event.payload.itemType === "collab_agent_tool_call" &&
        collabItem !== undefined;
      if (isCollabToolEvent && collabItem) {
        const receiverThreadIds = collectSubagentProviderThreadIds(collabItem);
        const identityDirectory = buildSubagentIdentityDirectory(
          extractSubagentIdentityHints(collabItem),
        );
        for (const receiverThreadId of receiverThreadIds) {
          yield* ensureSubagentThread(
            receiverThreadId,
            resolveSubagentIdentityFromDirectory(identityDirectory, {
              providerThreadId: receiverThreadId,
            }) as SubagentIdentity | undefined,
          );
        }
      }

      const providerThreadId = normalizeNonEmptyString(event.providerRefs?.providerThreadId);
      const providerParentThreadId = normalizeNonEmptyString(
        event.providerRefs?.providerParentThreadId,
      );
      const targetThreadResolution =
        providerThreadId !== undefined &&
        providerParentThreadId !== undefined &&
        providerThreadId !== providerParentThreadId
          ? yield* ensureSubagentThread(
              providerThreadId,
              extractSubagentIdentity(event, providerThreadId),
            )
          : { threadId: parentThread.id, thread: parentThread };
      if (targetThreadResolution === undefined) {
        return;
      }
      const thread = targetThreadResolution.thread;
      const activeTurnId = thread.session?.activeTurnId ?? null;
      const isTerminalTurnEvent = event.type === "turn.completed" || event.type === "turn.aborted";
      const rawEventTurnId = toTurnId(event.turnId);
      const isSettledTurnRestart =
        event.type === "turn.started" && rawEventTurnId
          ? yield* projectionTurnRepository
              .getByTurnId({ threadId: thread.id, turnId: rawEventTurnId })
              .pipe(
                Effect.map(
                  Option.exists(
                    (turn) =>
                      turn.completedAt !== null ||
                      turn.state === "completed" ||
                      turn.state === "interrupted" ||
                      turn.state === "error",
                  ),
                ),
              )
          : false;
      const terminalApplicability = isTerminalTurnEvent
        ? classifyTerminalTurnApplicability({
            activeTurnId,
            eventTurnId: rawEventTurnId,
            hasAmbiguousTurns:
              ((yield* Ref.get(outstandingTurnIdsByThreadRef)).get(thread.id)?.size ?? 0) > 1,
          })
        : undefined;
      const eventTurnId =
        terminalApplicability?.resolvedTurnId !== undefined
          ? TurnId.makeUnsafe(terminalApplicability.resolvedTurnId)
          : rawEventTurnId;

      const shouldApplyThreadLifecycle =
        event.type === "turn.started"
          ? !isSettledTurnRestart &&
            (!STRICT_PROVIDER_LIFECYCLE_GUARD ||
              isStartedTurnApplicable({ activeTurnId, eventTurnId }))
          : !isTerminalTurnEvent || (terminalApplicability?.applicable ?? true);
      if (event.type === "turn.started" && eventTurnId && shouldApplyThreadLifecycle) {
        yield* rememberOutstandingTurn(thread.id, eventTurnId);
      }
      if (isTerminalTurnEvent) {
        if (eventTurnId) {
          yield* forgetOutstandingTurn(thread.id, eventTurnId);
        }
        if (terminalApplicability?.reason === "ambiguous-missing-turn-id") {
          yield* Effect.logWarning("provider.runtime.ambiguous_terminal_event_ignored", {
            threadId: thread.id,
            eventType: event.type,
          });
        }
      }
      // ProviderService permits overlapping sends on one thread. An accepted
      // start binds exactly one queued delivery policy; a replay for a turn
      // that is already durable-terminal must not consume another policy.
      if (event.type === "turn.started" && eventTurnId && shouldApplyThreadLifecycle) {
        yield* matchStartedTurnAssistantDeliveryMode(thread.id, eventTurnId);
      }
      // A terminal event can be the first lifecycle signal for a provider
      // turn. Consume an already-pending request in that case, but never add a
      // completed turn to the unmatched side for a future request to claim.
      if (isTerminalTurnEvent && eventTurnId) {
        yield* matchStartedTurnAssistantDeliveryMode(thread.id, eventTurnId, {
          recordUnmatched: false,
        });
      }
      if (
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        event.type === "turn.completed" ||
        event.type === "turn.aborted"
      ) {
        const nextActiveTurnId =
          event.type === "turn.started"
            ? (eventTurnId ?? null)
            : isTerminalTurnEvent ||
                event.type === "session.exited" ||
                (event.type === "session.state.changed" &&
                  (event.payload.state === "ready" ||
                    event.payload.state === "stopped" ||
                    event.payload.state === "error"))
              ? null
              : activeTurnId;
        const status = (() => {
          switch (event.type) {
            case "session.state.changed":
              return event.payload.state === "waiting" ? "running" : event.payload.state;
            case "turn.started":
              return "running";
            case "session.exited":
              return "stopped";
            case "turn.completed":
              return runtimeTurnState(event) === "failed"
                ? "error"
                : runtimeTurnState(event) === "interrupted"
                  ? "interrupted"
                  : "ready";
            case "turn.aborted":
              return "interrupted";
            case "session.started":
            case "thread.started":
              // Provider thread/session start notifications can arrive during an
              // active turn; preserve turn-running state in that case.
              return activeTurnId !== null ? "running" : "ready";
          }
        })();
        if (
          (event.type === "session.started" || event.type === "thread.started") &&
          activeTurnId !== null
        ) {
          yield* Effect.logInfo("preserving active turn across provider connection readiness", {
            threadId: thread.id,
            turnId: activeTurnId,
            provider: event.provider,
            runtimeEventId: event.eventId,
            runtimeEventType: event.type,
          });
        }
        const lastError =
          event.type === "session.state.changed" && event.payload.state === "error"
            ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
            : status === "error"
              ? (asString(runtimePayloadRecord(event)?.errorMessage) ??
                thread.session?.lastError ??
                "Turn failed")
              : status === "ready" || status === "interrupted"
                ? null
                : (thread.session?.lastError ?? null);

        if (shouldApplyThreadLifecycle) {
          yield* dispatchProviderCommandOnce({
            type: "thread.session.set",
            commandId: providerCommandId(event, "thread-session-set", thread.id),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status,
              providerName: event.provider,
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: nextActiveTurnId,
              lastError,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      if (event.type === "user-input.resolved") {
        const inferredRuntimeMode = inferRuntimeModeFromUserInputAnswers(event.payload.answers);
        if (inferredRuntimeMode && inferredRuntimeMode !== thread.runtimeMode) {
          yield* dispatchProviderCommandOnce({
            type: "thread.runtime-mode.set",
            commandId: providerCommandId(event, "thread-runtime-mode-set", thread.id),
            threadId: thread.id,
            runtimeMode: inferredRuntimeMode,
            createdAt: now,
          });
        }
      }

      const toolOutputKey = event.itemId
        ? [event.threadId, event.turnId ?? "no-turn", event.itemId].join(":")
        : null;
      if (
        toolOutputKey &&
        event.type === "content.delta" &&
        (event.payload.streamKind === "command_output" ||
          event.payload.streamKind === "file_change_output") &&
        event.payload.delta.length > 0
      ) {
        yield* appendBufferedToolOutput(toolOutputKey, event.payload.delta);
      }

      const reasoningSummaryKey = reasoningSummaryBufferKey(event, thread.id);
      if (
        reasoningSummaryKey &&
        event.type === "content.delta" &&
        (event.payload.streamKind === "reasoning_summary_text" ||
          (event.provider === "antigravity" && event.payload.streamKind === "reasoning_text")) &&
        event.payload.delta.length > 0
      ) {
        yield* appendBufferedReasoningSummary(reasoningSummaryKey, event);
      }

      const assistantDelta =
        event.type === "content.delta" && event.payload.streamKind === "assistant_text"
          ? event.payload.delta
          : undefined;

      if (assistantDelta && assistantDelta.length > 0) {
        const assistantMessageId = MessageId.makeUnsafe(
          `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
        );
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
          // Some providers can emit content before (or without) turn.started.
          // Treat the first concrete assistant delta as an equivalent arrival
          // signal so the FIFO request mode is bound before delivery is chosen.
          yield* matchStartedTurnAssistantDeliveryMode(thread.id, turnId);
        }

        const assistantDeliveryMode = yield* getAssistantDeliveryMode(
          thread.id,
          turnId ?? activeTurnId ?? undefined,
        );
        if (assistantDeliveryMode === "buffered") {
          const spillChunk = yield* appendBufferedAssistantText(assistantMessageId, assistantDelta);
          if (spillChunk.length > 0) {
            yield* dispatchProviderCommandOnce({
              type: "thread.message.assistant.delta",
              commandId: providerCommandId(
                event,
                "assistant-delta-buffer-spill",
                assistantMessageId,
              ),
              threadId: thread.id,
              messageId: assistantMessageId,
              delta: spillChunk,
              ...(turnId ? { turnId } : {}),
              createdAt: now,
            });
          }
        } else {
          yield* dispatchProviderCommandOnce({
            type: "thread.message.assistant.delta",
            commandId: providerCommandId(event, "assistant-delta", assistantMessageId),
            threadId: thread.id,
            messageId: assistantMessageId,
            delta: assistantDelta,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
          });
        }
      }

      const assistantCompletion =
        event.type === "item.completed" && event.payload.itemType === "assistant_message"
          ? {
              fallbackText: event.payload.detail,
            }
          : undefined;
      if (assistantCompletion) {
        const turnId = toTurnId(event.turnId);
        const assistantMessageId = yield* resolveAssistantCompletionMessageId({
          event,
          thread,
          ...(turnId ? { turnId } : {}),
        });
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }

        yield* finalizeAssistantMessage({
          event,
          threadId: thread.id,
          messageId: assistantMessageId,
          ...(turnId ? { turnId } : {}),
          createdAt: now,
          commandTag: "assistant-complete",
          finalDeltaCommandTag: "assistant-delta-finalize",
          ...(assistantCompletion.fallbackText !== undefined
            ? { fallbackText: assistantCompletion.fallbackText }
            : {}),
        });

        if (turnId) {
          yield* forgetAssistantMessageId(thread.id, turnId, assistantMessageId);
        }
      }

      const generatedImagePath = generatedImagePathFromRuntimeEvent(event);
      if (generatedImagePath) {
        const generatedImageTurnId = toTurnId(event.turnId) ?? activeTurnId ?? undefined;
        if (generatedImageTurnId) {
          // Defer the transcript reference to turn settle (see the flush helper); the
          // "Generated image" work row already surfaces progress mid-turn.
          yield* rememberPendingGeneratedImage(thread.id, generatedImageTurnId, generatedImagePath);
        } else {
          // No turn to correlate with: attach immediately to the same provider item
          // (replay) or an existing reference, else a standalone image-only message.
          const messages = thread.messages;
          const sameItemMessageId = event.itemId
            ? MessageId.makeUnsafe(`assistant:${event.itemId}`)
            : undefined;
          const markdown = generatedImageMarkdown(generatedImagePath);
          const targetMessage = messages.find(
            (message) =>
              message.role === "assistant" &&
              (message.id === sameItemMessageId ||
                message.text.includes(generatedImagePath) ||
                message.text.includes(markdown)),
          );
          yield* appendGeneratedImagesToAssistantMessage({
            event,
            threadId: thread.id,
            targetMessage,
            newMessageId: MessageId.makeUnsafe(`assistant:image:${event.itemId ?? event.eventId}`),
            imagePaths: [generatedImagePath],
            createdAt: now,
          });
        }
      }

      if (isTerminalTurnEvent) {
        const finalizedTurnId = eventTurnId ?? activeTurnId ?? undefined;
        if (finalizedTurnId) {
          const assistantMessageIds = yield* getAssistantMessageIdsForTurn(
            thread.id,
            finalizedTurnId,
          );
          yield* Effect.forEach(assistantMessageIds, (assistantMessageId) =>
            finalizeAssistantMessage({
              event,
              threadId: thread.id,
              messageId: assistantMessageId,
              turnId: finalizedTurnId,
              createdAt: now,
              commandTag: "assistant-complete-finalize",
              finalDeltaCommandTag: "assistant-delta-finalize-fallback",
            }),
          );
          yield* clearAssistantMessageIdsForTurn(thread.id, finalizedTurnId);

          // After finalization the turn's terminal assistant message is settled;
          // hand it the images the turn produced (an artifact-only turn's final
          // message is intentionally empty — the image markdown becomes its body).
          yield* flushPendingGeneratedImagesForTurn({
            event,
            thread,
            turnId: finalizedTurnId,
            createdAt: now,
          });
        }
      }

      if (event.type === "session.exited") {
        yield* clearOutstandingTurns(thread.id);
        const exitedTurnId = eventTurnId ?? activeTurnId ?? undefined;
        if (exitedTurnId) {
          yield* finalizeBufferedAssistantMessagesForTurn({
            event,
            threadId: thread.id,
            turnId: exitedTurnId,
            createdAt: now,
            commandTag: "assistant-complete-session-exit",
            finalDeltaCommandTag: "assistant-delta-session-exit",
          });
          // Images produced before the session died are real; surface them now.
          yield* flushPendingGeneratedImagesForTurn({
            event,
            thread,
            turnId: exitedTurnId,
            createdAt: now,
          });
        }
        yield* clearTurnStateForSession(thread.id);
      }

      if (event.type === "runtime.error") {
        const runtimeErrorMessage =
          asString(runtimePayloadRecord(event)?.message) ?? "Provider runtime error";
        const erroredTurnId = eventTurnId ?? activeTurnId ?? undefined;

        if (erroredTurnId) {
          yield* finalizeBufferedAssistantMessagesForTurn({
            event,
            threadId: thread.id,
            turnId: erroredTurnId,
            createdAt: now,
            commandTag: "assistant-complete-runtime-error",
            finalDeltaCommandTag: "assistant-delta-runtime-error",
          });
          yield* flushPendingGeneratedImagesForTurn({
            event,
            thread,
            turnId: erroredTurnId,
            createdAt: now,
          });
        }

        const shouldApplyRuntimeError = !STRICT_PROVIDER_LIFECYCLE_GUARD
          ? true
          : activeTurnId === null || eventTurnId === undefined || sameId(activeTurnId, eventTurnId);

        if (shouldApplyRuntimeError) {
          yield* dispatchProviderCommandOnce({
            type: "thread.session.set",
            commandId: providerCommandId(event, "runtime-error-session-set", thread.id),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "error",
              providerName: event.provider,
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: eventTurnId ?? null,
              lastError: runtimeErrorMessage,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      if (event.type === "thread.metadata.updated" && event.payload.name) {
        yield* dispatchProviderCommandOnce({
          type: "thread.meta.update",
          commandId: providerCommandId(event, "thread-meta-update", thread.id),
          threadId: thread.id,
          title: event.payload.name,
        });
      }

      const activityEvent =
        event.type === "item.completed" && reasoningSummaryKey
          ? withBufferedReasoningSummary(
              event,
              yield* takeBufferedReasoningSummary(reasoningSummaryKey),
            )
          : event.type === "item.completed" && toolOutputKey
            ? withBufferedToolOutputData(event, yield* takeBufferedToolOutput(toolOutputKey))
            : event.type === "item.updated" && toolOutputKey
              ? withBufferedToolOutputData(event, yield* getBufferedToolOutput(toolOutputKey))
              : event;
      const canonicalActivityEvent =
        activityEvent.threadId === thread.id
          ? activityEvent
          : ({ ...activityEvent, threadId: thread.id } as ProviderRuntimeEvent);
      const canonicalOperationMaterialized =
        canonicalOperationFromRuntimeEvent(canonicalActivityEvent) !== null;
      const canonicalNoticeMaterialized = canonicalActivityEvent.type === "runtime.warning";
      yield* commitCanonical(canonicalActivityEvent);
      if (canonicalOperationMaterialized || canonicalNoticeMaterialized) {
        yield* dispatchProviderCommandOnce({
          type: "thread.activity-read-model.touch",
          commandId: providerCommandId(
            canonicalActivityEvent,
            "activity-read-model-touch",
            thread.id,
          ),
          threadId: thread.id,
          turnId: canonicalActivityEvent.turnId ?? null,
          createdAt: canonicalActivityEvent.createdAt,
        });
      }
      yield* Effect.forEach(projectProviderRuntimeActivities(activityEvent), (activity) =>
        canonicalOperationMaterialized || canonicalNoticeMaterialized
          ? Effect.void
          : dispatchActivityUpdate(activityEvent, thread.id, activity),
      );

      if (isTerminalTurnEvent) {
        yield* settleBufferedReasoningSummaries(thread.id, event, toTurnId(event.turnId));
      } else if (event.type === "session.exited") {
        yield* settleBufferedReasoningSummaries(thread.id, event);
      } else if (event.type === "runtime.error") {
        yield* settleBufferedReasoningSummaries(
          thread.id,
          event,
          eventTurnId ?? activeTurnId ?? undefined,
        );
      }

      // Exact-turn delivery modes deliberately survive terminal events for a
      // bounded TTL: providers may send late item/delta events after settlement.
      // Unbound request/turn state is safe to clear when a session ends before
      // the two sides can be matched.
      if (event.type === "session.exited" || event.type === "runtime.error") {
        yield* clearAssistantDeliveryModeBindingsForThread(thread.id);
      }
    });

  const processDomainEvent = (event: RuntimeIngestionDomainEvent) =>
    Effect.gen(function* () {
      if (event.type === "thread.conversation-rolled-back") {
        yield* clearActivityUpdateFingerprints(event.payload.threadId);
        yield* clearAssistantDeliveryModeBindingsForThread(event.payload.threadId);
        yield* clearOutstandingTurns(event.payload.threadId);
        return;
      }
      const nextAssistantDeliveryMode =
        event.payload.assistantDeliveryMode ?? DEFAULT_ASSISTANT_DELIVERY_MODE;
      const thread = Option.getOrUndefined(
        yield* projectionSnapshotQuery.getThreadShellById(event.payload.threadId),
      );
      const isNativeSteer =
        event.payload.dispatchMode === "steer" &&
        providerSupportsNativeTurnSteering(
          thread?.session?.providerName ?? thread?.modelSelection.provider ?? "",
        );
      let deliveryTurnId: TurnId | undefined;
      if (isNativeSteer) {
        let activeTurnId = thread?.session?.activeTurnId ?? undefined;
        if (!activeTurnId) {
          const runtimeSession = (yield* providerService.listSessions()).find(
            (session) => session.threadId === event.payload.threadId,
          );
          activeTurnId = toTurnId(runtimeSession?.activeTurnId);
        }
        if (!activeTurnId) {
          return;
        }
        deliveryTurnId = activeTurnId;
        yield* Cache.set(
          assistantDeliveryModeByTurnKey,
          providerTurnKey(event.payload.threadId, activeTurnId),
          nextAssistantDeliveryMode,
        );
      } else {
        deliveryTurnId = yield* matchAssistantDeliveryModeRequest(
          event.payload.threadId,
          nextAssistantDeliveryMode,
        );
      }
      if (!deliveryTurnId || nextAssistantDeliveryMode !== "streaming") {
        return;
      }

      const flushEvent: ProviderRuntimeEvent = {
        type: "turn.started",
        eventId: event.eventId,
        provider: thread?.session?.providerName === "claudeAgent" ? "claudeAgent" : "codex",
        createdAt: event.payload.createdAt,
        threadId: event.payload.threadId,
        turnId: deliveryTurnId,
        payload: {},
      };
      yield* flushBufferedAssistantMessagesForTurn({
        event: flushEvent,
        threadId: event.payload.threadId,
        turnId: deliveryTurnId,
        createdAt: event.payload.createdAt,
        commandTag: "assistant-delta-domain-flush",
      });
    });

  const processInput = (input: RuntimeIngestionInput): Effect.Effect<void, unknown> => {
    if (input.source !== "runtime") return processDomainEvent(input.event);
    let canonicalEvent: ProviderRuntimeEvent | undefined;
    return processRuntimeEvent(input.event, (event) =>
      Effect.sync(() => {
        canonicalEvent = event;
      }),
    ).pipe(
      Effect.andThen(
        sql.withTransaction(
          Effect.gen(function* () {
            if (canonicalEvent !== undefined) {
              yield* commitCanonicalRuntimeEvent(canonicalEvent);
            }
            const advanced = yield* runtimeEvents.advanceThreadCursor({
              threadId: input.event.threadId,
              eventSequence: input.sequence,
              updatedAt: new Date().toISOString(),
            });
            if (!advanced) {
              return yield* Effect.die(
                new Error(
                  `Provider runtime thread cursor could not advance through event ${input.sequence}`,
                ),
              );
            }
          }),
        ),
      ),
    );
  };

  const projectionFailureFingerprint = (event: ProviderRuntimeEvent, detail: string) =>
    createHash("sha256")
      .update(`${event.type}\n${detail.slice(0, 16_384)}`)
      .digest("hex");

  const projectQuarantineAttention = (input: {
    readonly event: ProviderRuntimeEvent;
    readonly sequence: number;
    readonly errorFingerprint: string;
    readonly occurredAt: string;
  }) => {
    const quarantineEvent: ProviderRuntimeEvent = {
      type: "runtime.error",
      eventId: EventId.makeUnsafe(`projection-quarantine:${input.event.eventId}`),
      provider: input.event.provider,
      createdAt: input.occurredAt,
      threadId: input.event.threadId,
      ...(input.event.turnId !== undefined ? { turnId: input.event.turnId } : {}),
      payload: {
        message:
          "Penkra paused this thread after a runtime event repeatedly failed to load. Other threads can continue safely.",
        class: "validation_error",
        detail: {
          sequence: input.sequence,
          eventId: input.event.eventId,
          eventType: input.event.type,
          errorFingerprint: input.errorFingerprint,
        },
      },
    };
    return processRuntimeEvent(quarantineEvent).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("provider runtime quarantine attention projection failed", {
          threadId: input.event.threadId,
          sequence: input.sequence,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  };

  // One failed thread head may be attempted only once per drain invocation.
  // That gives transient dependencies time to recover while allowing every
  // unrelated thread head in the same journal window to make progress.
  let runtimeThreadsBlockedThisDrain = new Set<string>();

  const processInputSafely = (input: RuntimeIngestionInput): Effect.Effect<void> =>
    input.source === "runtime" && runtimeThreadsBlockedThisDrain.has(input.event.threadId)
      ? Effect.void
      : processInput(input).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.interrupt;
            }
            if (input.source !== "runtime") {
              return Effect.logWarning("provider runtime ingestion failed to process event", {
                source: input.source,
                eventId: input.event.eventId,
                eventType: input.event.type,
                cause: Cause.pretty(cause),
              });
            }
            runtimeThreadsBlockedThisDrain.add(input.event.threadId);
            const failedAt = new Date().toISOString();
            const errorDetail = Cause.pretty(cause);
            const errorFingerprint = projectionFailureFingerprint(input.event, errorDetail);
            return runtimeEvents
              .recordProjectionFailure({
                sequence: input.sequence,
                errorFingerprint,
                errorDetail,
                failedAt,
              })
              .pipe(
                Effect.flatMap((failure) =>
                  (failure.status === "quarantined"
                    ? projectQuarantineAttention({
                        event: input.event,
                        sequence: input.sequence,
                        errorFingerprint,
                        occurredAt: failure.quarantinedAt ?? failedAt,
                      })
                    : Effect.void
                  ).pipe(
                    Effect.andThen(
                      failure.status === "quarantined"
                        ? Effect.logError("provider runtime projection quarantined a thread head", {
                            threadId: input.event.threadId,
                            turnId: input.event.turnId,
                            sequence: input.sequence,
                            eventId: input.event.eventId,
                            eventType: input.event.type,
                            attemptCount: failure.attemptCount,
                            errorFingerprint,
                            errorDetail,
                          })
                        : Effect.logWarning(
                            "provider runtime projection will retry a failed thread head",
                            {
                              threadId: input.event.threadId,
                              turnId: input.event.turnId,
                              sequence: input.sequence,
                              eventId: input.event.eventId,
                              eventType: input.event.type,
                              attemptCount: failure.attemptCount,
                              errorFingerprint,
                              errorDetail,
                            },
                          ),
                    ),
                  ),
                ),
                Effect.catchCause((recordCause) =>
                  Effect.logError("provider runtime projection failure could not be recorded", {
                    threadId: input.event.threadId,
                    sequence: input.sequence,
                    originalCause: errorDetail,
                    recordCause: Cause.pretty(recordCause),
                  }),
                ),
              );
          }),
        );

  const worker = yield* makeDrainableWorker(processInputSafely, {
    capacity: PROVIDER_RUNTIME_INGESTION_CAPACITY,
  });
  const runtimeJournalDrainLock = yield* Semaphore.make(1);

  const drainRuntimeJournalThrough = (throughSequenceInclusive?: number) =>
    runtimeJournalDrainLock.withPermits(1)(
      Effect.gen(function* () {
        const replayFence = throughSequenceInclusive ?? (yield* runtimeEvents.getHighWaterSequence);
        runtimeThreadsBlockedThisDrain = new Set<string>();
        while (true) {
          const page = yield* runtimeEvents.readPendingThreadHeads({
            throughSequenceInclusive: replayFence,
            limit: PROVIDER_RUNTIME_REPLAY_PAGE_SIZE,
          });
          if (page.length === 0) return;

          const processablePage = page.filter(
            (entry) => !runtimeThreadsBlockedThisDrain.has(entry.event.threadId),
          );
          if (processablePage.length === 0) return;

          yield* Effect.forEach(processablePage, (entry) =>
            worker.enqueue({
              source: "runtime",
              sequence: entry.sequence,
              event: entry.event,
            }),
          );
          yield* worker.drain;
        }
      }),
    );

  const drainRuntimeJournal = drainRuntimeJournalThrough();

  const drainRuntimeJournalSafely = drainRuntimeJournal.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
      return Effect.logWarning("provider runtime journal drain failed", {
        cause: Cause.pretty(cause),
      });
    }),
  );

  const reconcileSettledOpenTurns: ProviderRuntimeIngestionShape["reconcileSettledOpenTurns"] =
    runtimeEvents.pruneSettledOpenTurns.pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        return Effect.logWarning("provider runtime open-turn cleanup failed", {
          cause: Cause.pretty(cause),
        });
      }),
    );

  const prepareAcceptedRuntimeEventReplay = Effect.fnUntraced(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (
      event.type !== "content.delta" ||
      event.payload.streamKind !== "assistant_text" ||
      event.turnId === undefined
    ) {
      return;
    }
    const turnId = toTurnId(event.turnId);
    if (!turnId) return;
    const turnKey = providerTurnKey(event.threadId, turnId);
    if (Option.isSome(yield* Cache.getOption(assistantDeliveryModeByTurnKey, turnKey))) {
      return;
    }
    const messageId = MessageId.makeUnsafe(
      `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
    );
    const streamingReceipt = yield* commandReceipts.getByCommandId({
      commandId: providerCommandId(event, "assistant-delta", messageId),
    });
    yield* Cache.set(
      assistantDeliveryModeByTurnKey,
      turnKey,
      Option.isSome(streamingReceipt) ? "streaming" : "buffered",
    );
  });

  // Accepted rows have already completed every durable effect. Startup replay
  // therefore rebuilds only the bounded process-local aggregators that a later
  // terminal event may consume. Re-running the full event projector here is
  // both semantically wrong (a previously inert notification can become a new
  // command after a code change) and catastrophically expensive on long-lived
  // turns because it drives thousands of redundant SQLite transactions before
  // the server can become ready.
  const rebuildAcceptedRuntimeAggregation = Effect.fnUntraced(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (event.type === "content.delta") {
      const itemKey = event.itemId
        ? [event.threadId, event.turnId ?? "no-turn", event.itemId].join(":")
        : null;
      if (
        itemKey &&
        (event.payload.streamKind === "command_output" ||
          event.payload.streamKind === "file_change_output") &&
        event.payload.delta.length > 0
      ) {
        yield* appendBufferedToolOutput(itemKey, event.payload.delta);
      }

      const reasoningKey = reasoningSummaryBufferKey(event);
      if (reasoningKey && event.payload.delta.length > 0) {
        yield* appendBufferedReasoningSummary(reasoningKey, event);
      }

      if (event.payload.streamKind === "assistant_text" && event.payload.delta.length > 0) {
        yield* prepareAcceptedRuntimeEventReplay(event);
        const messageId = MessageId.makeUnsafe(
          `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
        );
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          yield* rememberAssistantMessageId(event.threadId, turnId, messageId);
        }
        const deliveryMode = yield* getAssistantDeliveryMode(event.threadId, turnId);
        if (deliveryMode === "buffered") {
          // A non-empty return value was already durably spilled during the
          // original projection. Ignoring it here intentionally leaves only
          // the post-spill suffix in memory for the eventual completion event.
          yield* appendBufferedAssistantText(messageId, event.payload.delta);
        }
      }
      return;
    }
  });

  const rebuildAcceptedOpenTurnState = Effect.gen(function* () {
    let sequence = 0;
    const blockedThreadIds = new Set<ThreadId>();
    while (true) {
      const page = yield* runtimeEvents.readAcceptedOpenTurnEvents({
        consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
        sequenceExclusive: sequence,
        limit: PROVIDER_RUNTIME_REPLAY_PAGE_SIZE,
      });
      if (page.length === 0) return;
      for (const entry of page) {
        if (!blockedThreadIds.has(entry.event.threadId)) {
          yield* rebuildAcceptedRuntimeAggregation(entry.event).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
              blockedThreadIds.add(entry.event.threadId);
              return Effect.logError(
                "provider runtime accepted-state rebuild isolated a failed thread",
                {
                  threadId: entry.event.threadId,
                  turnId: entry.event.turnId,
                  sequence: entry.sequence,
                  eventId: entry.event.eventId,
                  eventType: entry.event.type,
                  cause: Cause.pretty(cause),
                },
              );
            }),
          );
        }
        sequence = entry.sequence;
      }
      if (page.length < PROVIDER_RUNTIME_REPLAY_PAGE_SIZE) return;
    }
  });

  const restoreQuarantinedThreadAttention = Effect.gen(function* () {
    const failures = yield* runtimeEvents.listQuarantinedProjectionFailures;
    yield* Effect.forEach(
      failures,
      (failure) =>
        runtimeEvents
          .readAfter({
            sequenceExclusive: Math.max(0, failure.sequence - 1),
            throughSequenceInclusive: failure.sequence,
            limit: 1,
          })
          .pipe(
            Effect.flatMap((rows) => {
              const persisted = rows.find((row) => row.sequence === failure.sequence);
              if (!persisted) {
                return Effect.logError("provider runtime quarantined event is missing", {
                  threadId: failure.threadId,
                  sequence: failure.sequence,
                  eventId: failure.eventId,
                });
              }
              return projectQuarantineAttention({
                event: persisted.event,
                sequence: failure.sequence,
                errorFingerprint: failure.errorFingerprint,
                occurredAt: failure.quarantinedAt ?? failure.lastFailedAt,
              });
            }),
          ),
      { concurrency: 1 },
    );
  });

  // Quarantine isolates a poison head from unrelated threads during one runtime, but it must not
  // become a permanent data-loss boundary after an upgrade or restart has fixed the projector.
  // Give every preserved quarantined head one startup retry. A still-invalid head remains isolated
  // and returns to quarantine through the normal bounded retry policy; a healed head drains its
  // complete retained tail without an operator having to know about the internal failure ledger.
  const releaseQuarantinedThreadsForStartupRetry = Effect.gen(function* () {
    const failures = yield* runtimeEvents.listQuarantinedProjectionFailures;
    const releasedAt = new Date().toISOString();
    yield* Effect.forEach(
      failures,
      (failure) =>
        runtimeEvents
          .releaseQuarantinedThread({
            threadId: failure.threadId,
            releasedAt,
          })
          .pipe(
            Effect.tap((released) =>
              released
                ? Effect.log("released quarantined provider runtime head for startup retry", {
                    threadId: failure.threadId,
                    sequence: failure.sequence,
                    eventId: failure.eventId,
                    errorFingerprint: failure.errorFingerprint,
                  })
                : Effect.void,
            ),
          ),
      { concurrency: 1 },
    );
  });
  const startupRuntimeReplayComplete = yield* Deferred.make<void>();

  const start: ProviderRuntimeIngestionShape["start"] = startDrainableWorkerProducers(
    worker,
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Stream.runForEach(providerService.streamEvents, (event) =>
          runtimeEvents.append(event).pipe(
            Effect.flatMap((persisted) =>
              Deferred.await(startupRuntimeReplayComplete).pipe(
                Effect.andThen(drainRuntimeJournalThrough(persisted.sequence)),
              ),
            ),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("provider runtime event journal ingestion failed", {
                    eventId: event.eventId,
                    eventType: event.type,
                    cause: Cause.pretty(cause),
                  }),
            ),
          ),
        ),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (
            event.type !== "thread.turn-start-requested" &&
            event.type !== "thread.conversation-rolled-back"
          ) {
            return Effect.void;
          }
          return Deferred.await(startupRuntimeReplayComplete).pipe(
            Effect.andThen(worker.enqueue({ source: "domain", event })),
          );
        }),
      );
      // A previous startup reconciliation can leave a durable turn terminal
      // while the runtime replay ledger still calls it open. Replaying that
      // stale row can reuse a command id with a payload derived from the newer
      // terminal projection, so remove settled rows before rebuilding
      // process-local state.
      yield* runtimeEvents.pruneSettledOpenTurns;
      yield* rebuildAcceptedOpenTurnState;
      yield* releaseQuarantinedThreadsForStartupRetry;
      yield* drainRuntimeJournal;
      // Only heads that failed their startup retry should retain/recreate the
      // user-visible quarantine attention state.
      yield* restoreQuarantinedThreadAttention;
      yield* Deferred.succeed(startupRuntimeReplayComplete, undefined);
      yield* Effect.forkScoped(
        Effect.sleep(PROVIDER_RUNTIME_REPLAY_POLL_INTERVAL).pipe(
          Effect.andThen(drainRuntimeJournalSafely),
          Effect.forever,
        ),
      );
    }),
  ).pipe(Effect.orDie);

  const drainThroughCurrentHighWater = Effect.gen(function* () {
    const replayFence = yield* runtimeEvents.getHighWaterSequence;
    yield* drainRuntimeJournalThrough(replayFence);
    yield* worker.drain;
  }).pipe(Effect.orDie);

  return {
    start,
    reconcileSettledOpenTurns,
    drain: drainThroughCurrentHighWater,
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make,
).pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectionTurnRepositoryLive,
      ProviderRuntimeEventRepositoryLive,
      OrchestrationCommandReceiptRepositoryLive,
    ),
  ),
);
