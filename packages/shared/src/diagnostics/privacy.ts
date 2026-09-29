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
  "eventId",
  "reportId",
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
    "server.boot_stage_failed",
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
    "provider.continuation_verification_started",
    "provider.continuation_verification_succeeded",
    "provider.continuation_verification_failed",
    "provider.runtime_warning_active",
    "provider.runtime_warning_resolved",
    "reconciliation.detected",
    "reconciliation.repair_started",
    "reconciliation.repair_applied",
    "socket.handshake_started",
    "socket.handshake_open",
    "socket.handshake_failed",
    "expectation.resolved",
    "expectation.missed",
    "expectation.unknown_after_restart",
    "mcp.request_received",
    "mcp.authority_rejected",
    "send.dispatched",
    "send.accepted",
    "stop.requested",
    "turn.terminal",
    "play.requested",
    "turn.started",
    "queue.enqueued",
    "queue.started",
    "archive.requested",
    "thread.archived",
    "window.opened",
    "window.synced",
    "thread.create_requested",
    "thread.created",
    "socket.disconnected",
    "socket.reconnected",
    "provider.switch_requested",
    "provider.switched",
  ],
  phase: ["spawn", "handshake", "resume", "request_accepted", "first_event", "terminal"],
  provider: ["codex", "claudeAgent", "opencode"],
  providerEventType: [
    "session.started",
    "session.configured",
    "session.state.changed",
    "session.exited",
    "thread.started",
    "thread.state.changed",
    "thread.metadata.updated",
    "thread.token-usage.updated",
    "thread.realtime.started",
    "thread.realtime.item-added",
    "thread.realtime.audio.delta",
    "thread.realtime.error",
    "thread.realtime.closed",
    "turn.started",
    "turn.completed",
    "turn.aborted",
    "turn.tasks.updated",
    "turn.steered",
    "item.started",
    "item.updated",
    "item.completed",
    "content.delta",
    "request.opened",
    "request.resolved",
    "user-input.requested",
    "user-input.resolved",
    "task.started",
    "task.progress",
    "task.updated",
    "task.completed",
    "hook.started",
    "hook.progress",
    "hook.completed",
    "tool.progress",
    "tool.summary",
    "auth.status",
    "account.updated",
    "account.rate-limits.updated",
    "mcp.status.updated",
    "mcp.oauth.completed",
    "model.rerouted",
    "config.warning",
    "deprecation.notice",
    "files.persisted",
    "runtime.warning",
    "runtime.error",
  ],
  decodeField: ["type", "payload", "threadId", "turnId", "unknown"],
  mcpCheck: [
    "ingress_write_authority_missing",
    "caller_thread_lookup_failed",
    "active_execution_lookup_failed",
    "authorized_turn_no_longer_active",
  ],
  capability: ["thread:read", "thread:write", "diagnostics:read"],
  bootStage: [
    "provider-native-state-deletion.recover",
    "provider-connection-lifecycle.recover",
    "provider-connection-login.recover",
    "default-spaces.ensure",
    "http-runtime.start",
  ],
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
    "lease_exists",
    "delivery_matches",
    "sequence_delivered",
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
  reason: [
    "deadline",
    "late_resolution",
    "rejected",
    "disconnected",
    "crashed",
    "invalid_state",
    "unknown",
    "duplicate",
    "stream-capacity",
    "capacity",
    "sqlite",
    "spool",
    "stale",
    "invalid-record",
    "sequence-gap",
  ],
  where: [
    "diagnostics.spool_import",
    "diagnostics.expectation",
    "diagnostics.watchdog",
    "diagnostics.write",
    "diagnostics.worker_queue",
    "desktop.os_lookup",
    "orchestration.worker",
    "server.command",
    "server.provider",
    "server.ws_rpc",
    "server.sync_ack",
    "server.stream_admission",
    "provider.runtime_event_pump",
    "provider.runtime_journal",
    "server.boot",
    "agent.mcp_write",
    "provider.delivery",
    "provider.reconciliation",
    "browser.socket_connect",
    "browser.composer_attachment_cancel",
    "browser.composer_attachment_upload",
    "browser.composer_attachment_dispatch",
    "browser.composer_attachment_hydrate",
    "browser.socket_rpc",
    "browser.socket_stream",
    "browser.socket_listener",
    "browser.socket_cleanup",
  ],
  eventType: ["checkpoint", "external_outcome", "expectation_resolved"],
  callerTurnSource: ["foreground", "background-task-notification", "agent", "reactor"],
  providerState: ["idle", "starting", "running", "stopping", "completed", "failed"],
  verificationStage: [
    "validate-selection",
    "read-source-state",
    "decode-source-state",
    "clone-native-state",
    "read-clone-marker",
    "resolve-target-launch",
    "resolve-target-adapter",
    "initialize-target-resume",
    "validate-resumed-identity",
    "completed",
  ],
  recoveryAction: [
    "align-running-turn",
    "settle-interrupted",
    "settle-terminal-projection",
    "settle-error",
  ],
  entityKind: ["thread", "turn", "queue", "session", "connection"],
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
  "clientId",
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
    if (
      !idKeys.has(key) &&
      !Object.hasOwn(allowedEnumValues, key) &&
      !numericKeys.has(key) &&
      !booleanKeys.has(key) &&
      !timestampKeys.has(key)
    )
      throw new TypeError(`Diagnostic field ${key} is not allowlisted`);
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
