// FILE: SqliteSafety.ts
// Purpose: Central SQLite runtime and fatal-result safety policy.

export const MINIMUM_SAFE_SQLITE_VERSION = "3.51.3";

const SQLITE_PRIMARY_CODE_MASK = 0xff;
const SQLITE_CORRUPT = 11;
const SQLITE_IOERR = 10;
const SQLITE_NOTADB = 26;
const SQLITE_IO_ERROR_CODES = new Set([SQLITE_IOERR]);
const SQLITE_CORRUPTION_CODES = new Set([SQLITE_CORRUPT, SQLITE_NOTADB]);

function numericVersionParts(version: string): ReadonlyArray<number> | null {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) return null;
  const parts = version.split(".").map(Number);
  return parts.every((part) => Number.isSafeInteger(part) && part >= 0) ? parts : null;
}

export function compareSqliteVersions(left: string, right: string): number | null {
  const leftParts = numericVersionParts(left);
  const rightParts = numericVersionParts(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export class UnsafeSqliteRuntimeError extends Error {
  readonly _tag = "UnsafeSqliteRuntimeError";

  constructor(readonly sqliteVersion: string) {
    super(
      `SQLite ${sqliteVersion} is not allowed to own a Penkra database. ` +
        `SQLite ${MINIMUM_SAFE_SQLITE_VERSION} or newer is required because earlier releases contain the WAL-reset corruption bug.`,
    );
    this.name = "UnsafeSqliteRuntimeError";
  }
}

export function assertSafeSqliteVersion(sqliteVersion: string): void {
  const comparison = compareSqliteVersions(sqliteVersion, MINIMUM_SAFE_SQLITE_VERSION);
  if (comparison === null || comparison < 0) {
    throw new UnsafeSqliteRuntimeError(sqliteVersion);
  }
}

function hasPrimaryResultCode(cause: unknown, expected: ReadonlySet<number>): boolean {
  const seen = new Set<unknown>();
  let current: unknown = cause;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const errcode = (current as { readonly errcode?: unknown }).errcode;
    if (
      typeof errcode === "number" &&
      Number.isInteger(errcode) &&
      expected.has(errcode & SQLITE_PRIMARY_CODE_MASK)
    ) {
      return true;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}

export function isSqliteIoError(cause: unknown): boolean {
  return hasPrimaryResultCode(cause, SQLITE_IO_ERROR_CODES);
}

export function isSqliteCorruptionError(cause: unknown): boolean {
  return hasPrimaryResultCode(cause, SQLITE_CORRUPTION_CODES);
}

export function isFatalSqliteDatabaseError(cause: unknown): boolean {
  return isSqliteIoError(cause) || isSqliteCorruptionError(cause);
}
