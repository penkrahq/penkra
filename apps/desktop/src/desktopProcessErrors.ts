// FILE: desktopProcessErrors.ts
// Purpose: Classifies process-level errors that need desktop shutdown handling.
// Layer: Desktop main process helpers

import { inspect } from "node:util";

// Fatal exception output can bypass the JavaScript stderr capture. Save the
// original error synchronously without changing the existing exit handling.
export function recordDesktopFatalError(
  error: unknown,
  origin: string,
  writeLog: (message: string) => void,
): void {
  try {
    writeLog(`fatal exception origin=${origin}\n${inspect(error, { customInspect: false })}`);
  } catch {
    // A diagnostic failure must not replace the original fatal exception.
  }
}

export function isBrokenPipeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  return (error as NodeJS.ErrnoException).code === "EPIPE";
}
