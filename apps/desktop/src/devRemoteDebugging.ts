// FILE: devRemoteDebugging.ts
// Purpose: Validates the opt-in Chromium debugging endpoint used for live Penkra Dev QA.
// Layer: Desktop development infrastructure

export function resolveDevRemoteDebuggingPort(
  environment: Readonly<Record<string, string | undefined>>,
): string | null {
  const value = environment.PENKRA_DEV_REMOTE_DEBUGGING_PORT?.trim();
  if (!value) return null;
  if (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error("PENKRA_DEV_REMOTE_DEBUGGING_PORT must be an integer from 1 through 65535.");
  }
  return value;
}
