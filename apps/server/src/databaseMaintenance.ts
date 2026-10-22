import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { Effect, Schema } from "effect";

import {
  inspectPenkraDatabaseHealth,
  type PenkraDatabaseHealth,
} from "./persistence/DatabaseHealth.ts";
import { withDatabaseLifecycleLock } from "./persistence/DatabaseLifecycleLock.ts";
import { assertSafeSqliteVersion } from "./persistence/SqliteSafety.ts";
import { migrationBackupDirectory } from "./persistence/MigrationBackup.ts";

const USAGE =
  "Usage: penkra-database <verify|report> <absolute-database-path> | <snapshot|compact|cutover> <absolute-source-path> <absolute-candidate-path>";

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
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
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
  readonly nativeOwners: ReadonlyArray<{
    readonly threadId: string;
    readonly provider: string;
    readonly connectionId: string | null;
    readonly nativeStateId: string | null;
    readonly providerSessionId: string | null;
    readonly archivedAt: string | null;
  }> | null;
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
};
export type DatabaseCompactionReport = {
  readonly sourcePath: string;
  readonly candidatePath: string;
  readonly sourceBytes: number;
  readonly candidateBytes: number;
  readonly reclaimedBytes: number;
  readonly reclaimedPercent: number;
  readonly semanticTableHashes: Readonly<Record<string, string>>;
  readonly integrityCheck: "ok";
  readonly foreignKeyViolationCount: 0;
};
export type DatabaseCutoverReport = {
  readonly sourcePath: string;
  readonly selectedCandidatePath: string;
  readonly rollbackPath: string;
  readonly semanticTableHashes: Readonly<Record<string, string>>;
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
    const threadColumns = new Set(
      (
        database.prepare("SELECT name FROM pragma_table_info('threads')").all() as {
          name: string;
        }[]
      ).map((column) => column.name),
    );
    const nativeOwners = [
      "id",
      "provider",
      "connection_id",
      "native_state_id",
      "provider_session_id",
      "archived_at",
      "deleted_at",
    ].every((name) => threadColumns.has(name))
      ? database
          .prepare(`SELECT id AS threadId, provider, connection_id AS connectionId,
          native_state_id AS nativeStateId, provider_session_id AS providerSessionId,
          archived_at AS archivedAt FROM threads WHERE deleted_at IS NULL ORDER BY id`)
          .all()
          .map((row) =>
            Schema.decodeUnknownSync(
              Schema.Struct({
                threadId: Schema.String,
                provider: Schema.String,
                connectionId: Schema.NullOr(Schema.String),
                nativeStateId: Schema.NullOr(Schema.String),
                providerSessionId: Schema.NullOr(Schema.String),
                archivedAt: Schema.NullOr(Schema.String),
              }),
            )(row),
          )
      : null;
    return {
      ...health,
      nativeOwners,
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
    };
  } finally {
    database.close();
  }
}

function quoteSqlIdentifier(value: string): string {
  return '"' + value.replaceAll('"', '""') + '"';
}
function semanticTableHashes(database: DatabaseSync): Record<string, string> {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  const derived = new Set(
    (database.prepare("PRAGMA table_list").all() as Array<{ name: string; type: string }>)
      .filter((row) => row.type === "shadow")
      .map((row) => row.name),
  );
  const hashes: Record<string, string> = {};
  for (const { name } of tables) {
    if (derived.has(name)) continue;
    const columns = database
      .prepare(`PRAGMA table_info(${quoteSqlIdentifier(name)})`)
      .all() as Array<{ name: string }>;
    const rows = database
      .prepare(
        `SELECT * FROM ${quoteSqlIdentifier(name)} ORDER BY ${columns.map((column) => quoteSqlIdentifier(column.name)).join(",")}`,
      )
      .all();
    hashes[name] = createHash("sha256")
      .update(
        JSON.stringify(rows, (_key, value) => (typeof value === "bigint" ? String(value) : value)),
      )
      .digest("hex");
  }
  return hashes;
}
async function buildCompactCandidate(
  sourcePath: string,
  candidatePath: string,
): Promise<DatabaseCompactionReport> {
  if (sourcePath === candidatePath) throw new Error("Candidate must differ from the source.");
  await inspectRegularDatabase(sourcePath);
  try {
    await fs.lstat(candidatePath);
    throw new Error(`Candidate already exists: ${candidatePath}`);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const source = new DatabaseSync(sourcePath);
  let hashes: Record<string, string>;
  try {
    source.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
    hashes = semanticTableHashes(source);
    source.exec(`VACUUM INTO '${candidatePath.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }
  try {
    await inspectRegularDatabase(candidatePath);
    const candidate = new DatabaseSync(candidatePath, { readOnly: true });
    try {
      if (JSON.stringify(semanticTableHashes(candidate)) !== JSON.stringify(hashes))
        throw new Error("Compact candidate changed canonical data.");
    } finally {
      candidate.close();
    }
    const sourceBytes = await regularFileBytes(sourcePath),
      candidateBytes = await regularFileBytes(candidatePath);
    return {
      sourcePath,
      candidatePath,
      sourceBytes,
      candidateBytes,
      reclaimedBytes: sourceBytes - candidateBytes,
      reclaimedPercent:
        sourceBytes === 0 ? 0 : (100 * (sourceBytes - candidateBytes)) / sourceBytes,
      semanticTableHashes: hashes,
      integrityCheck: "ok",
      foreignKeyViolationCount: 0,
    };
  } catch (cause) {
    await fs.unlink(candidatePath).catch(() => undefined);
    throw cause;
  }
}
async function selectCompactCandidate(
  sourcePath: string,
  candidatePath: string,
): Promise<DatabaseCutoverReport> {
  if (sourcePath === candidatePath) throw new Error("Candidate must differ from the source.");
  const rollbackPath = sourcePath + ".pre-cutover.sqlite";
  try {
    await fs.lstat(rollbackPath);
    throw new Error(`Cutover rollback artifact already exists: ${rollbackPath}`);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  let hashes: Record<string, string>;
  try {
    await inspectRegularDatabase(sourcePath);
    await inspectRegularDatabase(candidatePath);
    const source = new DatabaseSync(sourcePath, { readOnly: true }),
      candidate = new DatabaseSync(candidatePath, { readOnly: true });
    try {
      hashes = semanticTableHashes(source);
      if (JSON.stringify(hashes) !== JSON.stringify(semanticTableHashes(candidate)))
        throw new Error("Cutover candidate changed canonical data.");
    } finally {
      source.close();
      candidate.close();
    }
  } catch (cause) {
    await fs.unlink(candidatePath).catch(() => undefined);
    throw cause;
  }
  await fs.rename(sourcePath, rollbackPath);
  try {
    await fs.rename(candidatePath, sourcePath);
  } catch (cause) {
    await fs.rename(rollbackPath, sourcePath);
    throw cause;
  }
  return {
    sourcePath,
    selectedCandidatePath: candidatePath,
    rollbackPath,
    semanticTableHashes: hashes,
    integrityCheck: "ok",
    foreignKeyViolationCount: 0,
  };
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

/** A closed, lifecycle-locked source is read-only; SQLite owns the consistent copy. */
export async function snapshotOfflinePenkraDatabase(sourcePath: string, candidatePath: string) {
  return Effect.runPromise(
    withDatabaseLifecycleLock(
      sourcePath,
      withDatabaseLifecycleLock(
        candidatePath,
        Effect.tryPromise(async () => {
          if (sourcePath === candidatePath)
            throw new Error("Snapshot must differ from its source.");
          const stat = await fs.lstat(sourcePath);
          if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error("Snapshot source must be a regular database file.");
          assertSafeSqliteVersion(process.versions.sqlite ?? "unknown");
          const source = new DatabaseSync(sourcePath, { readOnly: true });
          try {
            inspectPenkraDatabaseHealth(
              (sql) => source.prepare(sql).all() as Array<Record<string, unknown>>,
            );
            // VACUUM INTO refuses an existing non-empty destination. Refuse even an empty one.
            try {
              await fs.lstat(candidatePath);
              throw new Error("Snapshot destination already exists.");
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
            }
            source.exec(`VACUUM INTO '${candidatePath.replaceAll("'", "''")}'`);
            await fs.chmod(candidatePath, 0o600);
          } finally {
            source.close();
          }
          const candidate = new DatabaseSync(candidatePath, { readOnly: true });
          try {
            const health = inspectPenkraDatabaseHealth(
              (sql) => candidate.prepare(sql).all() as Array<Record<string, unknown>>,
            );
            return { sourcePath, candidatePath, integrityCheck: "ok", ...health };
          } finally {
            candidate.close();
          }
        }),
      ),
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
        try: () =>
          Effect.runPromise(
            withDatabaseLifecycleLock(
              candidatePath,
              Effect.tryPromise({
                try: () => selectCompactCandidate(sourcePath, candidatePath),
                catch: (cause) => cause,
              }),
            ),
          ),
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
      command !== "snapshot" &&
      command !== "cutover") ||
    !dbPath ||
    ((command === "compact" || command === "cutover" || command === "snapshot") && !candidatePath)
  ) {
    output.error(USAGE);
    return 2;
  }
  if (!path.isAbsolute(dbPath)) {
    output.error(`Database path must be absolute: ${dbPath}\n${USAGE}`);
    return 2;
  }
  if (
    (command === "compact" || command === "cutover" || command === "snapshot") &&
    !path.isAbsolute(candidatePath!)
  ) {
    output.error(`Candidate path must be absolute: ${candidatePath}\n${USAGE}`);
    return 2;
  }

  try {
    const result =
      command === "snapshot"
        ? await snapshotOfflinePenkraDatabase(dbPath, candidatePath!)
        : command === "cutover"
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
