// FILE: nativeResumeIdentity.ts
// Purpose: Adapter-exact identity extraction for canonical native resume cursors.

import type { ProviderKind } from "@penkra/contracts";

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

export function providerNativeResumeIdentity(
  harness: ProviderKind,
  cursor: unknown,
): string | null {
  if (harness === "codex") {
    return cursor && typeof cursor === "object" && !Array.isArray(cursor)
      ? nonEmpty((cursor as Record<string, unknown>).threadId)
      : null;
  }
  if (harness === "claudeAgent") {
    return cursor && typeof cursor === "object" && !Array.isArray(cursor)
      ? nonEmpty((cursor as Record<string, unknown>).resume)
      : null;
  }
  if (harness === "opencode") {
    if (typeof cursor === "string") return nonEmpty(cursor);
    return cursor && typeof cursor === "object" && !Array.isArray(cursor)
      ? nonEmpty((cursor as Record<string, unknown>).openCodeSessionId)
      : null;
  }
  return null;
}
