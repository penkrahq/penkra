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
        stream_id TEXT,
        event_type TEXT,
        payload_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
      CREATE TABLE orchestration_command_receipts(
        command_id TEXT PRIMARY KEY,
        result_sequence INTEGER NOT NULL
      );
      CREATE TABLE orchestration_consumer_state(
        consumer_name TEXT PRIMARY KEY,
        last_acked_sequence INTEGER NOT NULL
      );
      CREATE TABLE projection_state(projector TEXT PRIMARY KEY, last_applied_sequence INTEGER NOT NULL);
      CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY);
      CREATE TABLE projection_thread_messages(
        message_id TEXT,
        thread_id TEXT,
        is_streaming INTEGER NOT NULL
      );
      CREATE TABLE projection_thread_activities(
        activity_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        tone TEXT NOT NULL DEFAULT 'tool',
        kind TEXT NOT NULL DEFAULT 'tool.completed',
        summary TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '{}',
        sequence INTEGER,
        created_at TEXT NOT NULL DEFAULT '2026-08-19T00:00:00.000Z',
        operation_id TEXT
      );
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

  it("reports physical storage, row counts, and reclaimable pages", async () => {
    const fixture = makeDatabase();
    const capture = captureOutput();
    try {
      expect(
        await runDatabaseMaintenanceCli(["report", fixture.dbPath], capture.output),
        capture.errors.join("\n"),
      ).toBe(0);
      const report = JSON.parse(capture.logs.join("\n")) as {
        readonly mainFileBytes: number;
        readonly pageCount: number;
        readonly rowCounts: Record<string, number>;
        readonly payloadBytes: Record<string, number>;
        readonly orchestrationEventCounts: Record<string, number>;
        readonly commandReceiptCounts: Record<string, number>;
      };
      expect(report.mainFileBytes).toBeGreaterThan(0);
      expect(report.pageCount).toBeGreaterThan(0);
      expect(report.rowCounts.effect_sql_migrations).toBe(1);
      expect(report.rowCounts.orchestration_events).toBe(0);
      expect(report.payloadBytes.effect_sql_migrations).toBeGreaterThan(0);
      expect(report.orchestrationEventCounts).toEqual({});
      expect(report.commandReceiptCounts).toEqual({});
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("builds a verified compact candidate without mutating the source", async () => {
    const fixture = makeDatabase();
    const candidatePath = path.join(fixture.directory, "state.compact.sqlite");
    const database = new DatabaseSync(fixture.dbPath);
    try {
      database.exec(`
        INSERT INTO projection_threads VALUES ('thread-1');
        INSERT INTO projection_thread_messages VALUES ('message-1', 'thread-1', 0);
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, kind, payload_json, sequence
        ) VALUES
          ('activity-1-start', 'thread-1', 'turn-1', 'tool.started',
           '{"operationId":"operation-1"}', 2),
          ('activity-1', 'thread-1', 'turn-1', 'tool.completed',
           '{"operationId":"operation-1"}', 3);
        INSERT INTO orchestration_events VALUES
          (1, 'thread-1', 'thread.message-sent', '{"messageId":"message-1","streaming":true}', '{}'),
          (2, 'thread-1', 'thread.message-sent', '{"messageId":"message-1","streaming":false}', '{}'),
          (3, 'thread-1', 'thread.activity-appended', '{"activity":{"id":"activity-1"}}', '{}'),
          (10004, 'thread-1', 'thread.meta-updated', '{}', '{}');
        INSERT INTO orchestration_command_receipts VALUES
          ('provider:event-1:delta', 1), ('provider:event-3:activity', 3), ('user-command', 2);
        INSERT INTO orchestration_consumer_state VALUES ('provider-command-reactor.v1', 10004);
        INSERT INTO projection_state VALUES ('threads', 10004);
      `);
    } finally {
      database.close();
    }
    const capture = captureOutput();
    try {
      expect(
        await runDatabaseMaintenanceCli(["compact", fixture.dbPath, candidatePath], capture.output),
      ).toBe(0);
      const report = JSON.parse(capture.logs.join("\n")) as {
        readonly discardedSettledMessageFragments: number;
        readonly discardedMaterializedActivityEvents: number;
        readonly discardedInternalReceipts: number;
        readonly discardedAcknowledgedEvents: number;
        readonly collapsedHistoricalActivityRows: number;
        readonly semanticThreadHashes: Record<string, string>;
      };
      expect(report.discardedSettledMessageFragments).toBe(1);
      expect(report.discardedMaterializedActivityEvents).toBe(1);
      expect(report.discardedInternalReceipts).toBe(2);
      expect(report.discardedAcknowledgedEvents).toBe(3);
      expect(report.collapsedHistoricalActivityRows).toBe(1);
      expect(report.semanticThreadHashes["thread-1"]).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.existsSync(candidatePath)).toBe(true);
      const source = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        expect(
          source.prepare("SELECT COUNT(*) AS value FROM orchestration_events").get()?.value,
        ).toBe(4);
      } finally {
        source.close();
      }
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("cuts over a verified candidate and retains the original rollback artifact", async () => {
    const fixture = makeDatabase();
    const candidatePath = path.join(fixture.directory, "state.compact.sqlite");
    const rollbackPath = `${fixture.dbPath}.pre-cutover.sqlite`;
    const database = new DatabaseSync(fixture.dbPath);
    try {
      database.exec(`
        INSERT INTO projection_threads VALUES ('thread-1');
        INSERT INTO projection_thread_messages VALUES ('message-1', 'thread-1', 0);
        INSERT INTO orchestration_events VALUES
          (1, 'thread-1', 'thread.message-sent', '{"messageId":"message-1","streaming":true}', '{}'),
          (2, 'thread-1', 'thread.message-sent', '{"messageId":"message-1","streaming":false}', '{}'),
          (10003, 'thread-1', 'thread.meta-updated', '{}', '{}');
        INSERT INTO orchestration_command_receipts VALUES ('provider:event-1:delta', 1);
        INSERT INTO orchestration_consumer_state VALUES ('provider-command-reactor.v1', 10003);
        INSERT INTO projection_state VALUES ('threads', 10003);
      `);
    } finally {
      database.close();
    }
    try {
      const compactCapture = captureOutput();
      expect(
        await runDatabaseMaintenanceCli(
          ["compact", fixture.dbPath, candidatePath],
          compactCapture.output,
        ),
        compactCapture.errors.join("\n"),
      ).toBe(0);

      const cutoverCapture = captureOutput();
      expect(
        await runDatabaseMaintenanceCli(
          ["cutover", fixture.dbPath, candidatePath],
          cutoverCapture.output,
        ),
        cutoverCapture.errors.join("\n"),
      ).toBe(0);
      const report = JSON.parse(cutoverCapture.logs.join("\n")) as {
        readonly rollbackPath: string;
      };
      expect(report.rollbackPath).toBe(rollbackPath);
      expect(fs.existsSync(candidatePath)).toBe(false);
      expect(fs.existsSync(rollbackPath)).toBe(true);

      const selected = new DatabaseSync(fixture.dbPath, { readOnly: true });
      const rollback = new DatabaseSync(rollbackPath, { readOnly: true });
      try {
        expect(
          selected.prepare("SELECT COUNT(*) AS value FROM orchestration_events").get()?.value,
        ).toBe(1);
        expect(
          rollback.prepare("SELECT COUNT(*) AS value FROM orchestration_events").get()?.value,
        ).toBe(3);
      } finally {
        selected.close();
        rollback.close();
      }
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("discards a semantically invalid cutover candidate and leaves the source selected", async () => {
    const fixture = makeDatabase();
    const candidatePath = path.join(fixture.directory, "state.invalid.sqlite");
    const source = new DatabaseSync(fixture.dbPath);
    try {
      source.exec(`VACUUM INTO '${candidatePath.replaceAll("'", "''")}'`);
    } finally {
      source.close();
    }
    const candidate = new DatabaseSync(candidatePath);
    try {
      candidate.exec("INSERT INTO projection_threads VALUES ('unexpected-thread')");
    } finally {
      candidate.close();
    }
    const capture = captureOutput();
    try {
      expect(
        await runDatabaseMaintenanceCli(["cutover", fixture.dbPath, candidatePath], capture.output),
      ).toBe(1);
      expect(capture.errors.join("\n")).toContain("projected Threads but no authoritative events");
      expect(fs.existsSync(candidatePath)).toBe(false);
      expect(fs.existsSync(fixture.dbPath)).toBe(true);
      expect(fs.existsSync(`${fixture.dbPath}.pre-cutover.sqlite`)).toBe(false);
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
