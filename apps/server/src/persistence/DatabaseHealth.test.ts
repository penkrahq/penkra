import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { inspectPenkraDatabaseHealth } from "./DatabaseHealth.ts";

function query(database: DatabaseSync) {
  return (sql: string) => database.prepare(sql).all() as Array<Record<string, unknown>>;
}

function makeHealthyDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
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
    INSERT INTO orchestration_events VALUES (1, '{}', '{}');
    INSERT INTO projection_state VALUES ('threads', 1);
    INSERT INTO projection_threads VALUES ('thread-1');
  `);
  return database;
}

describe("Penkra database semantic health", () => {
  it("accepts a physically and semantically coherent database", () => {
    const database = makeHealthyDatabase();
    try {
      expect(inspectPenkraDatabaseHealth(query(database))).toMatchObject({
        migrationCount: 1,
        eventCount: 1,
        maxEventSequence: 1,
        maxProjectionSequence: 1,
        threadCount: 1,
      });
    } finally {
      database.close();
    }
  });

  it("rejects a physically valid recovery that lost its authoritative events", () => {
    const database = makeHealthyDatabase();
    try {
      database.exec("DELETE FROM orchestration_events");
      expect(() => inspectPenkraDatabaseHealth(query(database))).toThrow(
        /projected Threads but no authoritative events/u,
      );
    } finally {
      database.close();
    }
  });

  it("rejects projection state ahead of the authoritative event log", () => {
    const database = makeHealthyDatabase();
    try {
      database.exec("UPDATE projection_state SET last_applied_sequence = 2");
      expect(() => inspectPenkraDatabaseHealth(query(database))).toThrow(
        /ahead of the authoritative event log/u,
      );
    } finally {
      database.close();
    }
  });
});
