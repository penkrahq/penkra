import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { INCIDENT_SUMMARIES, isIncidentCode, type IncidentCode } from "./codes";
import { DIAGNOSTIC_LIMITS, type DiagnosticLimitName } from "./limits";
import {
  validateDiagnosticFields,
  validateDiagnosticId,
  validateDiagnosticToken,
  type DiagnosticFields,
} from "./privacy";

export interface DiagnosticsOptions {
  readonly stateDir: string;
  readonly appVersion: string;
  readonly buildId?: string;
  readonly osMajor?: number | "unknown";
  readonly bundlePath?: string;
  readonly bundleSignature?: BundleSignature;
  readonly process: "server" | "desktop-main" | "renderer" | "provider-child";
  readonly maxTotalBytes?: number;
  readonly maxSpoolBytes?: number;
}

export interface BundleSignature {
  readonly size: number;
  readonly mtimeMs: number;
  readonly inode: number;
}

function isBundleSignature(value: unknown): value is BundleSignature {
  if (!value || typeof value !== "object") return false;
  const signature = value as Record<string, unknown>;
  return [signature.size, signature.mtimeMs, signature.inode].every(
    (field) => typeof field === "number" && Number.isFinite(field) && field >= 0,
  );
}

export function parseDiagnosticsBundleSignature(
  value: string | undefined,
): BundleSignature | undefined {
  if (!value) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!isBundleSignature(parsed)) throw new TypeError("Invalid diagnostics bundle signature");
  return parsed;
}

function storeIdentity(options: DiagnosticsOptions): string {
  if (
    (options.buildId !== undefined && /^0{7,64}$/u.test(options.buildId)) ||
    (options.buildId && options.buildId !== "unknown" && !/^[a-f0-9]{7,64}$/u.test(options.buildId))
  )
    throw new TypeError("Invalid diagnostics build ID");
  if (options.bundlePath && !isBundleSignature(options.bundleSignature))
    throw new TypeError("Missing diagnostics bundle signature");
  return JSON.stringify({
    appVersion: options.appVersion,
    buildId: options.buildId ?? "unknown",
    bundleSignature: options.bundleSignature ?? null,
  });
}

function runningBundleIsInstalled(options: DiagnosticsOptions): boolean {
  if (!options.bundlePath) return true;
  try {
    const stats = fs.statSync(options.bundlePath);
    const current = { size: stats.size, mtimeMs: stats.mtimeMs, inode: stats.ino };
    return JSON.stringify(current) === JSON.stringify(options.bundleSignature);
  } catch {
    return false;
  }
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
  readonly limit?: {
    readonly name: DiagnosticLimitName;
    readonly value: number;
    readonly observed: number;
  };
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

const EXPECTATION_LIMIT_NAMES = {
  "send.accepted": "sendAcceptedMs",
  "turn.started": "turnStartedMs",
  "turn.first_output": "firstOutputMs",
  "turn.output_continues": "runningSilenceMs",
  "stop.terminal": "stopTerminalMs",
  "play.started": "playStartMs",
  "archive.windows_closed": "archiveWindowsMs",
  "create.completed": "createMs",
  "socket.connected": "socketHandshakeMs",
} as const satisfies Record<ExpectationKind, DiagnosticLimitName>;

export type ExpectationKind = keyof typeof EXPECTATION_CODES;

export interface ExpectationInput extends DiagnosticContext {
  readonly kind: ExpectationKind;
  readonly deadlineMs: number;
  readonly armedAt?: string;
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
    | "health"
    | "provenance_set";
  readonly at: string;
  readonly monoMs: number;
  readonly process: DiagnosticsOptions["process"];
  readonly data:
    | CheckpointInput
    | IncidentInput
    | ExpectationArmInput
    | HealthRecord
    | ProvenanceInput;
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
CREATE TABLE IF NOT EXISTS incident_occurrences (
  id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id),
  boot_id TEXT NOT NULL, sequence INTEGER NOT NULL, at TEXT NOT NULL,
  trace_id TEXT NOT NULL, span_id TEXT NOT NULL, attempt_id TEXT,
  thread_id TEXT, turn_id TEXT, command_id TEXT,
  expected_json TEXT NOT NULL, actual_json TEXT NOT NULL, limit_json TEXT NOT NULL,
  context_json TEXT NOT NULL, provenance_json TEXT NOT NULL, health_json TEXT NOT NULL,
  last_checkpoint TEXT, pin_from TEXT NOT NULL, pin_until TEXT NOT NULL,
  env_json TEXT NOT NULL, UNIQUE(boot_id, sequence)
);
CREATE INDEX IF NOT EXISTS incident_occurrences_at ON incident_occurrences(at, id);
CREATE INDEX IF NOT EXISTS incident_occurrences_thread_at ON incident_occurrences(thread_id, at);
CREATE INDEX IF NOT EXISTS incident_occurrences_trace_at ON incident_occurrences(trace_id, at);
CREATE INDEX IF NOT EXISTS incident_occurrences_incident_at ON incident_occurrences(incident_id, at);
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

function sqlitePhysicalBudget(
  database: DatabaseSync,
  dir: string,
  dbPath: string,
  maxTotalBytes: number,
  pendingExternalBytes = 0,
): void {
  const walPath = `${dbPath}-wal`;
  const walBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
  if (totalBytes(dir) + walBytes + pendingExternalBytes > maxTotalBytes)
    throw new Error("Diagnostics capacity reached before SQLite checkpoint");
  const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
    busy: number;
  };
  if (checkpoint.busy) throw new Error("Diagnostics capacity reached while SQLite is busy");
  const pageSize = (database.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
  const pageCount = (database.prepare("PRAGMA page_count").get() as { page_count: number })
    .page_count;
  const currentDatabaseBytes = fs.statSync(dbPath).size;
  const currentWalBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
  const externalBytes =
    totalBytes(dir) - currentDatabaseBytes - currentWalBytes + pendingExternalBytes;
  // With cache spill disabled, one transaction contributes at most one WAL
  // frame per database page. Account for both full-size files, frame headers,
  // and the WAL-index's 32 KiB regions before allowing SQLite to write.
  const fixedOverhead = 65_536;
  const bytesPerPage = pageSize * 2 + 32;
  const maxPages = Math.floor((maxTotalBytes - externalBytes - fixedOverhead) / bytesPerPage);
  if (maxPages < pageCount || maxPages < 1)
    throw new Error("Diagnostics capacity reached before SQLite write");
  const applied = (
    database.prepare(`PRAGMA max_page_count = ${maxPages}`).get() as { max_page_count: number }
  ).max_page_count;
  if (applied > maxPages) throw new Error("Diagnostics capacity reached before SQLite write");
}

const LOSS_LEDGER_BYTES = 256;
const LOSS_LEDGER_FILE_BYTES = LOSS_LEDGER_BYTES * 2;
export type LossReason = "capacity" | "sqlite" | "spool" | "stale";
const LOSS_REASONS: readonly LossReason[] = ["capacity", "sqlite", "spool", "stale"];
export type LossCounts = Record<LossReason, number>;

function emptyLossCounts(): LossCounts {
  return { capacity: 0, sqlite: 0, spool: 0, stale: 0 };
}

function lossLedgerPath(dir: string, bootId: string): string {
  return path.join(dir, `loss-${bootId}.bin`);
}

function writeLossLedger(file: string, reasons: LossCounts, reason: LossReason): void {
  const count = LOSS_REASONS.reduce((sum, key) => sum + reasons[key], 0);
  const generation = (fs.existsSync(file) ? readLossLedger(file)?.generation : null) ?? 0;
  const payload = { generation: generation + 1, count, reason, reasons };
  const checksum = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
  const content = Buffer.from(JSON.stringify({ ...payload, checksum }));
  if (content.length > LOSS_LEDGER_BYTES) throw new Error("Diagnostics loss ledger overflow");
  const handle = fs.openSync(file, fs.existsSync(file) ? "r+" : "w+", 0o600);
  try {
    if (fs.fstatSync(handle).size < LOSS_LEDGER_FILE_BYTES)
      fs.ftruncateSync(handle, LOSS_LEDGER_FILE_BYTES);
    const record = Buffer.alloc(LOSS_LEDGER_BYTES, 0x20);
    content.copy(record);
    const slot = generation % 2 === 0 ? 0 : 1;
    fs.writeSync(handle, record, 0, record.length, slot * LOSS_LEDGER_BYTES);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function recordLoss(dir: string, bootId: string, reason: LossReason, count = 1): void {
  const file = lossLedgerPath(dir, bootId);
  try {
    const reasons =
      (fs.existsSync(file) ? readLossLedger(file)?.reasons : null) ?? emptyLossCounts();
    reasons[reason] += count;
    writeLossLedger(file, reasons, reason);
  } catch {
    process.stderr.write("[diagnostics] durable loss count unavailable\n");
  }
}

export function readLossLedger(
  file: string,
): { count: number; reason: LossReason; reasons: LossCounts; generation: number } | null {
  try {
    const content = fs.readFileSync(file);
    const records =
      content.length === LOSS_LEDGER_BYTES
        ? [content.toString("utf8")]
        : [0, 1].map((slot) =>
            content
              .subarray(slot * LOSS_LEDGER_BYTES, (slot + 1) * LOSS_LEDGER_BYTES)
              .toString("utf8"),
          );
    const valid: Array<{
      count: number;
      reason: LossReason;
      reasons: LossCounts;
      generation: number;
    }> = [];
    for (const record of records) {
      let row: {
        count: number;
        reason: LossReason;
        reasons: LossCounts;
        generation?: number;
        checksum?: string;
      };
      try {
        row = JSON.parse(record.trim());
      } catch {
        continue;
      }
      const legacy = content.length === LOSS_LEDGER_BYTES;
      const generation = legacy ? 0 : row.generation;
      const checksum = legacy
        ? true
        : typeof row.checksum === "string" &&
          row.checksum ===
            createHash("sha256")
              .update(
                JSON.stringify({
                  generation,
                  count: row.count,
                  reason: row.reason,
                  reasons: row.reasons,
                }),
              )
              .digest("hex")
              .slice(0, 16);
      if (
        checksum &&
        Number.isSafeInteger(generation) &&
        (generation ?? 0) >= 0 &&
        Number.isSafeInteger(row.count) &&
        row.count >= 0 &&
        LOSS_REASONS.includes(row.reason) &&
        row.reasons &&
        LOSS_REASONS.every(
          (reason) => Number.isSafeInteger(row.reasons[reason]) && row.reasons[reason] >= 0,
        ) &&
        LOSS_REASONS.reduce((sum, reason) => sum + row.reasons[reason], 0) === row.count
      )
        valid.push({
          count: row.count,
          reason: row.reason,
          reasons: row.reasons,
          generation: generation!,
        });
    }
    return valid.toSorted((left, right) => right.generation - left.generation)[0] ?? null;
  } catch {
    return null;
  }
}

interface ResetLossManifest {
  bootId: string;
  spools: Record<string, number>;
  ledgers: Record<string, number>;
}

function resetLossPath(dir: string): string {
  return path.join(dir, "reset-loss.json");
}

function readResetLossManifest(dir: string): ResetLossManifest {
  const file = resetLossPath(dir);
  if (!fs.existsSync(file))
    return { bootId: randomBytes(16).toString("hex"), spools: {}, ledgers: {} };
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as ResetLossManifest;
  if (
    !/^[a-f0-9]{32}$/u.test(manifest.bootId) ||
    ![manifest.spools, manifest.ledgers].every(
      (counts) =>
        counts &&
        typeof counts === "object" &&
        Object.entries(counts).every(
          ([bootId, count]) =>
            /^[a-f0-9]{32}$/u.test(bootId) && Number.isSafeInteger(count) && count >= 0,
        ),
    )
  )
    throw new Error("Invalid diagnostics reset loss manifest");
  return manifest;
}

function writeResetLossManifest(dir: string, manifest: ResetLossManifest): void {
  const file = resetLossPath(dir);
  const temporary = `${file}.tmp`;
  const handle = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeFileSync(handle, JSON.stringify(manifest));
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

function flushResetLossManifest(dir: string): void {
  if (!fs.existsSync(resetLossPath(dir))) return;
  const manifest = readResetLossManifest(dir);
  const count = [...Object.values(manifest.spools), ...Object.values(manifest.ledgers)].reduce(
    (sum, value) => sum + value,
    0,
  );
  const file = lossLedgerPath(dir, manifest.bootId);
  const reasons = (fs.existsSync(file) ? readLossLedger(file)?.reasons : null) ?? emptyLossCounts();
  reasons.stale = Math.max(reasons.stale, count);
  writeLossLedger(file, reasons, "stale");
  fs.rmSync(resetLossPath(dir), { force: true });
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
  if (type !== "health" && type !== "provenance_set") validateContext(data as DiagnosticContext);
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
  } else if (type === "provenance_set") {
    const provenance = data as ProvenanceInput;
    validateDiagnosticId(provenance.entityId);
    validateDiagnosticId(provenance.traceId);
    validateDiagnosticToken(provenance.entityKind, "entityKind");
    validateDiagnosticToken(provenance.field, "field");
    const at = provenance.at === undefined ? undefined : new Date(provenance.at).toISOString();
    safeData = {
      entityKind: provenance.entityKind,
      entityId: provenance.entityId,
      field: provenance.field,
      traceId: provenance.traceId,
      ...(at ? { at } : {}),
    };
  } else if (type === "expectation_arm") {
    const expectation = data as ExpectationArmInput;
    validateDiagnosticId(expectation.id);
    if (!Object.hasOwn(EXPECTATION_CODES, expectation.kind))
      throw new TypeError("Unknown expectation kind");
    if (!Number.isSafeInteger(expectation.deadlineMs) || expectation.deadlineMs < 1)
      throw new TypeError("Invalid expectation deadline");
    const armedAt =
      expectation.armedAt === undefined ? undefined : new Date(expectation.armedAt).toISOString();
    safeData = {
      id: expectation.id,
      kind: expectation.kind,
      traceId: expectation.traceId,
      spanId: expectation.spanId,
      ...(expectation.attemptId ? { attemptId: expectation.attemptId } : {}),
      ...(expectation.threadId ? { threadId: expectation.threadId } : {}),
      ...(expectation.turnId ? { turnId: expectation.turnId } : {}),
      deadlineMs: expectation.deadlineMs,
      ...(armedAt ? { armedAt } : {}),
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
    if (
      incident.limit &&
      (Object.keys(incident.limit).sort().join(",") !== "name,observed,value" ||
        !Object.hasOwn(DIAGNOSTIC_LIMITS, incident.limit.name) ||
        !Number.isFinite(incident.limit.value) ||
        incident.limit.value < 0 ||
        !Number.isFinite(incident.limit.observed) ||
        incident.limit.observed < 0)
    )
      throw new TypeError("Invalid incident limit");
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
      ...(incident.limit
        ? {
            limit: {
              name: incident.limit.name,
              value: incident.limit.value,
              observed: incident.limit.observed,
            },
          }
        : {}),
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

let macOsMajor: number | "unknown" | undefined;

function diagnosticOs(options: DiagnosticsOptions): {
  osFamily: "darwin" | "linux" | "windows";
  osMajor: number | "unknown";
} {
  if (
    options.osMajor !== undefined &&
    options.osMajor !== "unknown" &&
    (!Number.isSafeInteger(options.osMajor) || options.osMajor < 0)
  )
    throw new TypeError("Invalid diagnostics OS major");
  if (process.platform === "darwin") {
    if (options.osMajor !== undefined) return { osFamily: "darwin", osMajor: options.osMajor };
    if (macOsMajor === undefined) {
      try {
        const parsed = Number.parseInt(
          execFileSync("/usr/bin/sw_vers", ["-productVersion"], { timeout: 1_000 }).toString(),
          10,
        );
        macOsMajor = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : "unknown";
      } catch {
        macOsMajor = "unknown";
      }
    }
    return { osFamily: "darwin", osMajor: macOsMajor };
  }
  if (process.platform === "linux" || process.platform === "win32")
    return {
      osFamily: process.platform === "win32" ? "windows" : "linux",
      osMajor: options.osMajor ?? (Number.parseInt(os.release(), 10) || "unknown"),
    };
  throw new Error("Unsupported diagnostics OS");
}

function diagnosticEnvironment(options: DiagnosticsOptions, event: SpoolEnvelope): string {
  const { osFamily, osMajor } = diagnosticOs(options);
  return JSON.stringify({
    appVersion: options.appVersion,
    buildId: options.buildId ?? "unknown",
    channel: options.bundlePath ? "production" : process.env.NODE_ENV === "test" ? "test" : "dev",
    bootId: event.bootId,
    process: event.process,
    osFamily,
    osMajor,
  });
}

function insertEnvelope(
  database: DatabaseSync,
  event: SpoolEnvelope,
  options: DiagnosticsOptions,
): void {
  const receiptKey = `last-sequence:${event.bootId}`;
  const lastSequence = database.prepare("SELECT value FROM meta WHERE key = ?").get(receiptKey) as
    | { value: string }
    | undefined;
  if (lastSequence && Number(lastSequence.value) >= event.sequence) return;
  const gap = event.sequence - Number(lastSequence?.value ?? 0) - 1;
  if (gap > 0)
    database
      .prepare(`INSERT INTO meta(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + ?`)
      .run(`sequence-gap:${event.bootId}`, String(gap), gap);
  if (event.type === "provenance_set") {
    const provenance = event.data as ProvenanceInput;
    database
      .prepare(`INSERT INTO provenance (
        entity_kind, entity_id, field, set_by_trace_id, set_at
      ) VALUES (?, ?, ?, ?, ?) ON CONFLICT(entity_kind, entity_id, field)
      DO UPDATE SET set_by_trace_id = excluded.set_by_trace_id, set_at = excluded.set_at`)
      .run(
        provenance.entityKind,
        provenance.entityId,
        provenance.field,
        provenance.traceId,
        provenance.at ?? event.at,
      );
  } else if (event.type === "health") {
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
    const armedAt = expectation.armedAt ?? event.at;
    const deadlineAt = new Date(Date.parse(armedAt) + expectation.deadlineMs).toISOString();
    // The desktop writes through a worker. A fast server acceptance can reach
    // SQLite before that worker's spool record is imported.
    const accepted =
      expectation.kind === "send.accepted" &&
      (database
        .prepare(
          "SELECT at FROM detail WHERE trace_id = ? AND flow = 'send' AND step = 'command.accepted' ORDER BY at LIMIT 1",
        )
        .get(expectation.traceId) as { at: string } | false | undefined);
    if (!accepted || Date.parse(accepted.at) > Date.parse(deadlineAt)) {
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
          armedAt,
          deadlineAt,
          expectation.deadlineMs,
          last?.step ?? null,
          event.bootId,
        );
    }
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
    if (event.type === "expectation_resolved" && typeof data.fields?.entityId === "string")
      database.prepare("DELETE FROM expectations WHERE id = ?").run(data.fields.entityId);
  } else {
    const data = event.data as IncidentInput;
    const expectationId = data.context?.entityId;
    const closesExpectation =
      data.kind === "expectation.missed" &&
      typeof expectationId === "string" &&
      ["late_resolution", "deadline", "unknown"].includes(String(data.context?.reason));
    if (
      closesExpectation &&
      !database.prepare("SELECT 1 FROM expectations WHERE id = ?").get(expectationId as string)
    ) {
      database
        .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
        .run(receiptKey, String(event.sequence));
      return;
    }
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
      actual_json=excluded.actual_json, limit_json=excluded.limit_json,
      context_json=excluded.context_json,
      provenance_json=excluded.provenance_json, health_json=excluded.health_json,
      last_checkpoint=excluded.last_checkpoint, pin_until=excluded.pin_until`)
      .run(
        randomUUID(),
        fingerprint,
        data.kind,
        data.code,
        data.severity,
        data.where,
        INCIDENT_SUMMARIES[data.code],
        data.traceId,
        data.spanId,
        data.attemptId ?? null,
        data.threadId ?? null,
        data.turnId ?? null,
        data.commandId ?? null,
        sqlJson(data.expected),
        sqlJson(data.actual),
        JSON.stringify(data.limit ?? {}),
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
        diagnosticEnvironment(options, event),
      );
    const aggregate = database
      .prepare("SELECT id FROM incidents WHERE fingerprint = ?")
      .get(fingerprint) as { id: string };
    database
      .prepare(`INSERT INTO incident_occurrences (
        id, incident_id, boot_id, sequence, at, trace_id, span_id, attempt_id,
        thread_id, turn_id, command_id, expected_json, actual_json, limit_json,
        context_json, provenance_json, health_json, last_checkpoint, pin_from,
        pin_until, env_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        randomUUID(),
        aggregate.id,
        event.bootId,
        event.sequence,
        event.at,
        data.traceId,
        data.spanId,
        data.attemptId ?? null,
        data.threadId ?? null,
        data.turnId ?? null,
        data.commandId ?? null,
        sqlJson(data.expected),
        sqlJson(data.actual),
        JSON.stringify(data.limit ?? {}),
        sqlJson(data.context),
        provenanceJson,
        healthJson,
        data.lastCheckpoint ?? null,
        from,
        until,
        diagnosticEnvironment(options, event),
      );
    database
      .prepare(`UPDATE detail SET pinned_until = ?
      WHERE at >= ? AND at <= ? AND (pinned_until IS NULL OR pinned_until < ?)`)
      .run(until, from, until, until);
    if (
      data.kind === "diagnostics.degraded" &&
      typeof data.context?.bootId === "string" &&
      typeof data.context.count === "number" &&
      Number.isSafeInteger(data.context.count)
    ) {
      const reason = data.context.reason;
      const lossKey =
        data.where === "diagnostics.write" && LOSS_REASONS.includes(reason as LossReason)
          ? `loss-reported:${data.context.bootId}:${reason}`
          : data.where === "diagnostics.spool_import" && reason === "invalid-record"
            ? `loss-reported:spool-invalid:${data.context.bootId}`
            : data.where === "diagnostics.spool_import" && reason === "sequence-gap"
              ? `loss-reported:sequence-gap:${data.context.bootId}`
              : null;
      if (lossKey)
        database
          .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
          .run(lossKey, String(data.context.count));
    }
    // A late resolution is one spool record and one SQLite transaction. Closing
    // the expectation here prevents a crash from replaying a second miss.
    if (
      data.kind === "expectation.missed" &&
      ["late_resolution", "deadline", "unknown"].includes(String(data.context?.reason)) &&
      typeof expectationId === "string"
    )
      database.prepare("DELETE FROM expectations WHERE id = ?").run(expectationId);
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
  private database!: DatabaseSync;
  private readonly maxTotalBytes: number;
  private readonly maxSpoolBytes: number;
  private readonly identity: string;
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
    this.identity = storeIdentity(options);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(this.dir, 0o700);
    const startup = withLifecycleLock(this.dir, () => {
      if (!runningBundleIsInstalled(options))
        throw new Error("Diagnostics process has a stale app bundle");
      const versionPath = path.join(this.dir, "version");
      const identityPath = path.join(this.dir, "identity");
      const previousIdentity = fs.existsSync(identityPath)
        ? fs.readFileSync(identityPath, "utf8")
        : null;
      if (previousIdentity !== this.identity) {
        const keep = new Set<string>([".lifecycle-lock", "reset-loss.json"]);
        for (const name of fs.readdirSync(this.dir)) {
          const match = /^spool-identity-([a-f0-9]{32})\.json$/u.exec(name);
          if (!match) continue;
          const bootId = match[1]!;
          if (
            fs.readFileSync(path.join(this.dir, name), "utf8") !== this.identity ||
            fs.existsSync(path.join(this.dir, `stale-${bootId}.json`))
          )
            continue;
          for (const related of [
            name,
            `spool-${bootId}.jsonl`,
            `active-${bootId}.json`,
            `closed-${bootId}.json`,
            `loss-${bootId}.bin`,
          ])
            keep.add(related);
        }
        const manifest = readResetLossManifest(this.dir);
        for (const name of fs.readdirSync(this.dir)) {
          if (keep.has(name)) continue;
          const spool = /^spool-([a-f0-9]{32})\.jsonl$/u.exec(name);
          if (spool) {
            const bootId = spool[1]!;
            const count = fs
              .readFileSync(path.join(this.dir, name), "utf8")
              .split("\n")
              .filter(Boolean).length;
            manifest.spools[bootId] = Math.max(manifest.spools[bootId] ?? 0, count);
          }
          const ledger = /^loss-([a-f0-9]{32})\.bin$/u.exec(name);
          if (ledger) {
            const bootId = ledger[1]!;
            const count = readLossLedger(path.join(this.dir, name))?.count ?? 0;
            manifest.ledgers[bootId] = Math.max(manifest.ledgers[bootId] ?? 0, count);
          }
        }
        if (Object.keys(manifest.spools).length + Object.keys(manifest.ledgers).length > 0)
          writeResetLossManifest(this.dir, manifest);
        for (const entry of fs.readdirSync(this.dir)) {
          if (!keep.has(entry))
            fs.rmSync(path.join(this.dir, entry), { recursive: true, force: true });
        }
      }
      const createdDatabase = !fs.existsSync(this.dbPath);
      const db = new DatabaseSync(this.dbPath);
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        PRAGMA cache_spill=OFF; PRAGMA wal_autocheckpoint=1;
        PRAGMA journal_size_limit=0;`);
      // Schema creation and startup metadata are writes too. Bound the database
      // before either can allocate pages, including on a fresh installation.
      sqlitePhysicalBudget(db, this.dir, this.dbPath, this.maxTotalBytes);
      db.exec(SCHEMA);
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '1')").run();
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('app_version', ?)").run(
        options.appVersion,
      );
      if (previousIdentity !== this.identity || createdDatabase) {
        db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('reset_at', ?)").run(
          new Date().toISOString(),
        );
        fs.writeFileSync(versionPath, options.appVersion, { mode: 0o600 });
        fs.writeFileSync(identityPath, this.identity, { mode: 0o600 });
      }
      this.database = db;
      flushResetLossManifest(this.dir);
      const crashedProcesses = this.importSpoolsLocked();
      fs.writeFileSync(
        this.activePath,
        JSON.stringify({ pid: process.pid, process: options.process }),
        { mode: 0o600 },
      );
      writeLossLedger(lossLedgerPath(this.dir, this.bootId), emptyLossCounts(), "capacity");
      return { crashedProcesses };
    });
    this.sweepExpectations(new Date(), true);
    if (startup.crashedProcesses > 0) {
      this.incident({
        traceId: randomBytes(16).toString("hex"),
        spanId: randomBytes(8).toString("hex"),
        kind: "process.crashed",
        code: "UNCLEAN_SHUTDOWN",
        where: "diagnostics.spool_import",
        severity: "warn",
        actual: { count: startup.crashedProcesses },
      });
    }
    this.reportLosses();
  }

  private assertCurrentVersion(): void {
    if (!runningBundleIsInstalled(this.options))
      throw new Error("Diagnostics process has a stale app bundle");
    if (fs.readFileSync(path.join(this.dir, "identity"), "utf8") !== this.identity)
      throw new Error("Diagnostics store belongs to a different app bundle");
  }

  private importSpoolsLocked(): number {
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
      const spoolContent = fs.readFileSync(spoolPath, "utf8");
      const lines = spoolContent.split("\n");
      const stalePath = path.join(this.dir, `stale-${bootId}.json`);
      if (fs.existsSync(stalePath)) {
        const dropped = lines.filter(Boolean).length;
        if (dropped > 0) recordLoss(this.dir, bootId, "stale", dropped);
        if (live) fs.truncateSync(spoolPath, 0);
        else {
          fs.rmSync(spoolPath, { force: true });
          fs.rmSync(activePath, { force: true });
          fs.rmSync(stalePath, { force: true });
        }
        continue;
      }
      this.pruneLocked();
      try {
        sqlitePhysicalBudget(this.database, this.dir, this.dbPath, this.maxTotalBytes);
      } catch {
        continue;
      }
      this.database.exec("BEGIN IMMEDIATE");
      try {
        let invalid = 0;
        const observedKey = `spool-observed:${bootId}`;
        const observed = this.database
          .prepare("SELECT value FROM meta WHERE key = ?")
          .get(observedKey) as { value: string } | undefined;
        let priorBytes = 0;
        if (observed) {
          try {
            const prior = JSON.parse(observed.value) as { bytes: number; hash: string };
            if (
              Number.isSafeInteger(prior.bytes) &&
              prior.bytes >= 0 &&
              prior.bytes <= Buffer.byteLength(spoolContent) &&
              createHash("sha256")
                .update(Buffer.from(spoolContent).subarray(0, prior.bytes))
                .digest("hex") === prior.hash
            )
              priorBytes = prior.bytes;
          } catch {
            // An invalid observation marker cannot justify skipping a loss count.
          }
        }
        let lineOffset = 0;
        for (const line of lines) {
          const currentOffset = lineOffset;
          lineOffset += Buffer.byteLength(line) + 1;
          if (!line) continue;
          let event: SpoolEnvelope;
          try {
            event = JSON.parse(line) as SpoolEnvelope;
            if (event.version !== 1 || event.bootId !== bootId)
              throw new Error("Invalid diagnostics spool identity");
            if (
              ![
                "checkpoint",
                "external_outcome",
                "expectation_resolved",
                "incident",
                "expectation_arm",
                "health",
                "provenance_set",
              ].includes(event.type)
            )
              throw new Error("Invalid diagnostics spool event type");
            if (!Number.isFinite(Date.parse(event.at)) || !Number.isFinite(event.monoMs))
              throw new Error("Invalid diagnostics spool timestamp");
            const safe = prepareEnvelope(
              event.bootId,
              event.sequence,
              event.process,
              event.type,
              event.data,
            );
            event = { ...safe, at: new Date(event.at).toISOString(), monoMs: event.monoMs };
          } catch {
            if (currentOffset >= priorBytes) invalid++;
            continue; // Torn final line or invalid/unallowlisted payload.
          }
          insertEnvelope(this.database, event, this.options);
        }
        if (invalid > 0)
          this.database
            .prepare(`INSERT INTO meta(key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + ?`)
            .run(`spool-invalid:${bootId}`, String(invalid), invalid);
        this.database.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(
          observedKey,
          JSON.stringify({
            bytes: Buffer.byteLength(spoolContent),
            hash: createHash("sha256").update(spoolContent).digest("hex"),
          }),
        );
        if (totalBytes(this.dir) > this.maxTotalBytes)
          throw new Error("Diagnostics capacity reached during spool import");
        this.database.exec("COMMIT");
      } catch (cause) {
        if (this.database.isTransaction) this.database.exec("ROLLBACK");
        this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        if ((cause as Error).message.includes("capacity reached")) continue;
        throw cause;
      }
      if (live) {
        fs.truncateSync(spoolPath, 0);
      } else {
        fs.rmSync(spoolPath, { force: true });
        fs.rmSync(activePath, { force: true });
        if (!fs.existsSync(closedPath)) crashedProcesses++;
        fs.rmSync(closedPath, { force: true });
        fs.rmSync(path.join(this.dir, `spool-identity-${bootId}.json`), { force: true });
      }
      this.pruneLocked(new Date(), this.maxTotalBytes);
      if (totalBytes(this.dir) > this.maxTotalBytes)
        throw new Error("Diagnostics capacity reached after spool import");
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
  }

  importPeerSpools(): number {
    const crashed = withLifecycleLock(this.dir, () => {
      this.assertCurrentVersion();
      return this.importSpoolsLocked();
    });
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
    this.reportLosses();
    return crashed;
  }

  private reportLosses(): void {
    // A failed SQLite transaction leaves its synced spool event intact. Replay
    // that event first; otherwise a retry would append a second degradation
    // occurrence for the same still-unreceipted loss.
    try {
      withLifecycleLock(this.dir, () => {
        this.assertCurrentVersion();
        this.replayOwnSpoolLocked();
      });
    } catch {
      return;
    }
    for (const entry of fs.readdirSync(this.dir)) {
      if (!/^loss-[a-f0-9]{32}\.bin$/u.test(entry)) continue;
      const bootId = entry.slice(5, -4);
      const loss = readLossLedger(path.join(this.dir, entry));
      if (!loss || loss.count === 0) continue;
      for (const reason of LOSS_REASONS) {
        const key = `loss-reported:${bootId}:${reason}`;
        const reported = this.database.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
          | { value: string }
          | undefined;
        const delta = loss.reasons[reason] - Number(reported?.value ?? 0);
        if (delta <= 0) continue;
        try {
          this.incident({
            traceId: randomBytes(16).toString("hex"),
            spanId: randomBytes(8).toString("hex"),
            kind: "diagnostics.degraded",
            code:
              reason === "capacity"
                ? "DIAGNOSTICS_CAP_REACHED"
                : reason === "stale"
                  ? "DIAGNOSTICS_DROPPED"
                  : "DIAGNOSTICS_WRITE_FAILED",
            where: "diagnostics.write",
            severity: "error",
            actual: { count: delta },
            context: { bootId, reason, count: loss.reasons[reason] },
          });
        } catch {
          // The preallocated ledger remains the durable source until space is available.
        }
      }
    }
    const stored = this.database
      .prepare(
        "SELECT key, value FROM meta WHERE key LIKE 'spool-invalid:%' OR key LIKE 'sequence-gap:%'",
      )
      .all() as Array<{ key: string; value: string }>;
    for (const row of stored) {
      const bootId = row.key.slice(row.key.indexOf(":") + 1);
      if (!/^[a-f0-9]{32}$/u.test(bootId)) continue;
      const reportedKey = `loss-reported:${row.key}`;
      const previous = this.database
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get(reportedKey) as { value: string } | undefined;
      // A missing sequence is a separate loss from an invalid spool line.
      // An invalid line may not even carry a sequence, so subtracting one
      // counter from the other silently discards independent failures.
      const observed = Number(row.value);
      const delta = observed - Number(previous?.value ?? 0);
      if (!Number.isSafeInteger(delta) || delta <= 0) continue;
      try {
        this.incident({
          traceId: randomBytes(16).toString("hex"),
          spanId: randomBytes(8).toString("hex"),
          kind: "diagnostics.degraded",
          code: "DIAGNOSTICS_DROPPED",
          where: "diagnostics.spool_import",
          severity: "error",
          actual: { count: delta },
          context: {
            bootId,
            reason: row.key.startsWith("spool-invalid:") ? "invalid-record" : "sequence-gap",
            count: observed,
          },
        });
      } catch {
        // The meta count remains pending until the next successful import.
      }
    }
  }

  private write(type: SpoolEnvelope["type"], data: SpoolEnvelope["data"]): void {
    withLifecycleLock(this.dir, () => this.writeLocked(type, data));
  }

  private writeLocked(type: SpoolEnvelope["type"], data: SpoolEnvelope["data"]): void {
    this.assertCurrentVersion();
    const reportFailure =
      type !== "incident" || (data as IncidentInput).kind !== "diagnostics.degraded";
    this.pruneLocked();
    const event = prepareEnvelope(this.bootId, ++this.sequence, this.options.process, type, data);
    const line = `${JSON.stringify(event)}\n`;
    const bytes = Buffer.byteLength(line);
    const currentSpoolBytes = fs.existsSync(this.spoolPath) ? fs.statSync(this.spoolPath).size : 0;
    if (
      currentSpoolBytes + bytes > this.maxSpoolBytes ||
      totalBytes(this.dir) + bytes > this.maxTotalBytes
    ) {
      if (reportFailure) recordLoss(this.dir, this.bootId, "capacity");
      throw new Error("Diagnostics capacity reached");
    }
    try {
      sqlitePhysicalBudget(this.database, this.dir, this.dbPath, this.maxTotalBytes, bytes);
    } catch (cause) {
      if (reportFailure) recordLoss(this.dir, this.bootId, "capacity");
      throw cause;
    }
    try {
      const handle = fs.openSync(this.spoolPath, "a", 0o600);
      try {
        fs.writeSync(handle, line);
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
    } catch (cause) {
      if (reportFailure) recordLoss(this.dir, this.bootId, "spool");
      throw cause;
    }
    try {
      this.replayOwnSpoolLocked();
    } catch (cause) {
      const atPageLimit = /database or disk is full|SQLITE_FULL/iu.test((cause as Error).message);
      if (reportFailure)
        recordLoss(
          this.dir,
          this.bootId,
          atPageLimit || (cause as Error).message.includes("capacity reached")
            ? "capacity"
            : "sqlite",
        );
      if (atPageLimit)
        throw new Error("Diagnostics capacity reached during SQLite write", { cause });
      throw cause;
    }
  }

  private replayOwnSpoolLocked(): void {
    if (!fs.existsSync(this.spoolPath) || fs.statSync(this.spoolPath).size === 0) return;
    sqlitePhysicalBudget(this.database, this.dir, this.dbPath, this.maxTotalBytes);
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
            "provenance_set",
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
          this.options,
        );
      }
      if (totalBytes(this.dir) > this.maxTotalBytes)
        throw new Error("Diagnostics capacity reached during SQLite write");
      this.database.exec("COMMIT");
    } catch (cause) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      throw cause;
    }
    fs.truncateSync(this.spoolPath, 0);
    this.pruneLocked(new Date(), this.maxTotalBytes);
    if (totalBytes(this.dir) > this.maxTotalBytes) throw new Error("Diagnostics capacity reached");
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
    this.write("provenance_set", input);
  }

  sampleHealth(input: HealthSampleInput): void {
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
    this.write("health", {
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
    const id = randomUUID();
    this.write("expectation_arm", { ...input, id });
    return id;
  }

  resolveExpectation(id: string, outcome: "met" | "cancelled" = "met"): boolean {
    validateDiagnosticId(id);
    return withLifecycleLock(this.dir, () => {
      this.assertCurrentVersion();
      const pending = this.database.prepare("SELECT * FROM expectations WHERE id = ?").get(id) as
        | ExpectationRow
        | undefined;
      if (!pending) return false;
      const now = Date.now();
      const late = outcome === "met" && now > Date.parse(pending.deadline_at);
      if (late) {
        const last = this.database
          .prepare("SELECT step FROM detail WHERE trace_id = ? ORDER BY id DESC LIMIT 1")
          .get(pending.trace_id) as { step: string } | undefined;
        this.writeLocked("incident", {
          traceId: pending.trace_id,
          spanId: pending.span_id,
          ...(pending.attempt_id ? { attemptId: pending.attempt_id } : {}),
          ...(pending.thread_id ? { threadId: pending.thread_id } : {}),
          ...(pending.turn_id ? { turnId: pending.turn_id } : {}),
          kind: "expectation.missed",
          code: EXPECTATION_CODES[pending.kind],
          where: "diagnostics.expectation",
          severity: "error",
          expected: { deadlineMs: pending.deadline_ms },
          actual: { elapsedMs: now - Date.parse(pending.armed_at) },
          limit: {
            name: EXPECTATION_LIMIT_NAMES[pending.kind],
            value: pending.deadline_ms,
            observed: now - Date.parse(pending.armed_at),
          },
          context: {
            ...JSON.parse(pending.correlation_json),
            reason: "late_resolution",
            entityId: id,
          },
          ...((last?.step ?? pending.last_checkpoint)
            ? { lastCheckpoint: last?.step ?? pending.last_checkpoint! }
            : {}),
        });
        return true;
      }
      this.writeLocked("expectation_resolved", {
        traceId: pending.trace_id,
        spanId: pending.span_id,
        ...(pending.attempt_id ? { attemptId: pending.attempt_id } : {}),
        ...(pending.thread_id ? { threadId: pending.thread_id } : {}),
        ...(pending.turn_id ? { turnId: pending.turn_id } : {}),
        flow: expectationFlow(pending.kind),
        step: late ? "expectation.missed" : "expectation.resolved",
        outcome: late ? "timed_out" : outcome === "met" ? "ok" : "cancelled",
        elapsedMs: Math.max(0, now - Date.parse(pending.armed_at)),
        fields: { entityId: id },
      });
      return true;
    });
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
        limit: {
          name: EXPECTATION_LIMIT_NAMES[pending.kind],
          value: pending.deadline_ms,
          observed: Math.max(0, now.getTime() - Date.parse(pending.armed_at)),
        },
        context: { ...context, reason: restarted ? "unknown" : "deadline", entityId: pending.id },
        ...((last?.step ?? pending.last_checkpoint)
          ? { lastCheckpoint: last?.step ?? pending.last_checkpoint! }
          : {}),
      });
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

  prune(now = new Date(), targetBytes = this.maxTotalBytes * DIAGNOSTIC_LIMITS.pruneAtRatio): void {
    withLifecycleLock(this.dir, () => {
      this.assertCurrentVersion();
      this.pruneLocked(now, targetBytes);
    });
  }

  private pruneLocked(
    now = new Date(),
    targetBytes = this.maxTotalBytes * DIAGNOSTIC_LIMITS.pruneAtRatio,
  ): void {
    const maintenanceReserve = Math.min(8 * 1024 * 1024, Math.floor(this.maxTotalBytes * 0.2));
    if (totalBytes(this.dir) > this.maxTotalBytes - maintenanceReserve) return;
    if (totalBytes(this.dir) <= targetBytes && now.getTime() - this.lastHealthThinAt < 60_000)
      return;
    const cutoff = new Date(
      now.getTime() - DIAGNOSTIC_LIMITS.incidentDays * 86_400_000,
    ).toISOString();
    for (let i = 0; i < 100_000; i++) {
      const beforeBytes = totalBytes(this.dir);
      try {
        sqlitePhysicalBudget(this.database, this.dir, this.dbPath, this.maxTotalBytes);
      } catch {
        return;
      }
      let changed = 0;
      let thinned = false;
      this.database.exec("BEGIN IMMEDIATE");
      try {
        if (now.getTime() - this.lastHealthThinAt >= 60_000) {
          const healthCutoff = new Date(
            now.getTime() - DIAGNOSTIC_LIMITS.healthThinAfterMs,
          ).toISOString();
          changed += Number(
            this.database
              .prepare(`DELETE FROM health WHERE at < ? AND id NOT IN (
              SELECT MIN(id) FROM health WHERE at < ?
              GROUP BY process, strftime('%Y-%m-%dT%H:%M', at)
            )`)
              .run(healthCutoff, healthCutoff).changes,
          );
          thinned = true;
        }
        const expired = this.database
          .prepare("DELETE FROM incident_occurrences WHERE at < ?")
          .run(cutoff);
        changed += Number(expired.changes);
        if (expired.changes > 0) this.recountIncidents();
        if (totalBytes(this.dir) > targetBytes) {
          const detail = this.database
            .prepare(`DELETE FROM detail WHERE id IN (
        SELECT id FROM detail WHERE NOT EXISTS (
          SELECT 1 FROM incident_occurrences o
          WHERE detail.at BETWEEN o.pin_from AND o.pin_until
        ) ORDER BY at LIMIT 100
      )`)
            .run();
          changed += Number(detail.changes);
          if (detail.changes === 0) {
            const health = this.database
              .prepare(
                "DELETE FROM health WHERE id IN (SELECT id FROM health ORDER BY at LIMIT 100)",
              )
              .run();
            changed += Number(health.changes);
            if (health.changes === 0) {
              const occurrence = this.database
                .prepare(`DELETE FROM incident_occurrences WHERE id IN (
              SELECT id FROM incident_occurrences ORDER BY at, id LIMIT 10
            )`)
                .run();
              changed += Number(occurrence.changes);
              if (occurrence.changes > 0) {
                this.database
                  .prepare(`INSERT INTO meta(key, value) VALUES ('incident_evictions', ?)
              ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + ?`)
                  .run(String(occurrence.changes), occurrence.changes);
                this.recountIncidents();
              }
            }
          }
        }
        if (totalBytes(this.dir) > this.maxTotalBytes)
          throw new Error("Diagnostics capacity reached during pruning");
        this.database.exec("COMMIT");
      } catch (cause) {
        if (this.database.isTransaction) this.database.exec("ROLLBACK");
        this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        throw cause;
      }
      if (totalBytes(this.dir) > this.maxTotalBytes)
        throw new Error("Diagnostics capacity reached after pruning");
      if (thinned) this.lastHealthThinAt = now.getTime();
      try {
        sqlitePhysicalBudget(this.database, this.dir, this.dbPath, this.maxTotalBytes);
      } catch {
        return;
      }
      const freePages = (
        this.database.prepare("PRAGMA freelist_count").get() as { freelist_count: number }
      ).freelist_count;
      if (freePages > 0) {
        this.database.exec("BEGIN IMMEDIATE");
        try {
          this.database.exec("PRAGMA incremental_vacuum(100)");
          if (totalBytes(this.dir) > this.maxTotalBytes)
            throw new Error("Diagnostics capacity reached during vacuum");
          this.database.exec("COMMIT");
        } catch (cause) {
          if (this.database.isTransaction) this.database.exec("ROLLBACK");
          this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          throw cause;
        }
      }
      this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      if (totalBytes(this.dir) > this.maxTotalBytes)
        throw new Error("Diagnostics capacity reached after vacuum");
      const afterBytes = totalBytes(this.dir);
      if (
        afterBytes <= targetBytes ||
        (changed === 0 && (freePages === 0 || afterBytes >= beforeBytes))
      )
        break;
    }
  }

  private recountIncidents(): void {
    this.database.exec(`UPDATE incidents SET
      count = (SELECT COUNT(*) FROM incident_occurrences o WHERE o.incident_id = incidents.id),
      first_at = (SELECT MIN(at) FROM incident_occurrences o WHERE o.incident_id = incidents.id),
      last_at = (SELECT MAX(at) FROM incident_occurrences o WHERE o.incident_id = incidents.id)
      WHERE EXISTS (SELECT 1 FROM incident_occurrences o WHERE o.incident_id = incidents.id);
      DELETE FROM incidents WHERE NOT EXISTS (
        SELECT 1 FROM incident_occurrences o WHERE o.incident_id = incidents.id
      );`);
  }

  close(): void {
    withLifecycleLock(this.dir, () => {
      this.database.close();
      if (fs.existsSync(this.spoolPath) && fs.statSync(this.spoolPath).size === 0) {
        fs.rmSync(this.spoolPath, { force: true });
      }
      fs.rmSync(this.activePath, { force: true });
    });
  }
}

/** Desktop/child writer: fsyncs an allowlisted spool; only the server imports it into SQLite. */
export class DiagnosticsSpoolWriter {
  readonly bootId = randomBytes(16).toString("hex");
  private readonly identity: string;
  private stale = false;
  private readonly dir: string;
  private readonly spoolPath: string;
  private readonly activePath: string;
  private readonly reportedProcessFailures = new Set<string>();
  private sequence = 0;
  private lastCpuUsage = process.cpuUsage();
  private lastHealthAt = performance.now();

  recordDrop(reason: "capacity" | "spool", count = 1): void {
    if (!Number.isSafeInteger(count) || count < 1) throw new TypeError("Invalid loss count");
    withLifecycleLock(this.dir, () => recordLoss(this.dir, this.bootId, reason, count));
  }

  constructor(private readonly options: DiagnosticsOptions) {
    if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/u.test(options.appVersion))
      throw new TypeError("Invalid app version");
    this.dir = diagnosticsDir(options.stateDir);
    this.identity = storeIdentity(options);
    this.spoolPath = path.join(this.dir, `spool-${this.bootId}.jsonl`);
    this.activePath = path.join(this.dir, `active-${this.bootId}.json`);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(this.dir, 0o700);
    withLifecycleLock(this.dir, () => {
      this.stale = !runningBundleIsInstalled(options);
      // Only the SQLite owner resets on an update. A desktop process may start
      // first; its current spool must survive the server's later reset.
      const marker = path.join(this.dir, `spool-identity-${this.bootId}.json`);
      const active = JSON.stringify({
        pid: process.pid,
        process: options.process,
        stale: this.stale,
      });
      const needed =
        Buffer.byteLength(this.identity) +
        Buffer.byteLength(active) +
        (this.stale ? 2 : 0) +
        LOSS_LEDGER_FILE_BYTES;
      if (totalBytes(this.dir) + needed > (options.maxTotalBytes ?? DIAGNOSTIC_LIMITS.totalBytes))
        throw new Error("Diagnostics capacity reached before spool startup");
      fs.writeFileSync(marker, this.identity, {
        mode: 0o600,
      });
      fs.writeFileSync(this.activePath, active, { mode: 0o600 });
      if (this.stale)
        fs.writeFileSync(path.join(this.dir, `stale-${this.bootId}.json`), "{}", { mode: 0o600 });
      writeLossLedger(lossLedgerPath(this.dir, this.bootId), emptyLossCounts(), "capacity");
    });
  }

  private append(type: SpoolEnvelope["type"], data: SpoolEnvelope["data"]): void {
    withLifecycleLock(this.dir, () => {
      if (!runningBundleIsInstalled(this.options)) this.stale = true;
      const marker = path.join(this.dir, `spool-identity-${this.bootId}.json`);
      const stalePath = path.join(this.dir, `stale-${this.bootId}.json`);
      const markerBytes = fs.existsSync(marker) ? 0 : Buffer.byteLength(this.identity);
      const staleBytes = this.stale && !fs.existsSync(stalePath) ? 2 : 0;
      if (
        totalBytes(this.dir) + markerBytes + staleBytes >
        (this.options.maxTotalBytes ?? DIAGNOSTIC_LIMITS.totalBytes)
      ) {
        recordLoss(this.dir, this.bootId, "capacity");
        throw new Error("Diagnostics capacity reached before spool marker");
      }
      if (!fs.existsSync(marker)) fs.writeFileSync(marker, this.identity, { mode: 0o600 });
      if (fs.readFileSync(marker, "utf8") !== this.identity)
        throw new Error("Diagnostics spool identity changed");
      if (this.stale) {
        fs.writeFileSync(stalePath, "{}", { mode: 0o600 });
      }
      const event = prepareEnvelope(this.bootId, ++this.sequence, this.options.process, type, data);
      const line = `${JSON.stringify(event)}\n`;
      const bytes = Buffer.byteLength(line);
      const spoolBytes = fs.existsSync(this.spoolPath) ? fs.statSync(this.spoolPath).size : 0;
      if (
        spoolBytes + bytes >
          (this.options.maxSpoolBytes ?? DIAGNOSTIC_LIMITS.spoolBytesPerProcess) ||
        totalBytes(this.dir) + bytes > (this.options.maxTotalBytes ?? DIAGNOSTIC_LIMITS.totalBytes)
      ) {
        recordLoss(this.dir, this.bootId, "capacity");
        throw new Error("Diagnostics capacity reached");
      }
      try {
        const handle = fs.openSync(this.spoolPath, "a", 0o600);
        try {
          fs.writeSync(handle, line);
          fs.fsyncSync(handle);
        } finally {
          fs.closeSync(handle);
        }
      } catch (cause) {
        recordLoss(this.dir, this.bootId, "spool");
        throw cause;
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
      if (fs.existsSync(this.spoolPath)) {
        if (fs.statSync(this.spoolPath).size === 0) {
          fs.rmSync(this.spoolPath, { force: true });
        } else {
          // Reuse the active marker's bytes instead of allocating space at cap.
          if (fs.existsSync(this.activePath))
            fs.renameSync(this.activePath, path.join(this.dir, `closed-${this.bootId}.json`));
        }
      }
      fs.rmSync(this.activePath, { force: true });
    });
  }
}

export function openDiagnosticsReader(stateDir: string): DatabaseSync | null {
  const filename = path.join(diagnosticsDir(stateDir), "diagnostics.sqlite");
  if (!fs.existsSync(filename)) return null;
  return new DatabaseSync(filename, { readOnly: true });
}
