import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";

import {
  inspectPenkraDatabaseHealth,
  type PenkraDatabaseHealth,
} from "./persistence/DatabaseHealth.ts";
import { withDatabaseLifecycleLock } from "./persistence/DatabaseLifecycleLock.ts";
import { assertSafeSqliteVersion } from "./persistence/SqliteSafety.ts";

const USAGE = "Usage: penkra-database verify <absolute-database-path>";

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

export async function runDatabaseMaintenanceCli(
  args: ReadonlyArray<string>,
  output: DatabaseMaintenanceOutput = console,
): Promise<number> {
  const [command, dbPath] = args;
  if (command !== "verify" || !dbPath) {
    output.error(USAGE);
    return 2;
  }
  if (!path.isAbsolute(dbPath)) {
    output.error(`Database path must be absolute: ${dbPath}\n${USAGE}`);
    return 2;
  }

  try {
    const health = await verifyOfflinePenkraDatabase(dbPath);
    output.log(JSON.stringify({ status: "ok", databasePath: dbPath, ...health }, null, 2));
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
