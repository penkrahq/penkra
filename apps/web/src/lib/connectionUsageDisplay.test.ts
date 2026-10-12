// FILE: connectionUsageDisplay.test.ts
// Purpose: Locks down provider-usage snapshot normalization edge cases used by
// the live account picker.

import type { ServerProviderUsageSnapshot } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import { connectionUsageEmptyMessage } from "./connectionUsageDisplay";

function snapshot(input: Partial<ServerProviderUsageSnapshot> = {}): ServerProviderUsageSnapshot {
  return {
    provider: "claudeAgent",
    updatedAt: "2026-06-09T12:00:00.000Z",
    limits: [],
    usageLines: [],
    source: "test",
    ...input,
  };
}

describe("connectionUsageDisplay", () => {
  it("explains distinct empty states without collapsing them into a transient error", () => {
    expect(connectionUsageEmptyMessage(undefined)).toBe("No account usage has been reported yet.");
    expect(
      connectionUsageEmptyMessage(
        snapshot({ limits: [{ window: "5h", resetsAt: "2026-06-09T17:00:00.000Z" }] }),
      ),
    ).toBe("A reset window was reported, but no usage percentage is available.");
    expect(connectionUsageEmptyMessage(snapshot({ status: "needs-auth" }))).toBe(
      "Reconnect this account to see usage.",
    );
    expect(connectionUsageEmptyMessage(snapshot({ status: "unsupported" }))).toBe(
      "Usage isn’t available for this account.",
    );
    expect(connectionUsageEmptyMessage(snapshot({ status: "error" }))).toBe(
      "Usage is temporarily unavailable.",
    );
  });
});
