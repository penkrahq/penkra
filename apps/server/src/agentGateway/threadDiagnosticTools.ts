import {
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@penkra/contracts";
import { Effect, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ThreadDiagnosticsQueryShape } from "../diagnostics/Services/ThreadDiagnosticsQuery.ts";
import {
  PROVIDER_COMMAND_REACTOR_CONSUMER,
  type OrchestrationEventDeliveryRepositoryShape,
} from "../persistence/Services/OrchestrationEventDeliveries.ts";
import type { OrchestrationEventStoreShape } from "../persistence/Services/OrchestrationEventStore.ts";
import {
  PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED,
  type ProviderRuntimeEventRepositoryShape,
} from "../persistence/Services/ProviderRuntimeEvents.ts";
import {
  decodeDiagnosticCursor,
  diagnosticFilterFingerprint,
  encodeDiagnosticCursor,
} from "./diagnosticCursor.ts";
import { sanitizeDiagnosticValue } from "./diagnosticSanitizer.ts";
import {
  groupDiagnosticEvents,
  readDiagnosticPageLimit,
  shapeDiagnosticEvents,
} from "./threadDiagnosticSummary.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { summarizeThreadDetail } from "./threadSummary.ts";
import {
  errorText,
  readBooleanArg,
  readStringArg,
  readStringArrayArg,
  ToolInputError,
} from "./toolInput.ts";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolEntry,
} from "./toolRuntime.ts";

const DIAGNOSTIC_EVENT_SCAN_CHUNK_SIZE = 250;
const DIAGNOSTIC_EVENT_MAX_COALESCING_SCAN = 10_000;

export function makeThreadDiagnosticTools(input: {
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly diagnostics: ThreadDiagnosticsQueryShape;
  readonly eventStore: OrchestrationEventStoreShape;
  readonly providerRuntimeEvents: ProviderRuntimeEventRepositoryShape;
  readonly eventDeliveries: OrchestrationEventDeliveryRepositoryShape;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, unknown, never>;
}): ReadonlyArray<ToolEntry> {
  const readActivity: ToolEntry = {
    requiredCapability: "diagnostics:read",
    definition: {
      name: "penkra_read_thread_activity",
      description:
        "Use after penkra_read_thread when you need the user-facing work log behind a turn: tool calls, approvals, status, and other projected activity. This is the least detailed diagnostic source and returns stable newest-last pages; use penkra_read_thread_events for durable command/event evidence, penkra_read_thread_runtime_events for raw provider evidence, or penkra_diagnose_thread when the thread is malfunctioning and you need a bounded cross-source assessment.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "string",
            description: "Exact Penkra thread id whose projected activity should be read.",
          },
          cursor: {
            type: "string",
            description: "Opaque nextCursor from the preceding activity page.",
          },
          limit: { type: "number", description: "Rows per page; default 50, maximum 200." },
          turnId: { type: "string", description: "Only activity for this exact Penkra turn id." },
          kinds: {
            type: "array",
            items: { type: "string" },
            description: "Only these exact projected activity kinds.",
          },
          includeDetails: {
            type: "boolean",
            description: "Include bounded, redacted activity payloads.",
          },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: { title: "Read thread activity", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        yield* input.requireThreadShell(threadId);
        const turnId = readStringArg(args, "turnId") ?? null;
        const kinds = readStringArrayArg(args, "kinds") ?? [];
        const filterFingerprint = diagnosticFilterFingerprint({ turnId, kinds });
        const cursor = decodeDiagnosticCursor(readStringArg(args, "cursor"), {
          kind: "activity",
          threadId,
          filterFingerprint,
        });
        const requestedLimit = readDiagnosticPageLimit(args);
        const includeDetails = readBooleanArg(args, "includeDetails") ?? false;
        const limit = includeDetails ? Math.min(requestedLimit, 50) : requestedLimit;
        const activityCoverage = yield* input.diagnostics.getActivityCoverage(threadId);
        const highWaterSequence = cursor?.highWaterSequence ?? activityCoverage.highWaterSequence;
        const rows = yield* input.diagnostics.listActivities({
          threadId,
          throughSequenceInclusive: highWaterSequence,
          ...(cursor ? { beforeSequenceExclusive: cursor.beforeSequence } : {}),
          limit: limit + 1,
          ...(turnId ? { turnId } : {}),
          ...(kinds.length > 0 ? { kinds } : {}),
        });
        const page = rows.slice(0, limit);
        const oldest = page[page.length - 1];
        return mcpToolResultJson({
          threadId,
          activities: page
            .map((row) => ({
              sequence: row.sequence,
              activityId: row.activityId,
              turnId: row.turnId,
              tone: row.tone,
              kind: row.kind,
              summary: row.summary,
              createdAt: row.createdAt,
              ...(includeDetails ? { detail: sanitizeDiagnosticValue(row.payload) } : {}),
            }))
            .reverse(),
          coverage: {
            source: "projection_thread_activities",
            highWaterSequence,
            sourceComplete: activityCoverage.unsequencedCount === 0,
            unsequencedCount: activityCoverage.unsequencedCount,
            pageHasOlder: rows.length > limit,
          },
          ...(limit !== requestedLimit ? { requestedLimit, appliedLimit: limit } : {}),
          ...(rows.length > limit && oldest
            ? {
                nextCursor: encodeDiagnosticCursor({
                  version: 1,
                  kind: "activity",
                  threadId,
                  filterFingerprint,
                  highWaterSequence,
                  beforeSequence: oldest.sequence,
                }),
              }
            : {}),
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const readEvents: ToolEntry = {
    requiredCapability: "diagnostics:read",
    definition: {
      name: "penkra_read_thread_events",
      description:
        "Use when projected activity is insufficient and you need Penkra's durable orchestration journal: accepted commands, lifecycle transitions, and exact event ordering. Consecutive updates for one message are coalesced without crossing intervening events. Use penkra_read_thread_activity for the readable work log, penkra_read_thread_runtime_events for provider-native evidence, or penkra_diagnose_thread for a bounded cross-source diagnosis.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "string",
            description: "Exact Penkra thread id whose durable events should be read.",
          },
          cursor: {
            type: "string",
            description: "Opaque nextCursor from the preceding durable-event page.",
          },
          limit: { type: "number", description: "Events per page; default 50, maximum 200." },
          eventTypes: {
            type: "array",
            items: { type: "string" },
            description: "Only these exact orchestration event types.",
          },
          payloadMode: {
            type: "string",
            enum: ["none", "summary", "full"],
            description:
              "Payload detail: none omits payloads, summary returns bounded fields (default), full returns bounded redacted payloads.",
          },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: { title: "Read thread events", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        yield* input.requireThreadShell(threadId);
        const eventTypes = readStringArrayArg(args, "eventTypes") ?? [];
        const filterFingerprint = diagnosticFilterFingerprint({ eventTypes });
        const cursor = decodeDiagnosticCursor(readStringArg(args, "cursor"), {
          kind: "event",
          threadId,
          filterFingerprint,
        });
        const requestedLimit = readDiagnosticPageLimit(args);
        const payloadModeRaw = readStringArg(args, "payloadMode") ?? "summary";
        if (
          payloadModeRaw !== "none" &&
          payloadModeRaw !== "summary" &&
          payloadModeRaw !== "full"
        ) {
          throw new ToolInputError('Argument "payloadMode" must be "none", "summary", or "full".');
        }
        const limit = payloadModeRaw === "full" ? Math.min(requestedLimit, 25) : requestedLimit;
        const highWaterSequence =
          cursor?.highWaterSequence ??
          (yield* input.eventStore.getThreadHighWaterSequence(threadId));
        const scannedEvents: OrchestrationEvent[] = [];
        let scanBeforeSequence = cursor?.beforeSequence;
        let coalescingScanTruncated = false;
        while (scannedEvents.length < DIAGNOSTIC_EVENT_MAX_COALESCING_SCAN) {
          const scanLimit = Math.min(
            DIAGNOSTIC_EVENT_SCAN_CHUNK_SIZE,
            DIAGNOSTIC_EVENT_MAX_COALESCING_SCAN - scannedEvents.length,
          );
          const chunk = yield* input.eventStore.readThreadEvents({
            threadId,
            throughSequenceInclusive: highWaterSequence,
            ...(scanBeforeSequence !== undefined
              ? { beforeSequenceExclusive: scanBeforeSequence }
              : {}),
            limit: scanLimit,
            ...(eventTypes.length > 0 ? { eventTypes } : {}),
          });
          scannedEvents.push(...chunk);
          if (chunk.length < scanLimit) break;
          scanBeforeSequence = chunk[chunk.length - 1]?.sequence;
          if (groupDiagnosticEvents(scannedEvents).length > limit) break;
          if (scannedEvents.length === DIAGNOSTIC_EVENT_MAX_COALESCING_SCAN) {
            coalescingScanTruncated = true;
          }
        }
        const logicalEvents = shapeDiagnosticEvents(scannedEvents, payloadModeRaw);
        const page = logicalEvents.slice(-limit);
        const pageHasOlder = logicalEvents.length > limit || coalescingScanTruncated;
        const returnedGroups = groupDiagnosticEvents(scannedEvents).slice(0, limit);
        const returnedBoundarySequence = returnedGroups[returnedGroups.length - 1]?.oldestSequence;
        const nextBeforeSequence =
          coalescingScanTruncated && logicalEvents.length <= limit
            ? scannedEvents[scannedEvents.length - 1]?.sequence
            : returnedBoundarySequence;
        return mcpToolResultJson({
          threadId,
          events: page,
          coverage: {
            source: "orchestration_events",
            highWaterSequence,
            durableSourceComplete: true,
            pageHasOlder,
            ...(coalescingScanTruncated ? { coalescingScanTruncated: true } : {}),
          },
          ...(limit !== requestedLimit ? { requestedLimit, appliedLimit: limit } : {}),
          ...(pageHasOlder && nextBeforeSequence !== undefined
            ? {
                nextCursor: encodeDiagnosticCursor({
                  version: 1,
                  kind: "event",
                  threadId,
                  filterFingerprint,
                  highWaterSequence,
                  beforeSequence: nextBeforeSequence,
                }),
              }
            : {}),
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const readRuntimeEvents: ToolEntry = {
    requiredCapability: "diagnostics:read",
    definition: {
      name: "penkra_read_thread_runtime_events",
      description:
        "Use only when durable Penkra events do not explain provider behavior and you need retained provider-native runtime evidence. The response reports bounded global-retention coverage, so absence is not proof an event never occurred. Prefer penkra_read_thread_activity for readable history, penkra_read_thread_events for durable Penkra events, and penkra_diagnose_thread for a bounded cross-source diagnosis.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "string",
            description: "Exact Penkra thread id whose retained provider events should be read.",
          },
          cursor: {
            type: "string",
            description: "Opaque nextCursor from the preceding provider-event page.",
          },
          limit: { type: "number", description: "Events per page; default 50, maximum 200." },
          turnId: { type: "string", description: "Only events for this exact Penkra turn id." },
          eventTypes: {
            type: "array",
            items: { type: "string" },
            description: "Only these exact provider-runtime event types.",
          },
          includeDetails: {
            type: "boolean",
            description: "Include bounded, redacted provider event fields, including raw metadata.",
          },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: { title: "Read thread runtime events", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        yield* input.requireThreadShell(threadId);
        const turnId = readStringArg(args, "turnId") ?? null;
        const eventTypes = readStringArrayArg(args, "eventTypes") ?? [];
        const filterFingerprint = diagnosticFilterFingerprint({ turnId, eventTypes });
        const cursor = decodeDiagnosticCursor(readStringArg(args, "cursor"), {
          kind: "runtime",
          threadId,
          filterFingerprint,
        });
        const requestedLimit = readDiagnosticPageLimit(args);
        const includeDetails = readBooleanArg(args, "includeDetails") ?? false;
        const limit = includeDetails ? Math.min(requestedLimit, 25) : requestedLimit;
        const runtimeCoverage = yield* input.providerRuntimeEvents.getThreadCoverage(threadId);
        const highWaterSequence = cursor?.highWaterSequence ?? runtimeCoverage.highWaterSequence;
        const rows = yield* input.providerRuntimeEvents.readThreadEvents({
          threadId,
          throughSequenceInclusive: highWaterSequence,
          ...(cursor ? { beforeSequenceExclusive: cursor.beforeSequence } : {}),
          limit: limit + 1,
          ...(turnId ? { turnId } : {}),
          ...(eventTypes.length > 0 ? { eventTypes } : {}),
        });
        const page = rows.slice(0, limit);
        const oldest = page[page.length - 1];
        return mcpToolResultJson({
          threadId,
          events: page
            .map(({ sequence, event }) => ({
              sequence,
              eventId: event.eventId,
              type: event.type,
              provider: event.provider,
              turnId: event.turnId ?? null,
              itemId: event.itemId ?? null,
              requestId: event.requestId ?? null,
              createdAt: event.createdAt,
              ...(includeDetails ? { detail: sanitizeDiagnosticValue(event) } : {}),
            }))
            .reverse(),
          coverage: {
            source: "provider_runtime_events",
            highWaterSequence,
            oldestRetainedSequence: runtimeCoverage.oldestSequence,
            retainedForThread: runtimeCoverage.retainedCount,
            globalAcceptedEventCap: PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED,
            sourceComplete: false,
            pageHasOlder: rows.length > limit,
          },
          ...(limit !== requestedLimit ? { requestedLimit, appliedLimit: limit } : {}),
          ...(rows.length > limit && oldest
            ? {
                nextCursor: encodeDiagnosticCursor({
                  version: 1,
                  kind: "runtime",
                  threadId,
                  filterFingerprint,
                  highWaterSequence,
                  beforeSequence: oldest.sequence,
                }),
              }
            : {}),
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const diagnoseThread: ToolEntry = {
    requiredCapability: "diagnostics:read",
    definition: {
      name: "penkra_diagnose_thread",
      description:
        "Use when a Penkra thread appears stuck, inconsistent, or failed and you need one bounded cross-source assessment before reading raw evidence. It combines projected status, recent messages/activity, durable events, delivery blockers, and stream incidents, and reports when deeper activity, event, or runtime-event reads are warranted. Do not use it as a routine transcript reader.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "string",
            description: "Exact Penkra thread id to diagnose across projection and event sources.",
          },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: { title: "Diagnose a Penkra thread", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        yield* input.requireThreadShell(threadId);
        const detail = yield* input.snapshotQuery
          .getThreadDetailById(ThreadId.makeUnsafe(threadId))
          .pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(new ToolInputError(`Thread "${threadId}" was not found.`)),
                onSome: Effect.succeed,
              }),
            ),
          );
        const [
          activityCoverage,
          eventHighWater,
          runtimeCoverage,
          runtimeThreadCursor,
          runtimeProjectionFailure,
          blockers,
          incidents,
        ] = yield* Effect.all([
          input.diagnostics.getActivityCoverage(threadId),
          input.eventStore.getThreadHighWaterSequence(threadId),
          input.providerRuntimeEvents.getThreadCoverage(threadId),
          input.providerRuntimeEvents.getThreadCursor(threadId),
          input.providerRuntimeEvents.getThreadProjectionFailure(threadId),
          input.eventDeliveries.listBlockingDeliveries({
            consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
            threadId,
            limit: 20,
          }),
          input.diagnostics.listOperationalDiagnostics({ threadId, limit: 50 }),
        ]);
        const [activities, events, runtimeEvents] = yield* Effect.all([
          input.diagnostics.listActivities({
            threadId,
            throughSequenceInclusive: activityCoverage.highWaterSequence,
            limit: 50,
          }),
          input.eventStore.readThreadEvents({
            threadId,
            throughSequenceInclusive: eventHighWater,
            limit: 100,
          }),
          input.providerRuntimeEvents.readThreadEvents({
            threadId,
            throughSequenceInclusive: runtimeCoverage.highWaterSequence,
            limit: 100,
          }),
        ]);
        const findings = [
          ...(detail.session?.lastError
            ? [
                {
                  severity: "error",
                  code: "provider_session_error",
                  detail: detail.session.lastError,
                },
              ]
            : []),
          ...blockers.map((blocker) => ({
            severity: "error",
            code: "provider_delivery_blocked",
            detail: `Event ${blocker.eventSequence} is ${blocker.state} after ${blocker.attemptCount} attempt(s).`,
          })),
          ...(runtimeProjectionFailure
            ? [
                {
                  severity: runtimeProjectionFailure.status === "quarantined" ? "error" : "warning",
                  code: `provider_runtime_projection_${runtimeProjectionFailure.status}`,
                  detail: `Runtime event ${runtimeProjectionFailure.sequence} (${runtimeProjectionFailure.eventType}) failed projection ${runtimeProjectionFailure.attemptCount} time(s).`,
                },
              ]
            : []),
          ...incidents
            .filter((incident) => incident.severity !== "info")
            .map((incident) => ({
              severity: incident.severity,
              code: incident.code ?? incident.kind,
              detail: incident.detail,
            })),
        ];
        return mcpToolResultJson({
          thread: summarizeThreadDetail({
            thread: detail,
            messageLimit: 20,
            maxMessageChars: 2_000,
          }),
          findings,
          recentActivity: activities
            .map((activity) => ({
              sequence: activity.sequence,
              turnId: activity.turnId,
              kind: activity.kind,
              tone: activity.tone,
              summary: activity.summary,
              createdAt: activity.createdAt,
            }))
            .reverse(),
          recentEvents: shapeDiagnosticEvents(events, "summary"),
          recentRuntimeEvents: runtimeEvents
            .map(({ sequence, event }) => ({
              sequence,
              eventId: event.eventId,
              type: event.type,
              provider: event.provider,
              turnId: event.turnId ?? null,
              itemId: event.itemId ?? null,
              requestId: event.requestId ?? null,
              createdAt: event.createdAt,
            }))
            .reverse(),
          providerDeliveryBlockers: blockers.map((blocker) => ({
            ...blocker,
            lastError: sanitizeDiagnosticValue(blocker.lastError),
            lastReconciliationNote: sanitizeDiagnosticValue(blocker.lastReconciliationNote),
          })),
          providerRuntimeProjection: {
            threadCursor: runtimeThreadCursor,
            failure: runtimeProjectionFailure
              ? {
                  ...runtimeProjectionFailure,
                  errorDetail: sanitizeDiagnosticValue(runtimeProjectionFailure.errorDetail),
                }
              : null,
          },
          operationalIncidents: incidents.map((incident) => ({
            ...incident,
            detail: sanitizeDiagnosticValue(incident.detail),
          })),
          coverage: {
            messages: { source: "projection_thread_messages", boundedToNewest: 2_000 },
            activity: {
              source: "projection_thread_activities",
              highWaterSequence: activityCoverage.highWaterSequence,
              sourceComplete: activityCoverage.unsequencedCount === 0,
              unsequencedCount: activityCoverage.unsequencedCount,
            },
            events: {
              source: "orchestration_events",
              highWaterSequence: eventHighWater,
              durableSourceComplete: true,
              returnedNewest: events.length,
            },
            operationalIncidents: {
              source: "operational_diagnostics",
              retentionDays: 30,
              globalCap: 10_000,
            },
            providerRuntimeRawEvents: {
              included: true,
              source: "provider_runtime_events",
              returnedNewest: runtimeEvents.length,
              highWaterSequence: runtimeCoverage.highWaterSequence,
              oldestRetainedSequence: runtimeCoverage.oldestSequence,
              retainedForThread: runtimeCoverage.retainedCount,
              globalAcceptedEventCap: PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED,
              sourceComplete: false,
              reason:
                "Accepted provider runtime events have bounded global retention. Quarantined thread heads are retained, but absence is not proof that an event never occurred.",
            },
          },
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const retryThreadProjection: ToolEntry = {
    requiredCapability: "thread:write",
    definition: {
      name: "penkra_retry_thread_projection",
      description:
        "Use only after penkra_diagnose_thread reports a quarantined provider-runtime head event. Releases that one preserved event for another projection attempt; it never skips or deletes evidence. If diagnosis does not name this recovery, inspect the reported blocker instead of retrying projection.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "string",
            description: "Exact Penkra thread id whose quarantined head event should be released.",
          },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: { title: "Retry thread projection", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        yield* input.requireThreadShell(threadId);
        const released = yield* input.providerRuntimeEvents.releaseQuarantinedThread({
          threadId,
          releasedAt: new Date().toISOString(),
        });
        return mcpToolResultJson({
          threadId,
          released,
          outcome: released
            ? "The preserved runtime event was released for retry."
            : "The thread has no quarantined runtime projection event.",
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  return [readActivity, readEvents, readRuntimeEvents, diagnoseThread, retryThreadProjection];
}
