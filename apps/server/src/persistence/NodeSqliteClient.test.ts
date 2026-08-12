import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vitest";

import * as SqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("NodeSqliteClient", (it) => {
  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");
    }),
  );
});

describe("fatal SQLite result handling", () => {
  it("recognizes SQLite primary and extended I/O result codes through causes", () => {
    expect(SqliteClient.isSqliteIoError({ errcode: 10 })).toBe(true);
    expect(SqliteClient.isSqliteIoError({ cause: { errcode: 522 } })).toBe(true);
    expect(SqliteClient.isSqliteIoError({ errcode: 5 })).toBe(false);
    expect(SqliteClient.isSqliteIoError(new Error("disk I/O error"))).toBe(false);
  });

  it("reports a poisoned WAL connection once and keeps the original fatal failure", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-sqlite-ioerr-"));
    const dbPath = path.join(directory, "state.sqlite");
    const owner = new DatabaseSync(dbPath);
    try {
      owner.exec("PRAGMA journal_mode=WAL; CREATE TABLE entries(id INTEGER PRIMARY KEY)");
      owner.exec("INSERT INTO entries DEFAULT VALUES");
      fs.unlinkSync(`${dbPath}-wal`);

      const fatalCauses: unknown[] = [];
      const program = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const first = yield* Effect.exit(sql.unsafe("PRAGMA journal_mode=WAL"));
        const second = yield* Effect.exit(sql.unsafe("SELECT 1"));
        return { first, second };
      }).pipe(
        Effect.scoped,
        Effect.provide(
          SqliteClient.layer({
            filename: dbPath,
            onFatalError: (cause) => fatalCauses.push(cause),
          }),
        ),
      );

      const result = await Effect.runPromise(program);
      expect(result.first._tag).toBe("Failure");
      expect(result.second._tag).toBe("Failure");
      expect(fatalCauses).toHaveLength(1);
      expect(SqliteClient.isSqliteIoError(fatalCauses[0])).toBe(true);
    } finally {
      owner.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("poisons the connection after SQLite reports database corruption", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-sqlite-corrupt-"));
    const dbPath = path.join(directory, "state.sqlite");
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE entries(id INTEGER PRIMARY KEY)");
    seed.close();
    const handle = fs.openSync(dbPath, "r+");
    try {
      fs.writeSync(handle, Buffer.alloc(4_096), 0, 4_096, 0);
    } finally {
      fs.closeSync(handle);
    }

    const fatalCauses: unknown[] = [];
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const first = yield* Effect.exit(sql.unsafe("SELECT * FROM sqlite_master"));
          const second = yield* Effect.exit(sql.unsafe("SELECT 1"));
          return { first, second };
        }).pipe(
          Effect.scoped,
          Effect.provide(
            SqliteClient.layer({
              filename: dbPath,
              onFatalError: (cause) => fatalCauses.push(cause),
            }),
          ),
        ),
      );

      expect(result.first._tag).toBe("Failure");
      expect(result.second._tag).toBe("Failure");
      expect(fatalCauses).toHaveLength(1);
      expect(SqliteClient.isSqliteCorruptionError(fatalCauses[0])).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
