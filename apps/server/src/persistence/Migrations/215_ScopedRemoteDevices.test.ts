import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect, it } from "vitest";
import * as NodeSqliteClient from "../NodeSqliteClient";
import createUnscoped from "./214_RemoteDevices";
import scopeDevices from "./215_ScopedRemoteDevices";

describe("scoped RemoteLink trust migration", () => {
  it("replaces the unused table with a required composite owner key", async () => {
    await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE auth_sessions (session_id TEXT PRIMARY KEY)`;
      yield* createUnscoped;
      yield* sql.withTransaction(scopeDevices);
      const columns = yield* sql<{
        name: string;
        notnull: number;
        pk: number;
      }>`PRAGMA table_info(remote_devices)`;
      expect(columns.find((column) => column.name === "scope_key")).toMatchObject({
        notnull: 1,
        pk: 1,
      });
      expect(columns.find((column) => column.name === "device_id")?.pk).toBe(2);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory()), Effect.scoped, Effect.runPromise);
  });

  it("preserves unexpected unowned trust rather than guessing ownership or deleting it", async () => {
    await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE auth_sessions (session_id TEXT PRIMARY KEY)`;
      yield* createUnscoped;
      yield* sql`INSERT INTO auth_sessions VALUES ('session')`;
      yield* sql`INSERT INTO remote_devices VALUES ('phone', 'Phone', ${new Uint8Array(32)}, 'session', '2026-10-25T00:00:00Z', NULL, 1)`;
      const error = yield* Effect.flip(sql.withTransaction(scopeDevices));
      expect(String(error)).toContain("Cannot assign an account");
      expect(yield* sql`SELECT device_id, session_id FROM remote_devices`).toEqual([
        { device_id: "phone", session_id: "session" },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory()), Effect.scoped, Effect.runPromise);
  });
});
