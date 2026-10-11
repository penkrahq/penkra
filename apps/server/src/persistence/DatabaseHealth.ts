// FILE: DatabaseHealth.ts
// Purpose: Physical and semantic verification for an offline Penkra SQLite database.

import { assertSafeSqliteVersion } from "./SqliteSafety.ts";

export type DatabaseHealthQuery = (sql: string) => ReadonlyArray<Record<string, unknown>>;

export type PenkraDatabaseHealth = {
  readonly sqliteVersion: string;
  readonly tableCount: number;
  readonly migrationCount: number;
  readonly eventCount: number;
  readonly maxEventSequence: number;
  readonly maxProjectionSequence: number;
  readonly threadCount: number;
};

const REQUIRED_TABLES = [
  "effect_sql_migrations",
  "orchestration_events",
  "projection_state",
  "projection_threads",
] as const;

function finiteInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Penkra database health check returned an invalid ${label}: ${String(value)}`);
  }
  return parsed;
}

function firstValue(row: Record<string, unknown> | undefined): unknown {
  return row ? Object.values(row)[0] : undefined;
}

export function inspectPenkraDatabaseHealth(query: DatabaseHealthQuery): PenkraDatabaseHealth {
  const sqliteVersion = String(
    firstValue(query("SELECT sqlite_version() AS value")[0]) ?? "unknown",
  );
  assertSafeSqliteVersion(sqliteVersion);

  const integrityRows = query("PRAGMA integrity_check");
  const integrityFailures = integrityRows
    .map((row) => String(firstValue(row) ?? "unknown"))
    .filter((result) => result.toLowerCase() !== "ok");
  if (integrityRows.length === 0 || integrityFailures.length > 0) {
    throw new Error(
      `Penkra database failed SQLite integrity_check: ${integrityFailures.join("; ") || "no result"}`,
    );
  }

  const foreignKeyFailures = query("PRAGMA foreign_key_check");
  if (foreignKeyFailures.length > 0) {
    throw new Error(
      `Penkra database failed foreign_key_check with ${foreignKeyFailures.length} violation(s).`,
    );
  }

  const tableRows = query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const tables = new Set(tableRows.map((row) => String(row.name)));
  const missingTables = REQUIRED_TABLES.filter((table) => !tables.has(table));
  if (missingTables.length > 0) {
    throw new Error(`Penkra database is missing required tables: ${missingTables.join(", ")}`);
  }

  const migrationCount = finiteInteger(
    firstValue(query("SELECT COUNT(*) AS value FROM effect_sql_migrations")[0]),
    "migration count",
  );
  if (migrationCount === 0) {
    throw new Error("Penkra database has no recorded migration lineage.");
  }

  const eventSummary = query(
    "SELECT COUNT(*) AS event_count, COALESCE(MAX(sequence), 0) AS max_sequence FROM orchestration_events",
  )[0];
  const eventCount = finiteInteger(eventSummary?.event_count, "event count");
  const maxEventSequence = finiteInteger(eventSummary?.max_sequence, "maximum event sequence");
  const threadCount = finiteInteger(
    firstValue(query("SELECT COUNT(*) AS value FROM projection_threads")[0]),
    "thread count",
  );
  const maxProjectionSequence = finiteInteger(
    firstValue(
      query("SELECT COALESCE(MAX(last_applied_sequence), 0) AS value FROM projection_state")[0],
    ),
    "maximum projection sequence",
  );

  if (threadCount > 0 && eventCount === 0) {
    throw new Error("Penkra database contains projected Threads but no authoritative events.");
  }
  if (maxProjectionSequence > maxEventSequence) {
    throw new Error(
      `Penkra projection state (${maxProjectionSequence}) is ahead of the authoritative event log (${maxEventSequence}).`,
    );
  }

  const invalidEventJsonCount = finiteInteger(
    firstValue(
      query(
        "SELECT COUNT(*) AS value FROM orchestration_events WHERE json_valid(payload_json) = 0 OR json_valid(metadata_json) = 0",
      )[0],
    ),
    "invalid event JSON count",
  );
  if (invalidEventJsonCount > 0) {
    throw new Error(
      `Penkra database contains ${invalidEventJsonCount} authoritative event(s) with invalid JSON.`,
    );
  }

  return {
    sqliteVersion,
    tableCount: tables.size,
    migrationCount,
    eventCount,
    maxEventSequence,
    maxProjectionSequence,
    threadCount,
  };
}
