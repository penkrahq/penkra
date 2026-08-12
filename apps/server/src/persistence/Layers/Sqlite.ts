import { Effect, Layer, FileSystem, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import {
  inspectPendingMigrationRecovery,
  reclaimOrphanedMigrationArtifacts,
  resumeMarkedMigration,
  runWithPreMigrationBackup,
  type MigrationRecoveryMarker,
} from "../MigrationBackup.ts";
import { ensurePrivateFileSync, repairPrivateFile } from "../../privatePathPermissions.ts";
import { ServerConfig } from "../../config.ts";
import {
  acquireDatabaseLifecycleLock,
  releaseDatabaseLifecycleLock,
} from "../DatabaseLifecycleLock.ts";
import { assertSafeSqliteVersion, isSqliteCorruptionError } from "../SqliteSafety.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
  readonly onFatalError?: (cause: unknown) => void;
};

const makeRuntimeSqliteLayer = (
  config: RuntimeSqliteLayerConfig,
): Layer.Layer<SqlClient.SqlClient> =>
  Effect.sync(() => {
    assertSafeSqliteVersion(process.versions.sqlite ?? "unknown");
    return NodeSqliteClient.layer(config);
  }).pipe(Layer.unwrap);

function errnoCode(cause: unknown): string | undefined {
  const error = cause as (Error & { readonly code?: string; readonly cause?: unknown }) | null;
  return error?.code ?? (error?.cause as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Repair SQLite-owned files only before the database connection is opened.
 *
 * On POSIX systems, closing any file descriptor for a file releases every
 * traditional fcntl lock this process holds for that file. Reopening the live
 * database merely to chmod it therefore silently drops SQLite's EXCLUSIVE
 * lifetime lock while the connection remains open. Existing sidecars are safe
 * to repair here because the lifecycle lock is held and SQLite has not opened
 * the database yet; newly created sidecars inherit the private database mode.
 */
const repairSqliteFilePermissionsBeforeOpen = (dbPath: string) =>
  Effect.promise(async () => {
    await repairPrivateFile(dbPath);
    for (const suffix of ["-wal", "-shm"]) {
      await repairPrivateFile(`${dbPath}${suffix}`).catch((cause) => {
        if (errnoCode(cause) !== "ENOENT") throw cause;
      });
    }
  });

const makeSetup = (dbPath?: string, pendingRecovery: MigrationRecoveryMarker | null = null) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (dbPath) {
        // The runtime owns this database for its entire lifetime (enforced by
        // DatabaseLifecycleLock), so make SQLite enforce the same boundary.
        // This must happen before the first WAL access: SQLite then keeps its
        // WAL index in heap memory instead of memory-mapping a shared `-shm`
        // file that an unrelated sqlite client could truncate or rebuild.
        const lockingModeRows = yield* sql<{ readonly locking_mode: string }>`
          PRAGMA locking_mode = EXCLUSIVE;
        `;
        const lockingMode = lockingModeRows[0]?.locking_mode;
        if (lockingMode?.toLowerCase() !== "exclusive") {
          return yield* Effect.fail(
            new Error(
              `SQLite exclusive locking mode could not be enabled (result: ${lockingMode ?? "unknown"})`,
            ),
          );
        }
      }
      yield* sql`PRAGMA busy_timeout = 5000;`;
      const journalModeRows = yield* sql<{ readonly journal_mode: string }>`
        PRAGMA journal_mode = WAL;
      `;
      const journalMode = journalModeRows[0]?.journal_mode;
      if (journalMode?.toLowerCase() !== "wal") {
        yield* Effect.logWarning("SQLite WAL journal mode could not be enabled", {
          resultingJournalMode: journalMode ?? "unknown",
        });
      }
      // synchronous = NORMAL under WAL preserves database consistency and is
      // safe across application crashes (no corruption, no torn writes). The
      // only accepted risk is that an OS crash or power loss may lose the most
      // recent committed transaction(s) that had not yet been checkpointed.
      // That tradeoff is deliberate: at our per-event write rate, FULL's fsync
      // on every commit is too costly, and losing the last few events on a hard
      // power loss is acceptable.
      yield* sql`PRAGMA synchronous = NORMAL;`;
      yield* sql`PRAGMA foreign_keys = ON;`;
      if (dbPath) {
        // Setting locking_mode changes connection policy; this transaction
        // actually acquires and retains the database lock before startup
        // continues, closing the window where another client could attach.
        yield* sql`BEGIN EXCLUSIVE;`;
        yield* sql`COMMIT;`;
        const sqliteVersionRows = yield* sql<{ readonly sqlite_version: string }>`
          SELECT sqlite_version() AS sqlite_version
        `;
        const sqliteVersion = sqliteVersionRows[0]?.sqlite_version ?? "unknown";
        yield* Effect.logInfo("SQLite database ownership established", {
          databasePath: dbPath,
          sqliteVersion,
          lockingMode: "exclusive",
          journalMode: journalMode ?? "unknown",
          synchronous: "normal",
        });
      }
      // A pending marker means an earlier startup was interrupted mid-migration.
      // Resuming reuses that attempt's snapshot instead of taking a second one,
      // so the fallback stays the last known-good database.
      const migrations = dbPath
        ? pendingRecovery
          ? resumeMarkedMigration(dbPath, pendingRecovery, runMigrations())
          : runWithPreMigrationBackup(dbPath, runMigrations())
        : runMigrations();
      yield* migrations;
    }),
  );

export const makeSqlitePersistenceLive = (dbPath: string) =>
  Effect.acquireRelease(acquireDatabaseLifecycleLock(dbPath), (lock) =>
    releaseDatabaseLifecycleLock(lock).pipe(Effect.orDie),
  ).pipe(
    Effect.flatMap(() =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
        // Ahead of the guard on purpose: a database that fails closed below
        // never reaches the backup path, so this is the only opportunity to
        // reclaim artifacts stranded by an earlier failed startup or restore.
        yield* reclaimOrphanedMigrationArtifacts(dbPath);
        const pendingRecovery = yield* inspectPendingMigrationRecovery(dbPath);
        yield* Effect.sync(() => ensurePrivateFileSync(dbPath));
        yield* repairSqliteFilePermissionsBeforeOpen(dbPath);

        let fatalRestartScheduled = false;
        const onFatalError = (cause: unknown) => {
          if (fatalRestartScheduled) return;
          fatalRestartScheduled = true;
          const category = isSqliteCorruptionError(cause) ? "corruption" : "I/O failure";
          console.error(
            `FatalSqliteDatabaseError: SQLite reported ${category}; exiting without further database access.`,
            cause,
          );
          setImmediate(() => process.exit(1));
        };

        return Layer.provideMerge(
          makeSetup(dbPath, pendingRecovery),
          makeRuntimeSqliteLayer({ filename: dbPath, onFatalError }),
        );
      }),
    ),
    Layer.unwrap,
  );

export const SqlitePersistenceMemory = Layer.provideMerge(
  makeSetup(),
  makeRuntimeSqliteLayer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), ({ dbPath }) => makeSqlitePersistenceLive(dbPath)),
);
