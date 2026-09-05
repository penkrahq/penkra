import { describe, expect, it } from "vitest";
import { codexQuotaObservations, mergeCodexQuotaFacts } from "./codexQuotaBuckets";
import { snapshotFromConnectionRateLimitFact } from "./runtimeFacts";
import { ProviderConnectionId } from "@penkra/contracts";

const at = "2026-09-05T19:00:00.000Z";
const later = "2026-09-05T19:01:00.000Z";
const general = {
  limitId: "codex",
  primary: { usedPercent: 66, windowDurationMins: 10080 },
  secondary: null,
};
const spark = {
  limitId: "codex_bengalfox",
  limitName: "GPT-5.3-Codex-Spark",
  primary: { usedPercent: 0, windowDurationMins: 300 },
  secondary: { usedPercent: 0, windowDurationMins: 10080 },
};

describe("Codex account quota identity", () => {
  it("preserves both buckets when Spark arrives after standard usage", () => {
    const json = mergeCodexQuotaFacts(
      JSON.stringify({ rateLimits: general }),
      at,
      JSON.stringify({ rateLimits: spark }),
      later,
    );
    const snapshot = snapshotFromConnectionRateLimitFact({
      connectionId: ProviderConnectionId.makeUnsafe("pro"),
      provider: "codex",
      limitsJson: json,
      updatedAt: later,
      sourceEventId: "spark",
      status: null,
    });
    expect(snapshot?.limits).toEqual([
      {
        window: "Weekly",
        usedPercent: 66,
        windowDurationMins: 10080,
        bucketId: "codex",
        observedAt: at,
      },
      {
        window: "5h",
        usedPercent: 0,
        windowDurationMins: 300,
        bucketId: "codex_bengalfox",
        bucketName: "GPT-5.3-Codex-Spark",
        observedAt: later,
      },
      {
        window: "Weekly",
        usedPercent: 0,
        windowDurationMins: 10080,
        bucketId: "codex_bengalfox",
        bucketName: "GPT-5.3-Codex-Spark",
        observedAt: later,
      },
    ]);
  });

  it("rejects older observations for the same bucket and replaces removed windows", () => {
    const first = mergeCodexQuotaFacts(undefined, undefined, JSON.stringify(general), later);
    const replay = mergeCodexQuotaFacts(
      first,
      later,
      JSON.stringify({ ...general, primary: { usedPercent: 0 } }),
      at,
    );
    expect(codexQuotaObservations(JSON.parse(replay), later).get("codex")?.bucket.primary).toEqual(
      general.primary,
    );
    const removed = mergeCodexQuotaFacts(
      first,
      later,
      JSON.stringify({ ...general, primary: null }),
      later,
    );
    expect(
      codexQuotaObservations(JSON.parse(removed), later).get("codex")?.bucket.primary,
    ).toBeNull();
  });

  it("reads all windows from multi-bucket login responses, including secondary", () => {
    const observed = codexQuotaObservations(
      { rateLimits: general, rateLimitsByLimitId: { codex: general, codex_bengalfox: spark } },
      at,
    );
    expect([...observed.keys()]).toEqual(["codex", "codex_bengalfox"]);
    expect(observed.get("codex_bengalfox")?.bucket.secondary).toEqual(spark.secondary);
  });

  it("does not assign an unidentified legacy observation to a named bucket", () => {
    const merged = mergeCodexQuotaFacts(
      JSON.stringify({ primary: { usedPercent: 50 } }),
      at,
      JSON.stringify(spark),
      later,
    );
    expect([...codexQuotaObservations(JSON.parse(merged), later).keys()]).toEqual([
      "codex_bengalfox",
    ]);
  });
});
