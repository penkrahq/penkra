import { ProviderConnectionId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import type { ConnectionRateLimitFactRecord } from "../persistence/Services/ConnectionUsageFacts";
import {
  mergeConnectionUsageSnapshots,
  snapshotFromConnectionRateLimitFact,
  usageLinesFromConnectionDailyFacts,
} from "./runtimeFacts";

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

  it("preserves the real Claude reset-only rate-limit event without inventing utilization", () => {
    const snapshot = snapshotFromConnectionRateLimitFact({
      ...fact({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          resetsAt: 1_787_510_400,
          rateLimitType: "five_hour",
          overageStatus: "rejected",
        },
      }),
      provider: "claudeAgent",
    });

    expect(snapshot?.limits).toEqual([
      {
        window: "5h",
        resetsAt: "2026-08-23T18:40:00.000Z",
        windowDurationMins: 300,
      },
    ]);
  });

  it("merges a reset-only runtime fact with fetched Claude utilization", () => {
    const runtime = snapshotFromConnectionRateLimitFact({
      ...fact({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          resetsAt: 1_787_510_400,
          rateLimitType: "five_hour",
        },
      }),
      provider: "claudeAgent",
    });
    const merged = mergeConnectionUsageSnapshots({
      runtime,
      fetched: {
        provider: "claudeAgent",
        connectionId: ProviderConnectionId.makeUnsafe("codex-account"),
        updatedAt,
        limits: [{ window: "5h", usedPercent: 41, windowDurationMins: 300 }],
        usageLines: [],
        source: "claude-oauth-usage",
        status: "ok",
      },
    });

    expect(merged.limits).toEqual([
      {
        window: "5h",
        usedPercent: 41,
        resetsAt: "2026-08-23T18:40:00.000Z",
        windowDurationMins: 300,
      },
    ]);
  });

  it("keeps a reset-only runtime fact when the live Claude fetch is unavailable", () => {
    const runtime = snapshotFromConnectionRateLimitFact({
      ...fact({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          resetsAt: 1_787_510_400,
          rateLimitType: "five_hour",
        },
      }),
      provider: "claudeAgent",
    });
    const merged = mergeConnectionUsageSnapshots({
      runtime,
      fetched: {
        provider: "claudeAgent",
        connectionId: ProviderConnectionId.makeUnsafe("codex-account"),
        updatedAt,
        limits: [],
        usageLines: [],
        source: "claude-oauth-usage",
        status: "error",
        detail: "Usage fetch failed unexpectedly.",
      },
    });

    expect(merged).toMatchObject({
      status: "ok",
      detail: "Usage fetch failed unexpectedly.",
      limits: [{ window: "5h", resetsAt: "2026-08-23T18:40:00.000Z" }],
    });
  });

  it("does not let a stale runtime fact conceal a reconnect requirement", () => {
    const runtime = snapshotFromConnectionRateLimitFact({
      ...fact({
        type: "rate_limit_event",
        rate_limit_info: { resetsAt: 1_787_510_400, rateLimitType: "five_hour" },
      }),
      provider: "claudeAgent",
    });
    const fetched = {
      provider: "claudeAgent" as const,
      connectionId: ProviderConnectionId.makeUnsafe("codex-account"),
      updatedAt,
      limits: [],
      usageLines: [],
      source: "claude-oauth-usage",
      status: "needs-auth" as const,
      detail: "Reconnect this account.",
    };

    expect(mergeConnectionUsageSnapshots({ runtime, fetched })).toEqual(fetched);
  });

  it("builds account-scoped usage lines from persisted daily totals", () => {
    const connectionId = ProviderConnectionId.makeUnsafe("codex-account");
    expect(
      usageLinesFromConnectionDailyFacts({
        nowMs: Date.parse("2026-08-23T16:00:00.000Z"),
        facts: [
          {
            utcDay: "2026-08-23",
            connectionId,
            provider: "claudeAgent",
            inputTokens: 507_966,
            outputTokens: 39_175,
            reasoningOutputTokens: 0,
            turns: 19,
            updatedAt,
          },
          {
            utcDay: "2026-08-22",
            connectionId,
            provider: "claudeAgent",
            inputTokens: 938_975,
            outputTokens: 78_803,
            reasoningOutputTokens: 0,
            turns: 30,
            updatedAt,
          },
        ],
      }),
    ).toEqual([
      { label: "Today", value: "547.1K tokens", subtitle: "19 turns" },
      { label: "7d", value: "2M tokens", subtitle: "49 turns" },
      { label: "30d", value: "2M tokens", subtitle: "49 turns" },
    ]);
  });

  it("rejects malformed or empty persisted payloads so the caller can use its fallback", () => {
    expect(snapshotFromConnectionRateLimitFact({ ...fact({}), limitsJson: "{" })).toBeNull();
    expect(snapshotFromConnectionRateLimitFact(fact({}))).toBeNull();
  });
});
