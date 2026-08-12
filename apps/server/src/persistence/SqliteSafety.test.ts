import { describe, expect, it } from "vitest";

import {
  assertSafeSqliteVersion,
  compareSqliteVersions,
  isFatalSqliteDatabaseError,
  isSqliteCorruptionError,
  isSqliteIoError,
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
});
