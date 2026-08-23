import { ProviderConnectionId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import type { ConnectionRateLimitFactRecord } from "../persistence/Services/ConnectionUsageFacts";
import { snapshotFromConnectionRateLimitFact } from "./runtimeFacts";

const updatedAt = "2026-08-21T12:00:00.000Z";

function fact(limits: unknown): ConnectionRateLimitFactRecord {
  return {
    connectionId: ProviderConnectionId.makeUnsafe("codex-account"),
    provider: "codex",
    limitsJson: JSON.stringify(limits),
    status: null,
    sourceEventId: "event-rate-limits",
    updatedAt,
  };
}

describe("provider runtime usage facts", () => {
  it("normalizes nested Codex app-server windows", () => {
    const snapshot = snapshotFromConnectionRateLimitFact(
      fact({
        rateLimits: {
          rateLimits: {
            primary: {
              usedPercent: 62,
              resetsAt: "2026-08-21T15:00:00.000Z",
              windowDurationMins: 300,
            },
            secondary: {
              usedPercent: 38,
              resetsAt: "2026-08-27T12:00:00.000Z",
              windowDurationMins: 10_080,
            },
          },
        },
      }),
    );

    expect(snapshot).toMatchObject({
      connectionId: "codex-account",
      source: "provider-runtime-rate-limits",
      status: "ok",
      limits: [
        { window: "5h", usedPercent: 62, windowDurationMins: 300 },
        { window: "Weekly", usedPercent: 38, windowDurationMins: 10_080 },
      ],
    });
  });

  it("normalizes Claude utilization facts without depending on credential files", () => {
    const snapshot = snapshotFromConnectionRateLimitFact({
      ...fact({
        limits: [
          {
            window: "five_hour",
            utilization: 0.23,
            resetsAt: 1_787_329_200,
          },
        ],
      }),
      provider: "claudeAgent",
    });

    expect(snapshot?.limits).toEqual([
      {
        window: "5h",
        usedPercent: 23,
        resetsAt: "2026-08-21T16:20:00.000Z",
      },
    ]);
  });

  it("rejects malformed or empty persisted payloads so the caller can use its fallback", () => {
    expect(snapshotFromConnectionRateLimitFact({ ...fact({}), limitsJson: "{" })).toBeNull();
    expect(snapshotFromConnectionRateLimitFact(fact({}))).toBeNull();
  });
});
