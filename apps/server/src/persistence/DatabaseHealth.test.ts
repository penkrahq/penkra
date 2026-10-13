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
    CREATE TABLE threads(id TEXT PRIMARY KEY);
    CREATE TABLE thread_items(thread_id TEXT,seq INTEGER,data TEXT);
    INSERT INTO effect_sql_migrations VALUES (1,'Initial');
    INSERT INTO threads VALUES ('thread-1');
    INSERT INTO thread_items VALUES ('thread-1',1,'{}');
  `);
  return database;
}

describe("Penkra database semantic health", () => {
  it("accepts a physically and semantically coherent database", () => {
    const database = makeHealthyDatabase();
    try {
      expect(inspectPenkraDatabaseHealth(query(database))).toMatchObject({
        migrationCount: 1,
        itemCount: 1,
        threadCount: 1,
      });
    } finally {
      database.close();
    }
  });

  it("rejects malformed canonical item JSON", () => {
    const database = makeHealthyDatabase();
    try {
      database.exec("UPDATE thread_items SET data='broken'");
      expect(() => inspectPenkraDatabaseHealth(query(database))).toThrow(/invalid JSON/u);
    } finally {
      database.close();
    }
  });
});
