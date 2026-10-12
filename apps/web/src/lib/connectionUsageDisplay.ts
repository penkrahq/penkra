// FILE: connectionUsageDisplay.ts
// Purpose: Normalize provider usage snapshots returned by the server into the
// same shapes consumed by the shared usage/rate-limit UI in the web app.

import type { ServerProviderUsageSnapshot } from "@penkra/contracts";

import type { ProviderRateLimit } from "./rateLimits";

export function connectionUsageEmptyMessage(
  snapshot: ServerProviderUsageSnapshot | undefined,
): string {
  switch (snapshot?.status) {
    case "needs-auth":
      return "Reconnect this account to see usage.";
    case "unsupported":
      return "Usage isn’t available for this account.";
    case "error":
      return "Usage is temporarily unavailable.";
    default:
      return snapshot && snapshot.limits.length > 0
        ? "A reset window was reported, but no usage percentage is available."
        : "No account usage has been reported yet.";
  }
}

export function normalizeServerProviderUsageRateLimit(
  snapshot: ServerProviderUsageSnapshot | null | undefined,
): ProviderRateLimit | null {
  if (!snapshot || snapshot.limits.length === 0) {
    return null;
  }

  return {
    provider: snapshot.provider,
    updatedAt: snapshot.updatedAt,
    limits: snapshot.limits.map((limit) => ({
      window: limit.window,
      ...(limit.bucketId ? { bucketId: limit.bucketId } : {}),
      ...(limit.bucketName ? { bucketName: limit.bucketName } : {}),
      ...(limit.observedAt ? { observedAt: limit.observedAt } : {}),
      ...(limit.usedPercent !== undefined ? { usedPercent: limit.usedPercent } : {}),
      ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
      ...(limit.windowDurationMins !== undefined
        ? { windowDurationMins: limit.windowDurationMins }
        : {}),
    })),
  };
}
