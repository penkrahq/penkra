/** The only diagnostic values allowed to cross the spool boundary. */
import { INCIDENT_CODES } from "./codes";

export type DiagnosticScalar = string | number | boolean | null;
export type DiagnosticFields = Readonly<Record<string, DiagnosticScalar>>;

const idKeys = new Set([
  "threadId",
  "turnId",
  "providerTurnId",
  "commandId",
  "intentId",
  "windowId",
  "connectionId",
  "mcpRequestId",
  "traceId",
  "spanId",
  "parentSpanId",
  "attemptId",
  "bootId",
  "processId",
  "entityId",
  "setByTraceId",
  "blockedByThreadId",
  "activeTurnId",
  "callerTurnId",
  "providerSessionId",
]);
const enumValues = {
  flow: [
    "send",
    "stop",
    "play",
    "queue",
    "command_worker",
    "provider_delivery",
    "socket_connect",
    "mcp_write",
    "reconciliation",
    "archive",
    "thread_create",
    "window",
    "auth",
    "update",
    "database",
    "app",
    "boot",
    "shutdown",
  ],
  step: [
    "composer.preflight",
    "server.received",
    "server.starting",
    "server.ready",
    "command.accepted",
    "command.rejected",
    "command.queued",
    "command.dequeued",
    "worker.receipt_lookup",
    "worker.read_model",
    "worker.decider",
    "worker.transaction",
    "worker.deferred_projection",
    "worker.publication",
    "worker.reply",
    "worker.maintenance_lock_wait",
    "worker.completed",
    "provider.intent_claimed",
    "provider.call_started",
    "provider.call_accepted",
    "provider.call_rejected",
    "provider.call_timed_out",
    "provider.cursor_advanced",
    "provider.intent_settled",
    "provider.retry_scheduled",
    "provider.quarantined",
    "expectation.resolved",
    "expectation.missed",
    "expectation.unknown_after_restart",
  ],
  phase: ["spawn", "handshake", "resume", "request_accepted", "first_event", "terminal"],
  provider: ["codex", "claudeAgent", "opencode"],
  state: [
    "idle",
    "queued",
    "starting",
    "running",
    "stopping",
    "completed",
    "failed",
    "cancelled",
    "archived",
  ],
  outcome: ["ok", "rejected", "failed", "timed_out", "cancelled"],
  code: INCIDENT_CODES,
  process: ["server", "desktop-main", "renderer", "provider-child"],
  source: ["server", "browser", "desktop", "agent", "reactor", "provider"],
  kind: [
    "command.rejected",
    "command.failed",
    "expectation.missed",
    "limit.exceeded",
    "timeout",
    "invariant.violated",
    "external.failed",
    "external.slow",
    "process.unresponsive",
    "process.crashed",
    "recovery.performed",
    "diagnostics.degraded",
  ],
  field: [
    "thread.activeTurnId",
    "turn.state",
    "queue.entry",
    "session.binding",
    "thread.archived",
    "connection.state",
  ],
  check: [
    "active_turn",
    "binding_revision",
    "thread_exists",
    "thread_archived",
    "provider_state",
    "queue_order",
    "deadline",
  ],
  errorCode: [
    "EACCES",
    "ENOENT",
    "ENOSPC",
    "ETIMEDOUT",
    "ECONNREFUSED",
    "ECONNRESET",
    "EPIPE",
    "SQLITE_BUSY",
    "SQLITE_IOERR",
    "SQLITE_FULL",
    "OTHER",
  ],
  signal: ["SIGTERM", "SIGKILL", "SIGINT", "OTHER"],
  scope: ["thread", "turn", "connection", "window", "app", "global"],
  reason: ["deadline", "rejected", "disconnected", "crashed", "invalid_state", "unknown"],
  where: [
    "diagnostics.spool_import",
    "diagnostics.expectation",
    "orchestration.worker",
    "server.command",
    "server.provider",
    "server.ws_rpc",
    "provider.delivery",
  ],
  eventType: ["checkpoint", "external_outcome", "expectation_resolved"],
  callerTurnSource: ["foreground", "background-task-notification", "agent", "reactor"],
  providerState: ["idle", "starting", "running", "stopping", "completed", "failed"],
} as const;
const allowedEnumValues: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(
  Object.entries(enumValues).map(([key, values]) => [key, new Set<string>(values)]),
);
const numericKeys = new Set([
  "elapsedMs",
  "deadlineMs",
  "observedMs",
  "budgetMs",
  "queueDepth",
  "oldestQueuedMs",
  "count",
  "bytes",
  "sizeBytes",
  "eventLoopLagMs",
  "cpuPct",
  "rssMb",
  "heapMb",
  "freeMemMb",
  "diskFreeMb",
  "machineLoad1m",
  "openHandles",
  "pid",
  "exitCode",
  "revision",
  "attempt",
  "sequence",
  "maxSilenceMs",
  "silenceMs",
  "deliveryQueueDepth",
  "holdMs",
]);
const booleanKeys = new Set(["alive", "providerPidAlive", "connected", "accepted"]);
const timestampKeys = new Set(["at", "setAt", "firstAt", "lastAt"]);
const generatedId = /^[a-zA-Z0-9._:-]{1,160}$/u;
const enumValue = /^[a-zA-Z][a-zA-Z0-9._:-]{0,79}$/u;

/** Reject unknown keys and free-form strings rather than trying to redact them. */
export function validateDiagnosticFields(value: DiagnosticFields): DiagnosticFields {
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError("Diagnostic fields must be a plain object");
  }
  const safe: Record<string, DiagnosticScalar> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null) {
      safe[key] = null;
    } else if (idKeys.has(key) && typeof item === "string" && generatedId.test(item)) {
      safe[key] = item;
    } else if (typeof item === "string" && allowedEnumValues[key]?.has(item)) {
      safe[key] = item;
    } else if (numericKeys.has(key) && typeof item === "number" && Number.isFinite(item)) {
      safe[key] = item;
    } else if (booleanKeys.has(key) && typeof item === "boolean") {
      safe[key] = item;
    } else if (
      timestampKeys.has(key) &&
      typeof item === "string" &&
      !Number.isNaN(Date.parse(item))
    ) {
      safe[key] = new Date(item).toISOString();
    } else {
      throw new TypeError(`Diagnostic field ${key} is not allowlisted`);
    }
  }
  return safe;
}

export function validateDiagnosticId(value: string): string {
  if (!generatedId.test(value)) throw new TypeError("Invalid diagnostic identifier");
  return value;
}

export function validateDiagnosticToken(value: string, field?: keyof typeof enumValues): string {
  if (!enumValue.test(value) || (field && !allowedEnumValues[field]?.has(value))) {
    throw new TypeError(`Invalid diagnostic ${field ?? "token"}`);
  }
  return value;
}
