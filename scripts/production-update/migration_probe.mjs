// Scratch-only probe of the real migration backup wrapper. The synthetic next
// migration exists only in this process; no application source is changed.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Effect, Logger } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

const [rootArg, databaseArg, logArg, mode] = process.argv.slice(2);
if (!rootArg || !databaseArg || !logArg || !["fail", "commit"].includes(mode ?? "")) {
  throw new Error("expected scratch root, database, log and failure mode");
}
const root = await fs.realpath(rootArg);
const database = await fs.realpath(databaseArg);
const logPath = await fs.realpath(logArg);
const relative = path.relative(root, database);
if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
  throw new Error("database must be inside the scratch root");
}
if (path.relative(root, logPath).startsWith("..")) throw new Error("log must be inside scratch root");
const realHome = process.env.PENKRA_REHEARSAL_REAL_HOME ?? process.env.HOME;
if (!realHome) throw new Error("real home is required");
const productionRoot = path.join(await fs.realpath(realHome), "Penkra");
if (root === productionRoot || productionRoot.startsWith(root + path.sep) || root.startsWith(productionRoot + path.sep)) {
  throw new Error("scratch root overlaps Production");
}

const migrations = await import("../../apps/server/src/persistence/Migrations.ts");
const entries = migrations.migrationEntries;
entries.push([216, "ScratchInjectedMigration", Effect.void]);
const { runWithPreMigrationBackup } = await import("../../apps/server/src/persistence/MigrationBackup.ts");
const { layer } = await import("../../apps/server/src/persistence/NodeSqliteClient.ts");
const { makeServerFileLogger } = await import("../../apps/server/src/serverLogger.ts");
const migration = mode === "fail" ? Effect.fail(new Error("forced scratch migration failure")) :
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE scratch_injected_migration (value TEXT)`;
    yield* sql`INSERT INTO scratch_injected_migration VALUES ('committed')`;
  });

try {
  await Effect.runPromise(
    runWithPreMigrationBackup(database, migration).pipe(
      Effect.provide(layer({ filename: database })),
      Effect.provide(Logger.layer([makeServerFileLogger(logPath)], { mergeWithExisting: false })),
    ),
  );
  if (mode === "fail") throw new Error("forced migration unexpectedly succeeded");
  console.log("SCRATCH_MIGRATION_COMMITTED");
} catch (error) {
  if (mode !== "fail") throw error;
  const marker = JSON.parse(await fs.readFile(database + ".migration-recovery.json", "utf8"));
  if (marker.databasePath !== database || !marker.backupPath || marker.targetVersion !== 216) throw error;
  console.log("SCRATCH_MIGRATION_FAILURE", JSON.stringify(marker));
}
