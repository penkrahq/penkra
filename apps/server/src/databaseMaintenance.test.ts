import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { runDatabaseMaintenanceCli } from "./databaseMaintenance.ts";
import {
  acquireDatabaseLifecycleLock,
  releaseDatabaseLifecycleLock,
} from "./persistence/DatabaseLifecycleLock.ts";

function makeDatabase(): { readonly directory: string; readonly dbPath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-database-maintenance-"));
  const dbPath = path.join(directory, "state.sqlite");
  const database = new DatabaseSync(dbPath);
  try {
    database.exec(`
      CREATE TABLE effect_sql_migrations(migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE orchestration_events(
        sequence INTEGER PRIMARY KEY,
        payload_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
      CREATE TABLE projection_state(projector TEXT PRIMARY KEY, last_applied_sequence INTEGER NOT NULL);
      CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY);
      INSERT INTO effect_sql_migrations VALUES (1, 'OrchestrationEvents');
    `);
  } finally {
    database.close();
  }
  return { directory, dbPath };
}

function captureOutput() {
  const errors: string[] = [];
  const logs: string[] = [];
  return {
    output: {
      error: (message: string) => errors.push(message),
      log: (message: string) => logs.push(message),
    },
    errors,
    logs,
  };
}

describe("offline database maintenance CLI", () => {
  it("ships the lifecycle-aware database command from the bundled server package", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { readonly bin?: Record<string, string> };

    expect(packageJson.bin?.["penkra-database"]).toBe("dist/databaseMaintenance.mjs");
  });

  it("verifies a coherent Penkra database while it is offline", async () => {
    const fixture = makeDatabase();
    const capture = captureOutput();
    try {
      expect(await runDatabaseMaintenanceCli(["verify", fixture.dbPath], capture.output)).toBe(0);
      expect(capture.errors).toEqual([]);
      expect(capture.logs.join("\n")).toContain('"status": "ok"');
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("refuses verification while a Penkra lifecycle owner is live", async () => {
    const fixture = makeDatabase();
    const capture = captureOutput();
    const lock = await Effect.runPromise(acquireDatabaseLifecycleLock(fixture.dbPath));
    try {
      expect(await runDatabaseMaintenanceCli(["verify", fixture.dbPath], capture.output)).toBe(1);
      expect(capture.errors.join("\n")).toContain("DatabaseLifecycleLockedError");
      expect(capture.logs).toEqual([]);
    } finally {
      await Effect.runPromise(releaseDatabaseLifecycleLock(lock));
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("rejects a physically corrupt database", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-database-corrupt-"));
    const dbPath = path.join(directory, "state.sqlite");
    const capture = captureOutput();
    fs.writeFileSync(dbPath, Buffer.alloc(4_096));
    try {
      expect(await runDatabaseMaintenanceCli(["verify", dbPath], capture.output)).toBe(1);
      expect(capture.errors.join("\n")).toMatch(/not a database|malformed/u);
      expect(capture.logs).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
