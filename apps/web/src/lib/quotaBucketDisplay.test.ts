import { describe, expect, it } from "vitest";
import { normalizeServerProviderUsageRateLimit } from "./providerUsageSnapshot";
import { deriveVisibleRateLimitRows } from "./rateLimits";

describe("connection quota bucket display", () => {
  it("does not collapse standard and Spark weekly windows", () => {
    const snapshot = normalizeServerProviderUsageRateLimit({
      provider: "codex",
      source: "provider-runtime-rate-limits",
      updatedAt: "2026-09-05T19:00:00.000Z",
      usageLines: [],
      limits: [
        { bucketId: "codex", window: "Weekly", windowDurationMins: 10080, usedPercent: 66 },
        {
          bucketId: "codex_bengalfox",
          bucketName: "GPT-5.3-Codex-Spark",
          window: "Weekly",
          windowDurationMins: 10080,
          usedPercent: 0,
        },
      ],
    });
    const rows = deriveVisibleRateLimitRows([snapshot!]);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.label, row.remainingPercent])).toEqual([
      ["Weekly", 34],
      ["GPT-5.3-Codex-Spark · Weekly", 100],
    ]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });
});
