import { describe, expect, it } from "vitest";
import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { claudeNativeUsage, codexNativeUsage } from "./nativeUsage.ts";
import { ProviderConnectionId } from "@penkra/contracts";
import type { GetAccountRateLimitsResponse } from "../provider/generated/codex/v2/GetAccountRateLimitsResponse.ts";

describe("native Connection usage", () => {
  it("does not turn a native low percentage into a fraction", () => {
    const report = {
      rate_limits_available: true,
      subscription_type: "max",
      rate_limits: {
        five_hour: { utilization: 0.5, resets_at: null },
        model_scoped: [{ display_name: "Fable", utilization: 30, resets_at: null }],
      },
    } as SDKControlGetUsageResponse;
    expect(claudeNativeUsage(report, 0).limits.map((limit) => limit.usedPercent)).toEqual([
      0.5, 30,
    ]);
  });
  it("does not call unavailable plan limits an authentication failure", () => {
    expect(
      claudeNativeUsage(
        { rate_limits_available: false, rate_limits: null } as SDKControlGetUsageResponse,
        0,
      ).status,
    ).toBe("unsupported");
  });
  it("recognizes a runtime-confirmed signed-out Codex account", () => {
    expect(
      codexNativeUsage({
        connectionId: ProviderConnectionId.make("a"),
        nowMs: 0,
        limits: null,
      }).status,
    ).toBe("needs-auth");
  });
  it("reads limits and credits from the same native response", () => {
    const limits = {
      rateLimits: {
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 },
        secondary: null,
        credits: { hasCredits: true, unlimited: false, balance: "10" },
        planType: "pro",
        limitId: "codex",
        limitName: "Codex",
      },
    } as GetAccountRateLimitsResponse;
    const snapshot = codexNativeUsage({
      connectionId: ProviderConnectionId.make("a"),
      nowMs: 0,
      limits,
    });
    expect(snapshot.limits[0]?.usedPercent).toBe(25);
    expect(snapshot.usageLines).toEqual([{ label: "Credits", value: "$10.00 remaining" }]);
  });
});
