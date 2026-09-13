import { opendirSync, statSync, type Dir } from "node:fs";

/**
 * Missing project CWDs often surface as spawn ENOENT (Node/Effect access the
 * working directory before the binary). Callers must distinguish that from a
 * missing Codex installation so the UI can prompt relocate/reconnect.
 */
export function formatMissingCodexWorkingDirectoryError(cwd: string): string {
  return `Project working directory no longer exists: ${cwd}. Relocate or reconnect the project in Penkra.`;
}

export function formatInaccessibleCodexWorkingDirectoryError(cwd: string): string {
  return `Penkra cannot access the project working directory: ${cwd}. Choose that folder again in Penkra to restore access.`;
}

export class CodexWorkingDirectoryAccessError extends Error {
  readonly phase = "workspace-read-preflight" as const;

  constructor(
    readonly cwd: string,
    readonly osErrorCode: "EACCES" | "EPERM",
    cause: unknown,
  ) {
    super(formatInaccessibleCodexWorkingDirectoryError(cwd), { cause });
    this.name = "CodexWorkingDirectoryAccessError";
  }
}

export function assertCodexWorkingDirectoryExists(
  cwd: string,
  openDirectory: (path: string) => Dir = opendirSync,
  readStats: typeof statSync = statSync,
): void {
  try {
    const stats = readStats(cwd);
    if (!stats.isDirectory()) {
      throw new Error(
        `Project working directory is not a directory: ${cwd}. Relocate or reconnect the project in Penkra.`,
      );
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(formatMissingCodexWorkingDirectoryError(cwd));
    }
    if (code === "EPERM" || code === "EACCES") {
      throw new CodexWorkingDirectoryAccessError(cwd, code, error);
    }
    throw error;
  }
  try {
    openDirectory(cwd).closeSync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      throw new CodexWorkingDirectoryAccessError(cwd, code, error);
    }
    throw error;
  }
}
