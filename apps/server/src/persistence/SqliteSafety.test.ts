import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SqlError, classifySqliteError } from "effect/sql/SqlError";
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
});
