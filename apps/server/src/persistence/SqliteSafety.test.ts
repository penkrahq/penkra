import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SqlError } from "effect/unstable/sql/SqlError";
import { describe, expect, it } from "vitest";

import { toPersistenceSqlError } from "./Errors.ts";
import {
  assertSafeSqliteVersion,
  compareSqliteVersions,
  isFatalSqliteDatabaseError,
  isSqliteCorruptionError,
  isSqliteIoError,
  isRetryableSqliteError,
  UnsafeSqliteRuntimeError,
} from "./SqliteSafety.ts";

describe("SQLite safety policy", () => {
  it("requires the first SQLite release containing the WAL-reset fix", () => {
    expect(compareSqliteVersions("3.51.2", "3.51.3")).toBe(-1);
    expect(compareSqliteVersions("3.51.3", "3.51.3")).toBe(0);
    expect(compareSqliteVersions("3.53.3", "3.51.3")).toBe(1);
    expect(compareSqliteVersions("unknown", "3.51.3")).toBeNull();

    expect(() => assertSafeSqliteVersion("3.51.3")).not.toThrow();
    expect(() => assertSafeSqliteVersion("3.51.2")).toThrow(UnsafeSqliteRuntimeError);
    expect(() => assertSafeSqliteVersion("unknown")).toThrow(UnsafeSqliteRuntimeError);
  });

  it("classifies numeric I/O, corrupt, and not-a-database result codes through causes", () => {
    expect(isSqliteIoError({ errcode: 10 })).toBe(true);
    expect(isSqliteIoError({ cause: { errcode: 522 } })).toBe(true);
    expect(isSqliteCorruptionError({ errcode: 11 })).toBe(true);
    expect(isSqliteCorruptionError({ cause: { errcode: 267 } })).toBe(true);
    expect(isSqliteCorruptionError({ errcode: 26 })).toBe(true);
    expect(isFatalSqliteDatabaseError({ errcode: 11 })).toBe(true);
    expect(isFatalSqliteDatabaseError({ errcode: 5 })).toBe(false);
    expect(isFatalSqliteDatabaseError(new Error("database disk image is malformed"))).toBe(false);
  });

  it("retries busy, locked, and I/O results but not constraints", () => {
    for (const errcode of [5, 6, 10, 261, 262, 522]) {
      expect(isRetryableSqliteError({ cause: { errcode } })).toBe(true);
    }
    for (const errcode of [19, 275, 2067, 11, 26]) {
      expect(isRetryableSqliteError({ cause: { errcode } })).toBe(false);
    }
    expect(isRetryableSqliteError(new Error("database is locked"))).toBe(false);
  });

  it("classifies genuine SQLite results through repository error wrappers", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-sqlite-safety-"));
    const filename = path.join(directory, "state.sqlite");
    const owner = new DatabaseSync(filename);
    const contender = new DatabaseSync(filename);
    const captureError = (run: () => void): unknown => {
      try {
        run();
      } catch (error) {
        return error;
      }
      throw new Error("Expected SQLite to reject the statement");
    };
    const wrapLikeRepository = (cause: unknown) =>
      toPersistenceSqlError("test.insert")(
        new SqlError({ cause, message: "Failed to execute statement" }),
      );
    try {
      owner.exec("CREATE TABLE entries(id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
      contender.exec("PRAGMA busy_timeout=0");
      owner.exec("BEGIN IMMEDIATE");
      const busy = captureError(() => contender.exec("BEGIN IMMEDIATE"));
      expect(busy).toMatchObject({ errcode: 5 });
      expect(isRetryableSqliteError(wrapLikeRepository(busy))).toBe(true);
      owner.exec("ROLLBACK");

      owner.exec("INSERT INTO entries(id, label) VALUES (1, 'first')");
      const constraint = captureError(() =>
        owner.exec("INSERT INTO entries(id, label) VALUES (1, 'duplicate')"),
      );
      expect(constraint).toMatchObject({ errcode: 1555 });
      expect(isRetryableSqliteError(wrapLikeRepository(constraint))).toBe(false);
    } finally {
      owner.close();
      contender.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
