import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { isIncidentCode, type IncidentCode } from "./codes";
import { DIAGNOSTIC_LIMITS } from "./limits";
import {
  validateDiagnosticFields,
  validateDiagnosticId,
  validateDiagnosticToken,
  type DiagnosticFields,
} from "./privacy";

export interface DiagnosticsOptions {
  readonly stateDir: string;
  readonly appVersion: string;
  readonly process: "server" | "desktop-main" | "renderer" | "provider-child";
  readonly maxTotalBytes?: number;
  readonly maxSpoolBytes?: number;
}

export interface DiagnosticContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly commandId?: string;
}

export interface CheckpointInput extends DiagnosticContext {
  readonly flow: string;
  readonly step: string;
  readonly outcome?: "ok" | "rejected" | "failed" | "timed_out" | "cancelled";
  readonly elapsedMs?: number;
  readonly fields?: DiagnosticFields;
}

export interface ExternalOutcomeInput extends CheckpointInput {
  readonly outcome: NonNullable<CheckpointInput["outcome"]>;
  readonly elapsedMs: number;
}

export interface IncidentInput extends DiagnosticContext {
  readonly kind: string;
  readonly code: IncidentCode;
  readonly where: string;
  readonly severity: "error" | "warn";
  readonly expected?: DiagnosticFields;
  readonly actual?: DiagnosticFields;
  readonly context?: DiagnosticFields;
  readonly lastCheckpoint?: string;
}

export interface HealthSampleInput {
  readonly eventLoopLagMs: number;
  readonly queueDepth?: number;
  readonly oldestQueuedMs?: number;
}

export interface ProvenanceInput {
  readonly entityKind: "thread" | "turn" | "queue" | "session" | "connection";
  readonly entityId: string;
  readonly field: string;
  readonly traceId: string;
  readonly at?: string;
}

const EXPECTATION_CODES = {
  "send.accepted": "SEND_PREFLIGHT_REJECTED",
  "turn.started": "TURN_START_TIMEOUT",
  "turn.first_output": "TURN_OUTPUT_SILENT",
  "turn.output_continues": "TURN_OUTPUT_SILENT",
  "stop.terminal": "STOP_NOT_EFFECTIVE",
  "play.started": "PLAY_REJECTED",
  "archive.windows_closed": "ARCHIVED_THREAD_STILL_OPEN",
  "create.completed": "CREATE_TIMEOUT",
  "socket.connected": "WS_HANDSHAKE_SLOW",
} as const satisfies Record<string, IncidentCode>;

export type ExpectationKind = keyof typeof EXPECTATION_CODES;

export interface ExpectationInput extends DiagnosticContext {
  readonly kind: ExpectationKind;
  readonly deadlineMs: number;
  readonly correlation?: DiagnosticFields;
}

interface ExpectationArmInput extends ExpectationInput {
  readonly id: string;
}

interface HealthRecord {
  readonly eventLoopLagMs: number;
  readonly cpuPct: number;
  readonly rssMb: number;
  readonly heapMb: number;
  readonly openHandles: number;
  readonly queueDepth: number | null;
  readonly oldestQueuedMs: number | null;
  readonly machineLoad1m: number;
  readonly freeMemMb: number;
  readonly diskFreeMb: number;
}

interface ExpectationRow {
  id: string;
  kind: ExpectationKind;
  trace_id: string;
  span_id: string;
  attempt_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  correlation_json: string;
  armed_at: string;
  deadline_at: string;
  deadline_ms: number;
  last_checkpoint: string | null;
  boot_id: string;
}

function expectationFlow(kind: ExpectationKind): string {
  if (kind.startsWith("turn.") || kind.startsWith("send.")) return "send";
  if (kind.startsWith("stop.")) return "stop";
  if (kind.startsWith("play.")) return "play";
  if (kind.startsWith("archive.")) return "archive";
  if (kind.startsWith("create.")) return "thread_create";
  return "socket_connect";
}

interface SpoolEnvelope {
  readonly version: 1;
  readonly bootId: string;
  readonly sequence: number;
  readonly type:
    | "checkpoint"
    | "external_outcome"
    | "expectation_resolved"
    | "incident"
    | "expectation_arm"
    | "health";
  readonly at: string;
  readonly monoMs: number;
  readonly process: DiagnosticsOptions["process"];
  readonly data: CheckpointInput | IncidentInput | ExpectationArmInput | HealthRecord;
}

const SCHEMA = `
PRAGMA auto_vacuum=INCREMENTAL;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS detail (
  id INTEGER PRIMARY KEY, boot_id TEXT NOT NULL, sequence INTEGER NOT NULL,
  at TEXT NOT NULL, mono_ms REAL NOT NULL, event_type TEXT NOT NULL,
  flow TEXT NOT NULL, step TEXT NOT NULL, trace_id TEXT NOT NULL, span_id TEXT NOT NULL,
  parent_span_id TEXT, attempt_id TEXT, thread_id TEXT, turn_id TEXT, command_id TEXT,
  correlation_json TEXT NOT NULL, payload_json TEXT NOT NULL, pinned_until TEXT,
  UNIQUE(boot_id, sequence)
);
CREATE INDEX IF NOT EXISTS detail_trace_at ON detail(trace_id, at);
CREATE INDEX IF NOT EXISTS detail_thread_at ON detail(thread_id, at);
CREATE INDEX IF NOT EXISTS detail_command_id ON detail(command_id, at);
CREATE INDEX IF NOT EXISTS detail_at ON detail(at);
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
  code TEXT NOT NULL, severity TEXT NOT NULL, where_name TEXT NOT NULL,
  summary TEXT NOT NULL, trace_id TEXT NOT NULL, span_id TEXT NOT NULL,
  attempt_id TEXT, thread_id TEXT, turn_id TEXT, command_id TEXT,
  expected_json TEXT NOT NULL, actual_json TEXT NOT NULL, limit_json TEXT NOT NULL,
  context_json TEXT NOT NULL, provenance_json TEXT NOT NULL, health_json TEXT NOT NULL,
  last_checkpoint TEXT, count INTEGER NOT NULL, first_at TEXT NOT NULL,
  last_at TEXT NOT NULL, pin_from TEXT NOT NULL, pin_until TEXT NOT NULL,
  boot_id TEXT NOT NULL, env_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS incidents_last_at ON incidents(last_at, id);
CREATE INDEX IF NOT EXISTS incidents_thread_at ON incidents(thread_id, last_at);
CREATE INDEX IF NOT EXISTS incidents_trace_at ON incidents(trace_id, last_at);
CREATE INDEX IF NOT EXISTS incidents_kind_code_at ON incidents(kind, code, last_at);
CREATE TABLE IF NOT EXISTS expectations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL, attempt_id TEXT, thread_id TEXT, turn_id TEXT,
  correlation_json TEXT NOT NULL, armed_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL, deadline_ms INTEGER NOT NULL,
  last_checkpoint TEXT, boot_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS expectations_deadline ON expectations(deadline_at);
CREATE TABLE IF NOT EXISTS health (
  id INTEGER PRIMARY KEY, boot_id TEXT NOT NULL, process TEXT NOT NULL,
  at TEXT NOT NULL, event_loop_lag_ms REAL NOT NULL, cpu_pct REAL NOT NULL,
  rss_mb REAL NOT NULL, heap_mb REAL NOT NULL, open_handles INTEGER NOT NULL,
  queue_depth INTEGER, oldest_queued_ms REAL, machine_load_1m REAL NOT NULL,
  free_mem_mb REAL NOT NULL, disk_free_mb REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS health_process_at ON health(process, at);
CREATE TABLE IF NOT EXISTS provenance (
  entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, field TEXT NOT NULL,
  set_by_trace_id TEXT NOT NULL, set_at TEXT NOT NULL,
  PRIMARY KEY(entity_kind, entity_id, field)
);`;

function diagnosticsDir(stateDir: string): string {
  return path.join(stateDir, "diagnostics");
}

function totalBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
    if (!entry.isFile()) return sum;
    return sum + fs.statSync(path.join(dir, entry.name)).size;
  }, 0);
}

function withLifecycleLock<T>(dir: string, action: () => T): T {
  const lockDir = path.join(dir, ".lifecycle-lock");
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      fs.writeFileSync(path.join(lockDir, "pid"), String(process.pid), { mode: 0o600 });
      break;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      const ownerPath = path.join(lockDir, "pid");
      if (fs.existsSync(ownerPath)) {
        const ownerPid = Number(fs.readFileSync(ownerPath, "utf8"));
        try {
          if (Number.isInteger(ownerPid) && ownerPid > 0) process.kill(ownerPid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            fs.rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
        }
      }
      if (Date.now() >= deadline) throw new Error("Diagnostics lifecycle lock is busy");
      Atomics.wait(sleeper, 0, 0, 20);
    }
  }
  try {
    return action();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function sqlJson(fields: DiagnosticFields | undefined): string {
  return JSON.stringify(validateDiagnosticFields(fields ?? {}));
}

function validateContext(data: DiagnosticContext): void {
  validateDiagnosticId(data.traceId);
  validateDiagnosticId(data.spanId);
  for (const value of [
    data.parentSpanId,
    data.attemptId,
    data.threadId,
    data.turnId,
    data.commandId,
  ]) {
    if (value !== undefined) validateDiagnosticId(value);
  }
}

function prepareEnvelope(
  bootId: string,
  sequence: number,
  processName: DiagnosticsOptions["process"],
  type: SpoolEnvelope["type"],
  data: SpoolEnvelope["data"],
): SpoolEnvelope {
  if (type !== "health") validateContext(data as DiagnosticContext);
  validateDiagnosticId(bootId);
  if (!["server", "desktop-main", "renderer", "provider-child"].includes(processName)) {
    throw new TypeError("Invalid diagnostic process");
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1)
    throw new TypeError("Invalid spool sequence");
  let safeData: SpoolEnvelope["data"];
  if (type === "health") {
    const health = data as HealthRecord;
    const safe = validateDiagnosticFields({
      eventLoopLagMs: health.eventLoopLagMs,
      cpuPct: health.cpuPct,
      rssMb: health.rssMb,
      heapMb: health.heapMb,
      openHandles: health.openHandles,
      queueDepth: health.queueDepth,
      oldestQueuedMs: health.oldestQueuedMs,
      machineLoad1m: health.machineLoad1m,
      freeMemMb: health.freeMemMb,
      diskFreeMb: health.diskFreeMb,
    });
    if (Object.values(safe).some((value) => typeof value === "number" && value < 0))
      throw new TypeError("Negative health metric");
    safeData = safe as unknown as HealthRecord;
  } else if (type === "expectation_arm") {
    const expectation = data as ExpectationArmInput;
    validateDiagnosticId(expectation.id);
    if (!Object.hasOwn(EXPECTATION_CODES, expectation.kind))
      throw new TypeError("Unknown expectation kind");
    if (!Number.isSafeInteger(expectation.deadlineMs) || expectation.deadlineMs < 1)
      throw new TypeError("Invalid expectation deadline");
    safeData = {
      id: expectation.id,
      kind: expectation.kind,
      traceId: expectation.traceId,
      spanId: expectation.spanId,
      ...(expectation.attemptId ? { attemptId: expectation.attemptId } : {}),
      ...(expectation.threadId ? { threadId: expectation.threadId } : {}),
      ...(expectation.turnId ? { turnId: expectation.turnId } : {}),
      deadlineMs: expectation.deadlineMs,
      correlation: validateDiagnosticFields(expectation.correlation ?? {}),
    };
  } else if (type !== "incident") {
    const checkpoint = data as CheckpointInput;
    validateDiagnosticToken(checkpoint.flow, "flow");
    validateDiagnosticToken(checkpoint.step, "step");
    sqlJson(checkpoint.fields);
    if (
      checkpoint.elapsedMs !== undefined &&
      (!Number.isFinite(checkpoint.elapsedMs) || checkpoint.elapsedMs < 0)
    ) {
      throw new TypeError("Invalid checkpoint duration");
    }
    if (
      checkpoint.outcome !== undefined &&
      !["ok", "rejected", "failed", "timed_out", "cancelled"].includes(checkpoint.outcome)
    ) {
      throw new TypeError("Invalid checkpoint outcome");
    }
    if (
      type === "external_outcome" &&
      (checkpoint.outcome === undefined || checkpoint.elapsedMs === undefined)
    ) {
      throw new TypeError("External outcomes require outcome and duration");
    }
    safeData = {
      traceId: checkpoint.traceId,
      spanId: checkpoint.spanId,
      ...(checkpoint.parentSpanId ? { parentSpanId: checkpoint.parentSpanId } : {}),
      ...(checkpoint.attemptId ? { attemptId: checkpoint.attemptId } : {}),
      ...(checkpoint.threadId ? { threadId: checkpoint.threadId } : {}),
      ...(checkpoint.turnId ? { turnId: checkpoint.turnId } : {}),
      ...(checkpoint.commandId ? { commandId: checkpoint.commandId } : {}),
      flow: checkpoint.flow,
      step: checkpoint.step,
      ...(checkpoint.outcome ? { outcome: checkpoint.outcome } : {}),
      ...(checkpoint.elapsedMs === undefined ? {} : { elapsedMs: checkpoint.elapsedMs }),
      fields: validateDiagnosticFields(checkpoint.fields ?? {}),
    };
  } else {
    const incident = data as IncidentInput;
    if (!isIncidentCode(incident.code)) throw new TypeError("Unregistered incident code");
    validateDiagnosticToken(incident.kind, "kind");
    validateDiagnosticToken(incident.where, "where");
    if (incident.lastCheckpoint) validateDiagnosticToken(incident.lastCheckpoint, "step");
    sqlJson(incident.expected);
    sqlJson(incident.actual);
    sqlJson(incident.context);
    if (incident.severity !== "error" && incident.severity !== "warn") {
      throw new TypeError("Invalid incident severity");
    }
    safeData = {
      traceId: incident.traceId,
      spanId: incident.spanId,
      ...(incident.parentSpanId ? { parentSpanId: incident.parentSpanId } : {}),
      ...(incident.attemptId ? { attemptId: incident.attemptId } : {}),
      ...(incident.threadId ? { threadId: incident.threadId } : {}),
      ...(incident.turnId ? { turnId: incident.turnId } : {}),
      ...(incident.commandId ? { commandId: incident.commandId } : {}),
      kind: incident.kind,
      code: incident.code,
      where: incident.where,
      severity: incident.severity,
      expected: validateDiagnosticFields(incident.expected ?? {}),
      actual: validateDiagnosticFields(incident.actual ?? {}),
      context: validateDiagnosticFields(incident.context ?? {}),
      ...(incident.lastCheckpoint ? { lastCheckpoint: incident.lastCheckpoint } : {}),
    };
  }
  return {
    version: 1,
    bootId,
    sequence,
    type,
    at: new Date().toISOString(),
    monoMs: performance.now(),
    process: processName,
    data: safeData,
  };
}

function insertEnvelope(database: DatabaseSync, event: SpoolEnvelope, appVersion: string): void {
  const receiptKey = `last-sequence:${event.bootId}`;
  const lastSequence = database.prepare("SELECT value FROM meta WHERE key = ?").get(receiptKey) as
    | { value: string }
    | undefined;
  if (lastSequence && Number(lastSequence.value) >= event.sequence) return;
  if (event.type === "health") {
    const health = event.data as HealthRecord;
    database
      .prepare(`INSERT INTO health (
      boot_id, process, at, event_loop_lag_ms, cpu_pct, rss_mb, heap_mb,
      open_handles, queue_depth, oldest_queued_ms, machine_load_1m, free_mem_mb, disk_free_mb
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        event.bootId,
        event.process,
        event.at,
        health.eventLoopLagMs,
        health.cpuPct,
        health.rssMb,
        health.heapMb,
        health.openHandles,
        health.queueDepth,
        health.oldestQueuedMs,
        health.machineLoad1m,
        health.freeMemMb,
        health.diskFreeMb,
      );
  } else if (event.type === "expectation_arm") {
    const expectation = event.data as ExpectationArmInput;
    const last = database
      .prepare("SELECT step FROM detail WHERE trace_id = ? ORDER BY id DESC LIMIT 1")
      .get(expectation.traceId) as { step: string } | undefined;
    database
      .prepare(`INSERT OR IGNORE INTO expectations (
      id, kind, trace_id, span_id, attempt_id, thread_id, turn_id, correlation_json,
      armed_at, deadline_at, deadline_ms, last_checkpoint, boot_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        expectation.id,
        expectation.kind,
        expectation.traceId,
        expectation.spanId,
        expectation.attemptId ?? null,
        expectation.threadId ?? null,
        expectation.turnId ?? null,
        sqlJson(expectation.correlation),
        event.at,
        new Date(Date.parse(event.at) + expectation.deadlineMs).toISOString(),
        expectation.deadlineMs,
        last?.step ?? null,
        event.bootId,
      );
  } else if (event.type !== "incident") {
    const data = event.data as CheckpointInput;
    const pin = database
      .prepare(
        "SELECT MAX(pin_until) AS until FROM incidents WHERE pin_from <= ? AND pin_until >= ?",
      )
      .get(event.at, event.at) as { until: string | null };
    database
      .prepare(`INSERT OR IGNORE INTO detail (
      boot_id, sequence, at, mono_ms, event_type, flow, step, trace_id, span_id,
      parent_span_id, attempt_id, thread_id, turn_id, command_id, correlation_json,
      payload_json, pinned_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        event.bootId,
        event.sequence,
        event.at,
        event.monoMs,
        event.type,
        data.flow,
        data.step,
        data.traceId,
        data.spanId,
        data.parentSpanId ?? null,
        data.attemptId ?? null,
        data.threadId ?? null,
        data.turnId ?? null,
        data.commandId ?? null,
        "{}",
        sqlJson({
          ...(data.outcome ? { outcome: data.outcome } : {}),
          ...(data.elapsedMs === undefined ? {} : { elapsedMs: data.elapsedMs }),
          ...data.fields,
        }),
        pin.until,
      );
  } else {
    const data = event.data as IncidentInput;
    const provenance = database
      .prepare(`SELECT field, set_by_trace_id, set_at FROM provenance
      WHERE (entity_kind = 'thread' AND entity_id = ?)
         OR (entity_kind = 'session' AND entity_id = ?)
         OR (entity_kind = 'turn' AND entity_id = ?)
      ORDER BY field`)
      .all(data.threadId ?? "", data.threadId ?? "", data.turnId ?? "") as Array<{
      field: string;
      set_by_trace_id: string;
      set_at: string;
    }>;
    const provenanceJson = JSON.stringify(
      provenance.map((row) => ({
        field: row.field,
        setByTraceId: row.set_by_trace_id,
        setAt: row.set_at,
      })),
    );
    const nearestHealth = database
      .prepare(`SELECT at, event_loop_lag_ms, cpu_pct, rss_mb,
      heap_mb, open_handles, queue_depth, oldest_queued_ms, machine_load_1m,
      free_mem_mb, disk_free_mb FROM health WHERE process = ? AND at <= ?
      ORDER BY at DESC LIMIT 1`)
      .get(event.process, event.at) as
      | {
          at: string;
          event_loop_lag_ms: number;
          cpu_pct: number;
          rss_mb: number;
          heap_mb: number;
          open_handles: number;
          queue_depth: number | null;
          oldest_queued_ms: number | null;
          machine_load_1m: number;
          free_mem_mb: number;
          disk_free_mb: number;
        }
      | undefined;
    const healthJson = nearestHealth
      ? JSON.stringify({
          at: nearestHealth.at,
          eventLoopLagMs: nearestHealth.event_loop_lag_ms,
          cpuPct: nearestHealth.cpu_pct,
          rssMb: nearestHealth.rss_mb,
          heapMb: nearestHealth.heap_mb,
          openHandles: nearestHealth.open_handles,
          queueDepth: nearestHealth.queue_depth,
          oldestQueuedMs: nearestHealth.oldest_queued_ms,
          machineLoad1m: nearestHealth.machine_load_1m,
          freeMemMb: nearestHealth.free_mem_mb,
          diskFreeMb: nearestHealth.disk_free_mb,
        })
      : "{}";
    const fingerprint = JSON.stringify([
      data.kind,
      data.code,
      data.where,
      data.threadId ?? null,
      data.context?.bootId ?? null,
      data.context?.check ?? null,
      data.context?.reason ?? null,
      data.context?.providerEventType ?? null,
      data.actual?.errorCode ?? null,
    ]);
    const from = new Date(Date.parse(event.at) - DIAGNOSTIC_LIMITS.detailPinBeforeMs).toISOString();
    const until = new Date(Date.parse(event.at) + DIAGNOSTIC_LIMITS.detailPinAfterMs).toISOString();
    database
      .prepare(`INSERT INTO incidents (
      id, fingerprint, kind, code, severity, where_name, summary, trace_id, span_id,
      attempt_id, thread_id, turn_id, command_id, expected_json, actual_json,
      limit_json, context_json, provenance_json, health_json, last_checkpoint,
      count, first_at, last_at, pin_from, pin_until, boot_id, env_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET count=count+1, last_at=excluded.last_at,
      actual_json=excluded.actual_json, context_json=excluded.context_json,
      provenance_json=excluded.provenance_json, health_json=excluded.health_json,
      last_checkpoint=excluded.last_checkpoint, pin_until=excluded.pin_until`)
      .run(
        randomUUID(),
        fingerprint,
        data.kind,
        data.code,
        data.severity,
        data.where,
        data.code,
        data.traceId,
        data.spanId,
        data.attemptId ?? null,
        data.threadId ?? null,
        data.turnId ?? null,
        data.commandId ?? null,
        sqlJson(data.expected),
        sqlJson(data.actual),
        "{}",
        sqlJson(data.context),
        provenanceJson,
        healthJson,
        data.lastCheckpoint ?? null,
        1,
        event.at,
        event.at,
        from,
        until,
        event.bootId,
        JSON.stringify({ appVersion, process: event.process }),
      );
    database
      .prepare(`UPDATE detail SET pinned_until = ?
      WHERE at >= ? AND at <= ? AND (pinned_until IS NULL OR pinned_until < ?)`)
      .run(until, from, until, until);
  }
  database
    .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
    .run(receiptKey, String(event.sequence));
}

/** A local diagnostics writer. Spool append is synced before the SQLite write. */
export class DiagnosticsStore {
  readonly bootId = randomBytes(16).toString("hex");
  private readonly reportedProcessFailures = new Set<string>();
  private lastCpuUsage = process.cpuUsage();
  private lastHealthAt = performance.now();
  private lastHealthThinAt = 0;
  readonly dir: string;
  readonly dbPath: string;
  readonly spoolPath: string;
  private readonly activePath: string;
  private readonly database: DatabaseSync;
  private readonly maxTotalBytes: number;
  private readonly maxSpoolBytes: number;
  private sequence = 0;

  constructor(private readonly options: DiagnosticsOptions) {
    if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/u.test(options.appVersion)) {
      throw new TypeError("Invalid app version");
    }
    this.dir = diagnosticsDir(options.stateDir);
    this.dbPath = path.join(this.dir, "diagnostics.sqlite");
    this.spoolPath = path.join(this.dir, `spool-${this.bootId}.jsonl`);
    this.activePath = path.join(this.dir, `active-${this.bootId}.json`);
    this.maxTotalBytes = options.maxTotalBytes ?? DIAGNOSTIC_LIMITS.totalBytes;
    this.maxSpoolBytes = options.maxSpoolBytes ?? DIAGNOSTIC_LIMITS.spoolBytesPerProcess;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(this.dir, 0o700);
    this.database = withLifecycleLock(this.dir, () => {
      const versionPath = path.join(this.dir, "version");
      const oldVersion = fs.existsSync(versionPath) ? fs.readFileSync(versionPath, "utf8") : null;
      if (oldVersion !== options.appVersion) {
        for (const entry of fs.readdirSync(this.dir)) {
          if (entry !== ".lifecycle-lock")
            fs.rmSync(path.join(this.dir, entry), { recursive: true, force: true });
        }
      }
      const createdDatabase = !fs.existsSync(this.dbPath);
      const db = new DatabaseSync(this.dbPath);
      db.exec(SCHEMA);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '1')").run();
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('app_version', ?)").run(
        options.appVersion,
      );
      if (oldVersion !== options.appVersion || createdDatabase) {
        db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('reset_at', ?)").run(
          new Date().toISOString(),
        );
        fs.writeFileSync(versionPath, options.appVersion, { mode: 0o600 });
      }
      return db;
    });
    const crashedProcesses = this.importSpools();
    fs.writeFileSync(
      this.activePath,
      JSON.stringify({ pid: process.pid, process: options.process }),
      { mode: 0o600 },
    );
    this.sweepExpectations(new Date(), true);
    if (crashedProcesses > 0) {
      this.incident({
        traceId: randomBytes(16).toString("hex"),
        spanId: randomBytes(8).toString("hex"),
        kind: "process.crashed",
        code: "UNCLEAN_SHUTDOWN",
        where: "diagnostics.spool_import",
        severity: "warn",
        actual: { count: crashedProcesses },
      });
    }
  }

  private assertCurrentVersion(): void {
    if (fs.readFileSync(path.join(this.dir, "version"), "utf8") !== this.options.appVersion) {
      throw new Error("Diagnostics store belongs to a newer app version");
    }
  }

  private importSpools(): number {
    return withLifecycleLock(this.dir, () => {
      let crashedProcesses = 0;
      for (const entry of fs.readdirSync(this.dir)) {
        if (!/^spool-[a-f0-9]{32}\.jsonl$/u.test(entry) || entry === path.basename(this.spoolPath))
          continue;
        const bootId = entry.slice(6, -6);
        const activePath = path.join(this.dir, `active-${bootId}.json`);
        const closedPath = path.join(this.dir, `closed-${bootId}.json`);
        let live = false;
        if (fs.existsSync(activePath)) {
          try {
            const owner = JSON.parse(fs.readFileSync(activePath, "utf8")) as { pid: number };
            process.kill(owner.pid, 0);
            live = true;
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "ESRCH") continue;
          }
        }
        const spoolPath = path.join(this.dir, entry);
        const lines = fs.readFileSync(spoolPath, "utf8").split("\n");
        this.database.exec("BEGIN IMMEDIATE");
        try {
          for (const line of lines) {
            if (!line) continue;
            let event: SpoolEnvelope;
            try {
              event = JSON.parse(line) as SpoolEnvelope;
              if (event.version !== 1 || event.bootId !== bootId) continue;
              if (
                ![
                  "checkpoint",
                  "external_outcome",
                  "expectation_resolved",
                  "incident",
                  "expectation_arm",
                  "health",
                ].includes(event.type)
              )
                continue;
              if (!Number.isFinite(Date.parse(event.at)) || !Number.isFinite(event.monoMs))
                continue;
              const safe = prepareEnvelope(
                event.bootId,
                event.sequence,
                event.process,
                event.type,
                event.data,
              );
              event = { ...safe, at: new Date(event.at).toISOString(), monoMs: event.monoMs };
            } catch {
              continue; // Torn final line or invalid/unallowlisted payload.
            }
            insertEnvelope(this.database, event, this.options.appVersion);
          }
          this.database.exec("COMMIT");
        } catch (cause) {
          this.database.exec("ROLLBACK");
          throw cause;
        }
        if (live) {
          fs.truncateSync(spoolPath, 0);
        } else {
          fs.rmSync(spoolPath, { force: true });
          fs.rmSync(activePath, { force: true });
          if (!fs.existsSync(closedPath)) crashedProcesses++;
          fs.rmSync(closedPath, { force: true });
        }
      }
      for (const entry of fs.readdirSync(this.dir)) {
        if (!/^active-[a-f0-9]{32}\.json$/u.test(entry) || entry === path.basename(this.activePath))
          continue;
        const activePath = path.join(this.dir, entry);
        try {
          const owner = JSON.parse(fs.readFileSync(activePath, "utf8")) as { pid: number };
          process.kill(owner.pid, 0);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ESRCH") continue;
          fs.rmSync(activePath, { force: true });
          crashedProcesses++;
        }
      }
      return crashedProcesses;
    });
  }

  importPeerSpools(): number {
    this.assertCurrentVersion();
    const crashed = this.importSpools();
    if (crashed > 0)
      this.incident({
        traceId: randomBytes(16).toString("hex"),
        spanId: randomBytes(8).toString("hex"),
        kind: "process.crashed",
        code: "UNCLEAN_SHUTDOWN",
        where: "diagnostics.spool_import",
        severity: "warn",
        actual: { count: crashed },
      });
    return crashed;
  }

  private write(type: SpoolEnvelope["type"], data: CheckpointInput | IncidentInput): void {
    this.assertCurrentVersion();
    this.prune();
    const event = prepareEnvelope(this.bootId, ++this.sequence, this.options.process, type, data);
    const line = `${JSON.stringify(event)}\n`;
    const bytes = Buffer.byteLength(line);
    const currentSpoolBytes = fs.existsSync(this.spoolPath) ? fs.statSync(this.spoolPath).size : 0;
    if (
      currentSpoolBytes + bytes > this.maxSpoolBytes ||
      totalBytes(this.dir) + bytes > this.maxTotalBytes
    ) {
      throw new Error("Diagnostics capacity reached");
    }
    const handle = fs.openSync(this.spoolPath, "a", 0o600);
    try {
      fs.writeSync(handle, line);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      // A prior SQLite failure leaves its synced spool line in place. Replay
      // every line before truncating; receipts make a crash after commit safe.
      for (const serialized of fs.readFileSync(this.spoolPath, "utf8").split("\n")) {
        if (!serialized) continue;
        const pending = JSON.parse(serialized) as SpoolEnvelope;
        if (
          pending.version !== 1 ||
          pending.bootId !== this.bootId ||
          ![
            "checkpoint",
            "external_outcome",
            "expectation_resolved",
            "incident",
            "expectation_arm",
            "health",
          ].includes(pending.type)
        ) {
          throw new Error("Current diagnostics spool is invalid");
        }
        const safe = prepareEnvelope(
          pending.bootId,
          pending.sequence,
          pending.process,
          pending.type,
          pending.data,
        );
        insertEnvelope(
          this.database,
          {
            ...safe,
            at: new Date(pending.at).toISOString(),
            monoMs: pending.monoMs,
          },
          this.options.appVersion,
        );
      }
      this.database.exec("COMMIT");
    } catch (cause) {
      this.database.exec("ROLLBACK");
      throw cause;
    }
    fs.truncateSync(this.spoolPath, 0);
    this.prune();
  }

  checkpoint(data: CheckpointInput): void {
    this.write("checkpoint", data);
  }

  externalOutcome(data: ExternalOutcomeInput): void {
    this.write("external_outcome", data);
  }

  incident(data: IncidentInput): void {
    this.write("incident", data);
  }

  setProvenance(input: ProvenanceInput): void {
    this.assertCurrentVersion();
    if (!["thread", "turn", "queue", "session", "connection"].includes(input.entityKind)) {
      throw new TypeError("Invalid provenance entity kind");
    }
    validateDiagnosticId(input.entityId);
    validateDiagnosticId(input.traceId);
    validateDiagnosticToken(input.field, "field");
    const at = input.at === undefined ? new Date().toISOString() : new Date(input.at).toISOString();
    this.database
      .prepare(`INSERT INTO provenance (
      entity_kind, entity_id, field, set_by_trace_id, set_at
    ) VALUES (?, ?, ?, ?, ?) ON CONFLICT(entity_kind, entity_id, field)
    DO UPDATE SET set_by_trace_id = excluded.set_by_trace_id, set_at = excluded.set_at`)
      .run(input.entityKind, input.entityId, input.field, input.traceId, at);
  }

  sampleHealth(input: HealthSampleInput): void {
    this.assertCurrentVersion();
    const metrics = validateDiagnosticFields({
      eventLoopLagMs: input.eventLoopLagMs,
      ...(input.queueDepth === undefined ? {} : { queueDepth: input.queueDepth }),
      ...(input.oldestQueuedMs === undefined ? {} : { oldestQueuedMs: input.oldestQueuedMs }),
    });
    if (Object.values(metrics).some((value) => typeof value === "number" && value < 0)) {
      throw new TypeError("Negative health metric");
    }
    const now = performance.now();
    const usage = process.cpuUsage(this.lastCpuUsage);
    this.lastCpuUsage = process.cpuUsage();
    const elapsedMs = Math.max(1, now - this.lastHealthAt);
    this.lastHealthAt = now;
    const memory = process.memoryUsage();
    const disk = fs.statfsSync(this.options.stateDir);
    const handles = (
      process as NodeJS.Process & { _getActiveHandles?: () => unknown[] }
    )._getActiveHandles?.();
    this.database
      .prepare(`INSERT INTO health (
      boot_id, process, at, event_loop_lag_ms, cpu_pct, rss_mb, heap_mb,
      open_handles, queue_depth, oldest_queued_ms, machine_load_1m, free_mem_mb, disk_free_mb
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        this.bootId,
        this.options.process,
        new Date().toISOString(),
        input.eventLoopLagMs,
        ((usage.user + usage.system) / (elapsedMs * 1_000)) * 100,
        memory.rss / 1_048_576,
        memory.heapUsed / 1_048_576,
        handles?.length ?? 0,
        input.queueDepth ?? null,
        input.oldestQueuedMs ?? null,
        os.loadavg()[0] ?? 0,
        os.freemem() / 1_048_576,
        (Number(disk.bavail) * Number(disk.bsize)) / 1_048_576,
      );
    this.prune();
  }

  startHealthSampling(): () => void {
    const period = DIAGNOSTIC_LIMITS.healthSampleMs;
    let expectedAt = performance.now() + period;
    try {
      this.sampleHealth({ eventLoopLagMs: 0 });
    } catch {
      process.stderr.write("[diagnostics] initial health sample failed\n");
    }
    const timer = setInterval(() => {
      const now = performance.now();
      const lag = Math.max(0, now - expectedAt);
      expectedAt = now + period;
      try {
        this.sampleHealth({ eventLoopLagMs: lag });
      } catch {
        process.stderr.write("[diagnostics] health sample failed\n");
      }
    }, period);
    timer.unref();
    return () => clearInterval(timer);
  }

  checkProcessHealth(now = new Date()): number {
    this.assertCurrentVersion();
    const deadlineMs = DIAGNOSTIC_LIMITS.healthSampleMs * 3;
    let detected = 0;
    for (const name of fs.readdirSync(this.dir)) {
      if (!/^active-[a-f0-9]{32}\.json$/u.test(name) || name === path.basename(this.activePath))
        continue;
      const markerPath = path.join(this.dir, name);
      const bootId = name.slice(7, -5);
      let marker: { pid: number; process?: string };
      try {
        marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as typeof marker;
        if (!Number.isSafeInteger(marker.pid) || marker.pid < 1) continue;
      } catch {
        continue;
      }
      const latest = this.database
        .prepare("SELECT at, process FROM health WHERE boot_id = ? ORDER BY at DESC LIMIT 1")
        .get(bootId) as { at: string; process: string } | undefined;
      const lastAt = latest ? Date.parse(latest.at) : fs.statSync(markerPath).mtimeMs;
      const elapsedMs = Math.max(0, now.getTime() - lastAt);
      if (elapsedMs < deadlineMs) {
        this.reportedProcessFailures.delete(`${bootId}:PROCESS_UNRESPONSIVE`);
        continue;
      }
      let alive = true;
      try {
        process.kill(marker.pid, 0);
      } catch (cause) {
        alive = (cause as NodeJS.ErrnoException).code !== "ESRCH";
      }
      const code = alive ? "PROCESS_UNRESPONSIVE" : "PROCESS_CRASHED";
      const key = `${bootId}:${code}`;
      if (this.reportedProcessFailures.has(key)) continue;
      this.incident({
        traceId: randomBytes(16).toString("hex"),
        spanId: randomBytes(8).toString("hex"),
        kind: alive ? "process.unresponsive" : "process.crashed",
        code,
        where: "diagnostics.watchdog",
        severity: "error",
        expected: { deadlineMs },
        actual: { elapsedMs, alive },
        context: {
          bootId,
          ...((latest?.process ?? marker.process)
            ? { process: latest?.process ?? marker.process! }
            : {}),
        },
      });
      this.reportedProcessFailures.add(key);
      detected++;
    }
    return detected;
  }

  startProcessWatchdog(): () => void {
    const timer = setInterval(() => {
      try {
        this.checkProcessHealth();
      } catch {
        process.stderr.write("[diagnostics] process watchdog failed\n");
      }
    }, DIAGNOSTIC_LIMITS.healthSampleMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  armExpectation(input: ExpectationInput): string {
    this.assertCurrentVersion();
    validateContext(input);
    if (!Object.hasOwn(EXPECTATION_CODES, input.kind))
      throw new TypeError("Unknown expectation kind");
    if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1)
      throw new TypeError("Invalid expectation deadline");
    const correlation = sqlJson(input.correlation);
    const id = randomUUID();
    const now = new Date();
    const last = this.database
      .prepare("SELECT step FROM detail WHERE trace_id = ? ORDER BY id DESC LIMIT 1")
      .get(input.traceId) as { step: string } | undefined;
    this.database
      .prepare(`INSERT INTO expectations (
      id, kind, trace_id, span_id, attempt_id, thread_id, turn_id, correlation_json,
      armed_at, deadline_at, deadline_ms, last_checkpoint, boot_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        input.kind,
        input.traceId,
        input.spanId,
        input.attemptId ?? null,
        input.threadId ?? null,
        input.turnId ?? null,
        correlation,
        now.toISOString(),
        new Date(now.getTime() + input.deadlineMs).toISOString(),
        input.deadlineMs,
        last?.step ?? null,
        this.bootId,
      );
    return id;
  }

  resolveExpectation(id: string, outcome: "met" | "cancelled" = "met"): boolean {
    this.assertCurrentVersion();
    validateDiagnosticId(id);
    const pending = this.database.prepare("SELECT * FROM expectations WHERE id = ?").get(id) as
      | ExpectationRow
      | undefined;
    if (!pending) return false;
    this.write("expectation_resolved", {
      traceId: pending.trace_id,
      spanId: pending.span_id,
      ...(pending.attempt_id ? { attemptId: pending.attempt_id } : {}),
      ...(pending.thread_id ? { threadId: pending.thread_id } : {}),
      ...(pending.turn_id ? { turnId: pending.turn_id } : {}),
      flow: expectationFlow(pending.kind),
      step: "expectation.resolved",
      outcome: outcome === "met" ? "ok" : "cancelled",
      elapsedMs: Math.max(0, Date.now() - Date.parse(pending.armed_at)),
    });
    this.database.prepare("DELETE FROM expectations WHERE id = ?").run(id);
    return true;
  }

  resolveExpectationsForTrace(
    traceId: string,
    kind: ExpectationKind,
    outcome: "met" | "cancelled" = "met",
  ): number {
    this.assertCurrentVersion();
    validateDiagnosticId(traceId);
    if (!Object.hasOwn(EXPECTATION_CODES, kind)) throw new TypeError("Unknown expectation kind");
    const rows = this.database
      .prepare("SELECT id FROM expectations WHERE trace_id = ? AND kind = ? ORDER BY armed_at")
      .all(traceId, kind) as Array<{ id: string }>;
    for (const row of rows) this.resolveExpectation(row.id, outcome);
    return rows.length;
  }

  sweepExpectations(now = new Date(), afterRestart = false): number {
    this.assertCurrentVersion();
    const due = this.database
      .prepare(`SELECT * FROM expectations
      WHERE deadline_at <= ? OR (? = 1 AND boot_id != ?)
      ORDER BY deadline_at`)
      .all(now.toISOString(), afterRestart ? 1 : 0, this.bootId) as unknown as ExpectationRow[];
    let swept = 0;
    for (const pending of due) {
      const markerPath = path.join(this.dir, `active-${pending.boot_id}.json`);
      let ownerAlive = pending.boot_id === this.bootId;
      if (!ownerAlive && fs.existsSync(markerPath)) {
        try {
          const owner = JSON.parse(fs.readFileSync(markerPath, "utf8")) as { pid: number };
          process.kill(owner.pid, 0);
          ownerAlive = true;
        } catch {
          // A missing process makes its expectation unknown after restart.
        }
      }
      const expired = Date.parse(pending.deadline_at) <= now.getTime();
      if (!expired && ownerAlive) continue;
      const restarted = !ownerAlive;
      const code = restarted ? "EXPECTATION_MISSED" : EXPECTATION_CODES[pending.kind];
      const last = this.database
        .prepare("SELECT step FROM detail WHERE trace_id = ? ORDER BY id DESC LIMIT 1")
        .get(pending.trace_id) as { step: string } | undefined;
      const context = JSON.parse(pending.correlation_json) as DiagnosticFields;
      this.incident({
        traceId: pending.trace_id,
        spanId: pending.span_id,
        ...(pending.attempt_id ? { attemptId: pending.attempt_id } : {}),
        ...(pending.thread_id ? { threadId: pending.thread_id } : {}),
        ...(pending.turn_id ? { turnId: pending.turn_id } : {}),
        kind: "expectation.missed",
        code,
        where: "diagnostics.expectation",
        severity: "error",
        expected: { deadlineMs: pending.deadline_ms },
        actual: { elapsedMs: Math.max(0, now.getTime() - Date.parse(pending.armed_at)) },
        context: { ...context, reason: restarted ? "unknown" : "deadline" },
        ...((last?.step ?? pending.last_checkpoint)
          ? { lastCheckpoint: last?.step ?? pending.last_checkpoint! }
          : {}),
      });
      this.checkpoint({
        traceId: pending.trace_id,
        spanId: pending.span_id,
        ...(pending.thread_id ? { threadId: pending.thread_id } : {}),
        ...(pending.turn_id ? { turnId: pending.turn_id } : {}),
        flow: expectationFlow(pending.kind),
        step: restarted ? "expectation.unknown_after_restart" : "expectation.missed",
        outcome: "timed_out",
      });
      this.database.prepare("DELETE FROM expectations WHERE id = ?").run(pending.id);
      swept++;
    }
    return swept;
  }

  traceForCommand(commandId: string): DiagnosticContext | null {
    validateDiagnosticId(commandId);
    const row = this.database
      .prepare(`SELECT trace_id, span_id, attempt_id, thread_id, turn_id
      FROM detail WHERE command_id = ? ORDER BY id LIMIT 1`)
      .get(commandId) as
      | {
          trace_id: string;
          span_id: string;
          attempt_id: string | null;
          thread_id: string | null;
          turn_id: string | null;
        }
      | undefined;
    return row
      ? {
          traceId: row.trace_id,
          spanId: row.span_id,
          commandId,
          ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
          ...(row.thread_id ? { threadId: row.thread_id } : {}),
          ...(row.turn_id ? { turnId: row.turn_id } : {}),
        }
      : null;
  }

  prune(now = new Date()): void {
    if (now.getTime() - this.lastHealthThinAt >= 60_000) {
      const healthCutoff = new Date(
        now.getTime() - DIAGNOSTIC_LIMITS.healthThinAfterMs,
      ).toISOString();
      this.database
        .prepare(`DELETE FROM health WHERE at < ? AND id NOT IN (
        SELECT MIN(id) FROM health WHERE at < ?
        GROUP BY process, strftime('%Y-%m-%dT%H:%M', at)
      )`)
        .run(healthCutoff, healthCutoff);
      this.lastHealthThinAt = now.getTime();
    }
    const cutoff = new Date(
      now.getTime() - DIAGNOSTIC_LIMITS.incidentDays * 86_400_000,
    ).toISOString();
    this.database.prepare("DELETE FROM incidents WHERE last_at < ?").run(cutoff);
    const threshold = this.maxTotalBytes * DIAGNOSTIC_LIMITS.pruneAtRatio;
    if (totalBytes(this.dir) <= threshold) return;
    for (let i = 0; i < 1_000 && totalBytes(this.dir) > threshold; i++) {
      const result = this.database
        .prepare(`DELETE FROM detail WHERE id IN (
        SELECT id FROM detail WHERE pinned_until IS NULL OR pinned_until < ? ORDER BY at LIMIT 100
      )`)
        .run(now.toISOString());
      if (result.changes === 0) {
        const health = this.database
          .prepare("DELETE FROM health WHERE id IN (SELECT id FROM health ORDER BY at LIMIT 100)")
          .run();
        if (health.changes === 0) {
          const incident = this.database
            .prepare(
              "DELETE FROM incidents WHERE id IN (SELECT id FROM incidents ORDER BY last_at LIMIT 10)",
            )
            .run();
          if (incident.changes === 0) break;
        }
      }
      this.database.exec("PRAGMA incremental_vacuum(100); PRAGMA wal_checkpoint(TRUNCATE);");
    }
  }

  close(): void {
    this.database.close();
    if (fs.existsSync(this.spoolPath) && fs.statSync(this.spoolPath).size === 0) {
      fs.rmSync(this.spoolPath, { force: true });
    }
    fs.rmSync(this.activePath, { force: true });
  }
}

/** Desktop/child writer: fsyncs an allowlisted spool; only the server imports it into SQLite. */
export class DiagnosticsSpoolWriter {
  readonly bootId = randomBytes(16).toString("hex");
  private readonly dir: string;
  private readonly spoolPath: string;
  private readonly activePath: string;
  private readonly reportedProcessFailures = new Set<string>();
  private sequence = 0;
  private lastCpuUsage = process.cpuUsage();
  private lastHealthAt = performance.now();

  constructor(private readonly options: DiagnosticsOptions) {
    if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/u.test(options.appVersion))
      throw new TypeError("Invalid app version");
    this.dir = diagnosticsDir(options.stateDir);
    this.spoolPath = path.join(this.dir, `spool-${this.bootId}.jsonl`);
    this.activePath = path.join(this.dir, `active-${this.bootId}.json`);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(this.dir, 0o700);
    withLifecycleLock(this.dir, () => {
      const versionPath = path.join(this.dir, "version");
      const oldVersion = fs.existsSync(versionPath) ? fs.readFileSync(versionPath, "utf8") : null;
      if (oldVersion !== options.appVersion) {
        for (const entry of fs.readdirSync(this.dir)) {
          if (entry !== ".lifecycle-lock")
            fs.rmSync(path.join(this.dir, entry), { recursive: true, force: true });
        }
        fs.writeFileSync(versionPath, options.appVersion, { mode: 0o600 });
      }
      fs.writeFileSync(
        this.activePath,
        JSON.stringify({ pid: process.pid, process: options.process }),
        { mode: 0o600 },
      );
    });
  }

  private append(type: SpoolEnvelope["type"], data: SpoolEnvelope["data"]): void {
    withLifecycleLock(this.dir, () => {
      if (fs.readFileSync(path.join(this.dir, "version"), "utf8") !== this.options.appVersion)
        throw new Error("Diagnostics store belongs to a newer app version");
      const event = prepareEnvelope(this.bootId, ++this.sequence, this.options.process, type, data);
      const line = `${JSON.stringify(event)}\n`;
      const bytes = Buffer.byteLength(line);
      const spoolBytes = fs.existsSync(this.spoolPath) ? fs.statSync(this.spoolPath).size : 0;
      if (
        spoolBytes + bytes >
          (this.options.maxSpoolBytes ?? DIAGNOSTIC_LIMITS.spoolBytesPerProcess) ||
        totalBytes(this.dir) + bytes > (this.options.maxTotalBytes ?? DIAGNOSTIC_LIMITS.totalBytes)
      )
        throw new Error("Diagnostics capacity reached");
      const handle = fs.openSync(this.spoolPath, "a", 0o600);
      try {
        fs.writeSync(handle, line);
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
    });
  }

  checkpoint(data: CheckpointInput): void {
    this.append("checkpoint", data);
  }
  incident(data: IncidentInput): void {
    this.append("incident", data);
  }

  armExpectation(input: ExpectationInput): string {
    const id = randomUUID();
    this.append("expectation_arm", { ...input, id });
    return id;
  }

  sampleHealth(input: HealthSampleInput): void {
    const now = performance.now();
    const usage = process.cpuUsage(this.lastCpuUsage);
    this.lastCpuUsage = process.cpuUsage();
    const elapsedMs = Math.max(1, now - this.lastHealthAt);
    this.lastHealthAt = now;
    const memory = process.memoryUsage();
    const disk = fs.statfsSync(this.options.stateDir);
    const handles = (
      process as NodeJS.Process & { _getActiveHandles?: () => unknown[] }
    )._getActiveHandles?.();
    this.append("health", {
      eventLoopLagMs: input.eventLoopLagMs,
      cpuPct: ((usage.user + usage.system) / (elapsedMs * 1_000)) * 100,
      rssMb: memory.rss / 1_048_576,
      heapMb: memory.heapUsed / 1_048_576,
      openHandles: handles?.length ?? 0,
      queueDepth: input.queueDepth ?? null,
      oldestQueuedMs: input.oldestQueuedMs ?? null,
      machineLoad1m: os.loadavg()[0] ?? 0,
      freeMemMb: os.freemem() / 1_048_576,
      diskFreeMb: (Number(disk.bavail) * Number(disk.bsize)) / 1_048_576,
    });
  }

  startHealthSampling(): () => void {
    const period = DIAGNOSTIC_LIMITS.healthSampleMs;
    let expectedAt = performance.now() + period;
    try {
      this.sampleHealth({ eventLoopLagMs: 0 });
    } catch {
      process.stderr.write("[diagnostics] initial health sample failed\n");
    }
    const timer = setInterval(() => {
      const now = performance.now();
      const lag = Math.max(0, now - expectedAt);
      expectedAt = now + period;
      try {
        this.sampleHealth({ eventLoopLagMs: lag });
      } catch {
        process.stderr.write("[diagnostics] health sample failed\n");
      }
    }, period);
    timer.unref();
    return () => clearInterval(timer);
  }

  checkProcessHealth(now = new Date()): number {
    const database = openDiagnosticsReader(this.options.stateDir);
    let detected = 0;
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (!/^active-[a-f0-9]{32}\.json$/u.test(name) || name === path.basename(this.activePath))
          continue;
        const markerPath = path.join(this.dir, name);
        const bootId = name.slice(7, -5);
        let marker: { pid: number; process?: string };
        try {
          marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as typeof marker;
          if (!Number.isSafeInteger(marker.pid) || marker.pid < 1) continue;
        } catch {
          continue;
        }
        const latest = database
          ?.prepare("SELECT at, process FROM health WHERE boot_id = ? ORDER BY at DESC LIMIT 1")
          .get(bootId) as { at: string; process: string } | undefined;
        const elapsedMs = Math.max(
          0,
          now.getTime() - (latest ? Date.parse(latest.at) : fs.statSync(markerPath).mtimeMs),
        );
        if (elapsedMs < DIAGNOSTIC_LIMITS.healthSampleMs * 3) {
          this.reportedProcessFailures.delete(`${bootId}:PROCESS_UNRESPONSIVE`);
          continue;
        }
        let alive = true;
        try {
          process.kill(marker.pid, 0);
        } catch (cause) {
          alive = (cause as NodeJS.ErrnoException).code !== "ESRCH";
        }
        const code = alive ? "PROCESS_UNRESPONSIVE" : "PROCESS_CRASHED";
        const key = `${bootId}:${code}`;
        if (this.reportedProcessFailures.has(key)) continue;
        this.incident({
          traceId: randomBytes(16).toString("hex"),
          spanId: randomBytes(8).toString("hex"),
          kind: alive ? "process.unresponsive" : "process.crashed",
          code,
          where: "diagnostics.watchdog",
          severity: "error",
          expected: { deadlineMs: DIAGNOSTIC_LIMITS.healthSampleMs * 3 },
          actual: { elapsedMs, alive },
          context: {
            bootId,
            ...((latest?.process ?? marker.process)
              ? { process: latest?.process ?? marker.process! }
              : {}),
          },
        });
        this.reportedProcessFailures.add(key);
        detected++;
      }
    } finally {
      database?.close();
    }
    return detected;
  }

  startProcessWatchdog(): () => void {
    const timer = setInterval(() => {
      try {
        this.checkProcessHealth();
      } catch {
        process.stderr.write("[diagnostics] process watchdog failed\n");
      }
    }, DIAGNOSTIC_LIMITS.healthSampleMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  close(): void {
    withLifecycleLock(this.dir, () => {
      fs.rmSync(this.activePath, { force: true });
      if (fs.existsSync(this.spoolPath)) {
        if (fs.statSync(this.spoolPath).size === 0) {
          fs.rmSync(this.spoolPath, { force: true });
        } else {
          fs.writeFileSync(path.join(this.dir, `closed-${this.bootId}.json`), "{}", {
            mode: 0o600,
          });
        }
      }
    });
  }
}

export function openDiagnosticsReader(stateDir: string): DatabaseSync | null {
  const filename = path.join(diagnosticsDir(stateDir), "diagnostics.sqlite");
  if (!fs.existsSync(filename)) return null;
  return new DatabaseSync(filename, { readOnly: true });
}
