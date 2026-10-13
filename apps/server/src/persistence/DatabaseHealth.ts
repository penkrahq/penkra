// FILE: DatabaseHealth.ts
// Purpose: Physical and semantic verification for an offline Penkra SQLite database.

import { assertSafeSqliteVersion } from "./SqliteSafety.ts";

export type DatabaseHealthQuery = (sql: string) => ReadonlyArray<Record<string, unknown>>;

export type PenkraDatabaseHealth = {
  readonly sqliteVersion: string;
  readonly tableCount: number;
  readonly migrationCount: number;
  readonly itemCount: number;
  readonly threadCount: number;
};

const REQUIRED_TABLES = ["effect_sql_migrations", "threads", "thread_items"] as const;

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

export function inspectSqliteIntegrity(query: DatabaseHealthQuery) {
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
  return { sqliteVersion, tables };
}

export function inspectPenkraDatabaseHealth(query: DatabaseHealthQuery): PenkraDatabaseHealth {
  const { sqliteVersion, tables } = inspectSqliteIntegrity(query);
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

  const threadCount = finiteInteger(
    firstValue(query("SELECT COUNT(*) AS value FROM threads")[0]),
    "thread count",
  );
  const itemCount = finiteInteger(
    firstValue(query("SELECT COUNT(*) AS value FROM thread_items")[0]),
    "item count",
  );
  const invalid = finiteInteger(
    firstValue(
      query(
        "SELECT COUNT(*) AS value FROM thread_items WHERE data IS NOT NULL AND json_valid(data)=0",
      )[0],
    ),
    "invalid item JSON count",
  );
  if (invalid > 0)
    throw new Error(`Penkra database contains ${invalid} item(s) with invalid JSON.`);
  return { sqliteVersion, tableCount: tables.size, migrationCount, threadCount, itemCount };
}
