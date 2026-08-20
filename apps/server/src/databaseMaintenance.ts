import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";

import {
  inspectPenkraDatabaseHealth,
  type PenkraDatabaseHealth,
} from "./persistence/DatabaseHealth.ts";
import { withDatabaseLifecycleLock } from "./persistence/DatabaseLifecycleLock.ts";
import { assertSafeSqliteVersion } from "./persistence/SqliteSafety.ts";
import { migrationBackupDirectory } from "./persistence/MigrationBackup.ts";

const USAGE =
  "Usage: penkra-database <verify|report> <absolute-database-path> | <compact|cutover> <absolute-source-path> <absolute-candidate-path>";

type DatabaseMaintenanceOutput = Pick<Console, "error" | "log">;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

async function inspectRegularDatabase(dbPath: string): Promise<PenkraDatabaseHealth> {
  const stat = await fs.lstat(dbPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Database path is not a regular file: ${dbPath}`);
  }

  assertSafeSqliteVersion(process.versions.sqlite ?? "unknown");
  const database = new DatabaseSync(dbPath);
  try {
    database.exec(
      "PRAGMA locking_mode=EXCLUSIVE; PRAGMA busy_timeout=5000; BEGIN EXCLUSIVE; COMMIT;",
    );
    return inspectPenkraDatabaseHealth(
      (sql) => database.prepare(sql).all() as Array<Record<string, unknown>>,
    );
  } finally {
    database.close();
  }
}

export type DatabaseStorageReport = PenkraDatabaseHealth & {
  readonly mainFileBytes: number;
  readonly walBytes: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly freelistPages: number;
  readonly freelistBytes: number;
  readonly backupCount: number;
  readonly backupBytes: number;
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly objectBytes: Readonly<Record<string, number>>;
  readonly payloadBytes: Readonly<Record<string, number>>;
  readonly orchestrationEventCounts: Readonly<Record<string, number>>;
  readonly commandReceiptCounts: Readonly<Record<string, number>>;
};

export type DatabaseCompactionReport = {
  readonly sourcePath: string;
  readonly candidatePath: string;
  readonly sourceBytes: number;
  readonly candidateBytes: number;
  readonly reclaimedBytes: number;
  readonly reclaimedPercent: number;
  readonly discardedSettledMessageFragments: number;
  readonly discardedMaterializedActivityEvents: number;
  readonly discardedAcknowledgedEvents: number;
  readonly discardedInternalReceipts: number;
  readonly collapsedHistoricalActivityRows: number;
  readonly semanticTableHashes: Readonly<Record<string, string>>;
  readonly semanticThreadHashes: Readonly<Record<string, string>>;
  readonly semanticActivityHashes: Readonly<Record<string, string>>;
  readonly integrityCheck: "ok";
  readonly foreignKeyViolationCount: 0;
};

export type DatabaseCutoverReport = {
  readonly sourcePath: string;
  readonly selectedCandidatePath: string;
  readonly rollbackPath: string;
  readonly semanticTableHashes: Readonly<Record<string, string>>;
  readonly semanticThreadHashes: Readonly<Record<string, string>>;
  readonly semanticActivityHashes: Readonly<Record<string, string>>;
  readonly integrityCheck: "ok";
  readonly foreignKeyViolationCount: 0;
};

async function regularFileBytes(filePath: string): Promise<number> {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile() && !stat.isSymbolicLink() ? stat.size : 0;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw cause;
  }
}

async function inspectStorageReport(dbPath: string): Promise<DatabaseStorageReport> {
  const health = await inspectRegularDatabase(dbPath);
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const scalar = (statement: string): number =>
      Number(Object.values(database.prepare(statement).get() ?? {})[0] ?? 0);
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ readonly name: string }>;
    const rowCounts: Record<string, number> = {};
    const payloadBytes: Record<string, number> = {};
    for (const { name } of tables) {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      rowCounts[name] = scalar(`SELECT COUNT(*) AS value FROM ${quoted}`);
      const columns = database
        .prepare(`SELECT name, type FROM pragma_table_info('${name.replaceAll("'", "''")}')`)
        .all() as Array<{ readonly name: string; readonly type: string }>;
      const payloadColumns = columns.filter(({ name: columnName, type }) => {
        const normalizedName = columnName.toLowerCase();
        const normalizedType = type.toUpperCase();
        return (
          normalizedType.includes("TEXT") ||
          normalizedType.includes("BLOB") ||
          normalizedName.endsWith("_json") ||
          normalizedName.endsWith("_blob")
        );
      });
      if (payloadColumns.length > 0) {
        const expression = payloadColumns
          .map(
            ({ name: columnName }) =>
              `COALESCE(length(CAST(${quoteSqlIdentifier(columnName)} AS BLOB)), 0)`,
          )
          .join(" + ");
        payloadBytes[name] = scalar(
          `SELECT COALESCE(SUM(${expression}), 0) AS value FROM ${quoted}`,
        );
      }
    }
    const objectBytes: Record<string, number> = {};
    try {
      const rows = database
        .prepare("SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY name")
        .all() as Array<{ readonly name: string; readonly bytes: number }>;
      for (const row of rows) objectBytes[row.name] = Number(row.bytes);
    } catch {
      // Some SQLite builds omit the optional dbstat virtual table. The physical
      // database totals remain available and objectBytes stays explicitly empty.
    }
    const backupDirectory = migrationBackupDirectory(dbPath);
    let backupCount = 0;
    let backupBytes = 0;
    try {
      for (const entry of await fs.readdir(backupDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".sqlite")) continue;
        const bytes = await regularFileBytes(path.join(backupDirectory, entry.name));
        if (bytes === 0) continue;
        backupCount += 1;
        backupBytes += bytes;
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    const pageSize = scalar("PRAGMA page_size");
    const freelistPages = scalar("PRAGMA freelist_count");
    const orchestrationEventCounts = Object.fromEntries(
      (
        database
          .prepare(
            "SELECT event_type AS class, COUNT(*) AS count FROM orchestration_events GROUP BY event_type ORDER BY event_type",
          )
          .all() as Array<{ readonly class: string; readonly count: number }>
      ).map((row) => [row.class, Number(row.count)]),
    );
    const commandReceiptCounts = Object.fromEntries(
      (
        database
          .prepare(
            `SELECT
               CASE WHEN command_id LIKE 'provider:%' THEN 'provider-internal' ELSE 'product' END AS class,
               COUNT(*) AS count
             FROM orchestration_command_receipts
             GROUP BY class ORDER BY class`,
          )
          .all() as Array<{ readonly class: string; readonly count: number }>
      ).map((row) => [row.class, Number(row.count)]),
    );
    return {
      ...health,
      mainFileBytes: await regularFileBytes(dbPath),
      walBytes: await regularFileBytes(`${dbPath}-wal`),
      pageSize,
      pageCount: scalar("PRAGMA page_count"),
      freelistPages,
      freelistBytes: freelistPages * pageSize,
      backupCount,
      backupBytes,
      rowCounts,
      objectBytes,
      payloadBytes,
      orchestrationEventCounts,
      commandReceiptCounts,
    };
  } finally {
    database.close();
  }
}

const COMPACTION_LOG_TABLES = new Set([
  "orchestration_events",
  "orchestration_command_receipts",
  "effect_sql_migrations",
  "projection_thread_activities",
]);

function quoteSqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function semanticTableHashes(database: DatabaseSync): Record<string, string> {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ readonly name: string }>;
  const result: Record<string, string> = {};
  for (const { name } of tables) {
    if (COMPACTION_LOG_TABLES.has(name)) continue;
    const rows = database.prepare(`SELECT * FROM ${quoteSqlIdentifier(name)} ORDER BY rowid`).all();
    result[name] = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  }
  return result;
}

function semanticThreadHashes(database: DatabaseSync): Record<string, string> {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ readonly name: string }>;
  const rowsByThread = new Map<string, Array<unknown>>();
  for (const { name } of tables) {
    if (COMPACTION_LOG_TABLES.has(name)) continue;
    const escapedName = name.replaceAll("'", "''");
    const columns = database
      .prepare(`SELECT name FROM pragma_table_info('${escapedName}')`)
      .all() as Array<{ readonly name: string }>;
    if (!columns.some(({ name: columnName }) => columnName === "thread_id")) continue;
    const rows = database
      .prepare(
        `SELECT * FROM ${quoteSqlIdentifier(name)} WHERE thread_id IS NOT NULL ORDER BY thread_id, rowid`,
      )
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const threadId = String(row.thread_id);
      const semanticRows = rowsByThread.get(threadId) ?? [];
      semanticRows.push([name, row]);
      rowsByThread.set(threadId, semanticRows);
    }
  }
  return Object.fromEntries(
    [...rowsByThread.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([threadId, rows]) => [
        threadId,
        createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
      ]),
  );
}

type CompactActivityRow = {
  readonly activity_id: string;
  readonly thread_id: string;
  readonly turn_id: string | null;
  readonly kind: string;
  readonly payload_json: string;
  readonly sequence: number | null;
  readonly created_at: string;
};

function stableActivityOperationId(row: CompactActivityRow): string | null {
  if (!row.kind.startsWith("tool.")) return null;
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.payload_json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const data =
    typeof payload.data === "object" && payload.data !== null && !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : null;
  const item =
    typeof data?.item === "object" && data.item !== null && !Array.isArray(data.item)
      ? (data.item as Record<string, unknown>)
      : null;
  const value =
    payload.operationId ??
    payload.toolCallId ??
    payload.toolUseId ??
    data?.toolCallId ??
    data?.toolUseId ??
    item?.id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isLaterActivity(left: CompactActivityRow, right: CompactActivityRow): boolean {
  const leftTerminal = left.kind === "tool.completed" ? 1 : 0;
  const rightTerminal = right.kind === "tool.completed" ? 1 : 0;
  if (leftTerminal !== rightTerminal) return leftTerminal > rightTerminal;
  if ((left.sequence ?? -1) !== (right.sequence ?? -1)) {
    return (left.sequence ?? -1) > (right.sequence ?? -1);
  }
  if (left.created_at !== right.created_at) return left.created_at > right.created_at;
  return left.activity_id > right.activity_id;
}

function canonicalActivityRows(database: DatabaseSync): ReadonlyArray<CompactActivityRow> {
  const columns = database
    .prepare("SELECT name FROM pragma_table_info('projection_thread_activities')")
    .all() as Array<{ readonly name: string }>;
  const names = new Set(columns.map(({ name }) => name));
  if (
    ![
      "activity_id",
      "thread_id",
      "turn_id",
      "kind",
      "payload_json",
      "sequence",
      "created_at",
    ].every((name) => names.has(name))
  ) {
    return [];
  }
  const rows = database
    .prepare(
      `SELECT activity_id, thread_id, turn_id, kind, payload_json, sequence, created_at
       FROM projection_thread_activities`,
    )
    .all() as unknown as CompactActivityRow[];
  const survivors = new Map<string, CompactActivityRow>();
  const passthrough: CompactActivityRow[] = [];
  for (const row of rows) {
    const operationId = stableActivityOperationId(row);
    if (operationId === null) {
      passthrough.push(row);
      continue;
    }
    const key = JSON.stringify([row.thread_id, row.turn_id, operationId]);
    const current = survivors.get(key);
    if (!current || isLaterActivity(row, current)) survivors.set(key, row);
  }
  return [...passthrough, ...survivors.values()].sort(
    (left, right) =>
      left.thread_id.localeCompare(right.thread_id) ||
      (left.sequence ?? -1) - (right.sequence ?? -1) ||
      left.created_at.localeCompare(right.created_at) ||
      left.activity_id.localeCompare(right.activity_id),
  );
}

function semanticActivityHashes(database: DatabaseSync): Record<string, string> {
  const byThread = new Map<string, CompactActivityRow[]>();
  for (const row of canonicalActivityRows(database)) {
    const entries = byThread.get(row.thread_id) ?? [];
    entries.push(row);
    byThread.set(row.thread_id, entries);
  }
  return Object.fromEntries(
    [...byThread.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([threadId, rows]) => [
        threadId,
        createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
      ]),
  );
}

function changes(database: DatabaseSync): number {
  return Number(database.prepare("SELECT changes() AS value").get()?.value ?? 0);
}

async function buildCompactCandidate(
  sourcePath: string,
  candidatePath: string,
): Promise<DatabaseCompactionReport> {
  const sourceStat = await fs.lstat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error(`Database path is not a regular file: ${sourcePath}`);
  }
  if (path.dirname(sourcePath) !== path.dirname(candidatePath)) {
    throw new Error(
      "Compact candidate must be in the source database directory for atomic selection.",
    );
  }
  try {
    await fs.lstat(candidatePath);
    throw new Error(`Compact candidate already exists: ${candidatePath}`);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }

  const source = new DatabaseSync(sourcePath);
  let sourceHashes: Record<string, string>;
  let sourceThreadHashes: Record<string, string>;
  let sourceActivityHashes: Record<string, string>;
  try {
    source.exec(
      "PRAGMA locking_mode=EXCLUSIVE; PRAGMA busy_timeout=5000; BEGIN EXCLUSIVE; COMMIT;",
    );
    inspectPenkraDatabaseHealth(
      (sql) => source.prepare(sql).all() as Array<Record<string, unknown>>,
    );
    sourceHashes = semanticTableHashes(source);
    sourceThreadHashes = semanticThreadHashes(source);
    sourceActivityHashes = semanticActivityHashes(source);
    const escapedCandidate = candidatePath.replaceAll("'", "''");
    source.exec(`VACUUM INTO '${escapedCandidate}'`);
  } finally {
    source.close();
  }

  let discardedSettledMessageFragments = 0;
  let discardedMaterializedActivityEvents = 0;
  let discardedAcknowledgedEvents = 0;
  let discardedInternalReceipts = 0;
  let collapsedHistoricalActivityRows = 0;
  const candidate = new DatabaseSync(candidatePath);
  try {
    candidate.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    try {
      const hasQueuedTurnPromotions =
        candidate
          .prepare(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'queued_turn_promotions'",
          )
          .get() !== undefined;
      candidate.exec(`
        CREATE TEMP TABLE compact_discard_sequences(sequence INTEGER PRIMARY KEY);
        INSERT INTO compact_discard_sequences(sequence)
        SELECT event.sequence
        FROM orchestration_events AS event
        WHERE event.sequence <= MIN(
          COALESCE((SELECT MIN(last_acked_sequence) FROM orchestration_consumer_state), 0),
          COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0) - 10000
        )
          ${
            hasQueuedTurnPromotions
              ? "AND event.sequence NOT IN (SELECT queued_event_sequence FROM queued_turn_promotions)"
              : ""
          };
      `);
      discardedAcknowledgedEvents = Number(
        candidate.prepare("SELECT COUNT(*) AS value FROM compact_discard_sequences").get()?.value ??
          0,
      );
      discardedSettledMessageFragments = Number(
        candidate
          .prepare(`
          SELECT COUNT(*) AS value
          FROM orchestration_events
          WHERE sequence IN (SELECT sequence FROM compact_discard_sequences)
            AND event_type = 'thread.message-sent'
            AND json_extract(payload_json, '$.streaming') = 1
        `)
          .get()?.value ?? 0,
      );
      discardedMaterializedActivityEvents = Number(
        candidate
          .prepare(`
          SELECT COUNT(*) AS value
          FROM orchestration_events
          WHERE sequence IN (SELECT sequence FROM compact_discard_sequences)
            AND event_type = 'thread.activity-appended'
        `)
          .get()?.value ?? 0,
      );
      candidate.exec(`
        DELETE FROM orchestration_command_receipts
        WHERE command_id LIKE 'provider:%'
          AND result_sequence IN (SELECT sequence FROM compact_discard_sequences)
      `);
      discardedInternalReceipts = changes(candidate);
      candidate.exec(`
        DELETE FROM orchestration_events
        WHERE sequence IN (SELECT sequence FROM compact_discard_sequences);
        DROP TABLE compact_discard_sequences;
        COMMIT;
      `);
    } catch (cause) {
      candidate.exec("ROLLBACK");
      throw cause;
    }
    candidate.exec("BEGIN IMMEDIATE");
    try {
      const before = Number(
        candidate.prepare("SELECT COUNT(*) AS value FROM projection_thread_activities").get()
          ?.value ?? 0,
      );
      candidate.exec(`
        CREATE TEMP TABLE compact_activity_survivors(activity_id TEXT PRIMARY KEY);
        INSERT INTO compact_activity_survivors(activity_id)
        SELECT activity_id FROM (
          SELECT activity_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY thread_id, COALESCE(turn_id, ''),
                     COALESCE(
                       operation_id,
                       json_extract(payload_json, '$.operationId'),
                       json_extract(payload_json, '$.toolCallId'),
                       json_extract(payload_json, '$.toolUseId'),
                       json_extract(payload_json, '$.data.toolCallId'),
                       json_extract(payload_json, '$.data.toolUseId'),
                       json_extract(payload_json, '$.data.item.id')
                     )
                   ORDER BY CASE WHEN kind = 'tool.completed' THEN 1 ELSE 0 END DESC,
                            COALESCE(sequence, -1) DESC, created_at DESC, activity_id DESC
                 ) AS rank
          FROM projection_thread_activities
          WHERE kind LIKE 'tool.%'
            AND COALESCE(
              operation_id,
              json_extract(payload_json, '$.operationId'),
              json_extract(payload_json, '$.toolCallId'),
              json_extract(payload_json, '$.toolUseId'),
              json_extract(payload_json, '$.data.toolCallId'),
              json_extract(payload_json, '$.data.toolUseId'),
              json_extract(payload_json, '$.data.item.id')
            ) IS NOT NULL
        ) WHERE rank = 1;
        DELETE FROM projection_thread_activities
        WHERE kind LIKE 'tool.%'
          AND COALESCE(
            operation_id,
            json_extract(payload_json, '$.operationId'),
            json_extract(payload_json, '$.toolCallId'),
            json_extract(payload_json, '$.toolUseId'),
            json_extract(payload_json, '$.data.toolCallId'),
            json_extract(payload_json, '$.data.toolUseId'),
            json_extract(payload_json, '$.data.item.id')
          ) IS NOT NULL
          AND activity_id NOT IN (SELECT activity_id FROM compact_activity_survivors);
        DROP TABLE compact_activity_survivors;
        COMMIT;
      `);
      const after = Number(
        candidate.prepare("SELECT COUNT(*) AS value FROM projection_thread_activities").get()
          ?.value ?? 0,
      );
      collapsedHistoricalActivityRows = Math.max(0, before - after);
    } catch (cause) {
      candidate.exec("ROLLBACK");
      throw cause;
    }
    candidate.exec("VACUUM");
    inspectPenkraDatabaseHealth(
      (sql) => candidate.prepare(sql).all() as Array<Record<string, unknown>>,
    );
    const candidateHashes = semanticTableHashes(candidate);
    if (JSON.stringify(candidateHashes) !== JSON.stringify(sourceHashes)) {
      throw new Error("Compact candidate changed canonical semantic state.");
    }
    const candidateThreadHashes = semanticThreadHashes(candidate);
    if (JSON.stringify(candidateThreadHashes) !== JSON.stringify(sourceThreadHashes)) {
      throw new Error("Compact candidate changed per-thread semantic state.");
    }
    const candidateActivityHashes = semanticActivityHashes(candidate);
    if (JSON.stringify(candidateActivityHashes) !== JSON.stringify(sourceActivityHashes)) {
      throw new Error("Compact candidate changed canonical visible activities.");
    }
    const candidateBytes = await regularFileBytes(candidatePath);
    return {
      sourcePath,
      candidatePath,
      sourceBytes: sourceStat.size,
      candidateBytes,
      reclaimedBytes: Math.max(0, sourceStat.size - candidateBytes),
      reclaimedPercent:
        sourceStat.size === 0 ? 0 : ((sourceStat.size - candidateBytes) / sourceStat.size) * 100,
      discardedSettledMessageFragments,
      discardedMaterializedActivityEvents,
      discardedAcknowledgedEvents,
      discardedInternalReceipts,
      collapsedHistoricalActivityRows,
      semanticTableHashes: candidateHashes,
      semanticThreadHashes: candidateThreadHashes,
      semanticActivityHashes: candidateActivityHashes,
      integrityCheck: "ok",
      foreignKeyViolationCount: 0,
    };
  } catch (cause) {
    candidate.close();
    await fs.unlink(candidatePath).catch(() => undefined);
    throw cause;
  } finally {
    try {
      candidate.close();
    } catch {
      // Already closed on a failed verification path.
    }
  }
}

async function selectCompactCandidate(
  sourcePath: string,
  candidatePath: string,
): Promise<DatabaseCutoverReport> {
  if (sourcePath === candidatePath) {
    throw new Error("Compact candidate must differ from the selected database.");
  }
  if (path.dirname(sourcePath) !== path.dirname(candidatePath)) {
    throw new Error(
      "Compact candidate must be in the source database directory for atomic selection.",
    );
  }
  const rollbackPath = `${sourcePath}.pre-cutover.sqlite`;
  let sourceMoved = false;
  let candidateMoved = false;
  try {
    const [sourceStat, candidateStat] = await Promise.all([
      fs.lstat(sourcePath),
      fs.lstat(candidatePath),
    ]);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error(`Database path is not a regular file: ${sourcePath}`);
    }
    if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
      throw new Error(`Compact candidate is not a regular file: ${candidatePath}`);
    }
    try {
      await fs.lstat(rollbackPath);
      throw new Error(`Cutover rollback artifact already exists: ${rollbackPath}`);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }

    const source = new DatabaseSync(sourcePath, { readOnly: true });
    const candidate = new DatabaseSync(candidatePath, { readOnly: true });
    let sourceHashes: Record<string, string>;
    let sourceThreadHashes: Record<string, string>;
    let candidateHashes: Record<string, string>;
    let candidateThreadHashes: Record<string, string>;
    let sourceActivityHashes: Record<string, string>;
    let candidateActivityHashes: Record<string, string>;
    try {
      inspectPenkraDatabaseHealth(
        (sql) => source.prepare(sql).all() as Array<Record<string, unknown>>,
      );
      inspectPenkraDatabaseHealth(
        (sql) => candidate.prepare(sql).all() as Array<Record<string, unknown>>,
      );
      sourceHashes = semanticTableHashes(source);
      sourceThreadHashes = semanticThreadHashes(source);
      candidateHashes = semanticTableHashes(candidate);
      candidateThreadHashes = semanticThreadHashes(candidate);
      sourceActivityHashes = semanticActivityHashes(source);
      candidateActivityHashes = semanticActivityHashes(candidate);
    } finally {
      source.close();
      candidate.close();
    }
    if (JSON.stringify(candidateHashes) !== JSON.stringify(sourceHashes)) {
      throw new Error("Compact candidate changed canonical semantic state.");
    }
    if (JSON.stringify(candidateThreadHashes) !== JSON.stringify(sourceThreadHashes)) {
      throw new Error("Compact candidate changed per-thread semantic state.");
    }
    if (JSON.stringify(candidateActivityHashes) !== JSON.stringify(sourceActivityHashes)) {
      throw new Error("Compact candidate changed canonical visible activities.");
    }

    await fs.rename(sourcePath, rollbackPath);
    sourceMoved = true;
    await fs.rename(candidatePath, sourcePath);
    candidateMoved = true;
    await inspectRegularDatabase(sourcePath);
    return {
      sourcePath,
      selectedCandidatePath: candidatePath,
      rollbackPath,
      semanticTableHashes: candidateHashes,
      semanticThreadHashes: candidateThreadHashes,
      semanticActivityHashes: candidateActivityHashes,
      integrityCheck: "ok",
      foreignKeyViolationCount: 0,
    };
  } catch (cause) {
    if (candidateMoved) {
      await fs.unlink(sourcePath).catch(() => undefined);
    }
    if (sourceMoved) {
      await fs.rename(rollbackPath, sourcePath).catch(() => undefined);
    }
    await fs.unlink(candidatePath).catch(() => undefined);
    throw cause;
  }
}

export async function verifyOfflinePenkraDatabase(dbPath: string): Promise<PenkraDatabaseHealth> {
  return Effect.runPromise(
    withDatabaseLifecycleLock(
      dbPath,
      Effect.tryPromise({
        try: () => inspectRegularDatabase(dbPath),
        catch: (cause) => cause,
      }),
    ),
  );
}

export async function reportOfflinePenkraDatabase(dbPath: string): Promise<DatabaseStorageReport> {
  return Effect.runPromise(
    withDatabaseLifecycleLock(
      dbPath,
      Effect.tryPromise({ try: () => inspectStorageReport(dbPath), catch: (cause) => cause }),
    ),
  );
}

export async function compactOfflinePenkraDatabase(
  sourcePath: string,
  candidatePath: string,
): Promise<DatabaseCompactionReport> {
  return Effect.runPromise(
    withDatabaseLifecycleLock(
      sourcePath,
      Effect.tryPromise({
        try: () => buildCompactCandidate(sourcePath, candidatePath),
        catch: (cause) => cause,
      }),
    ),
  );
}

export async function cutoverOfflinePenkraDatabase(
  sourcePath: string,
  candidatePath: string,
): Promise<DatabaseCutoverReport> {
  return Effect.runPromise(
    withDatabaseLifecycleLock(
      sourcePath,
      Effect.tryPromise({
        try: () => selectCompactCandidate(sourcePath, candidatePath),
        catch: (cause) => cause,
      }),
    ),
  );
}

export async function runDatabaseMaintenanceCli(
  args: ReadonlyArray<string>,
  output: DatabaseMaintenanceOutput = console,
): Promise<number> {
  const [command, dbPath, candidatePath] = args;
  if (
    (command !== "verify" &&
      command !== "report" &&
      command !== "compact" &&
      command !== "cutover") ||
    !dbPath ||
    ((command === "compact" || command === "cutover") && !candidatePath)
  ) {
    output.error(USAGE);
    return 2;
  }
  if (!path.isAbsolute(dbPath)) {
    output.error(`Database path must be absolute: ${dbPath}\n${USAGE}`);
    return 2;
  }
  if ((command === "compact" || command === "cutover") && !path.isAbsolute(candidatePath!)) {
    output.error(`Candidate path must be absolute: ${candidatePath}\n${USAGE}`);
    return 2;
  }

  try {
    const result =
      command === "cutover"
        ? await cutoverOfflinePenkraDatabase(dbPath, candidatePath!)
        : command === "compact"
          ? await compactOfflinePenkraDatabase(dbPath, candidatePath!)
          : command === "report"
            ? await reportOfflinePenkraDatabase(dbPath)
            : await verifyOfflinePenkraDatabase(dbPath);
    output.log(JSON.stringify({ status: "ok", databasePath: dbPath, ...result }, null, 2));
    return 0;
  } catch (cause) {
    output.error(`Database verification failed for ${dbPath}: ${errorMessage(cause)}`);
    return 1;
  }
}

const entryPointNames = new Set([
  "databaseMaintenance.ts",
  "databaseMaintenance.mjs",
  "databaseMaintenance.cjs",
  "penkra-database",
]);

if (process.argv[1] && entryPointNames.has(path.basename(process.argv[1]))) {
  void runDatabaseMaintenanceCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
