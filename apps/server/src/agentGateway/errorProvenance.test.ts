import { describe, expect, it } from "vitest";

import {
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  ProviderValidationError,
} from "../provider/Errors.ts";
import { extractGatewayErrorProvenance } from "./errorProvenance.ts";

describe("gateway error provenance", () => {
  it("keeps allow-listed fields while bounding an oversized typed detail", () => {
    const provenance = extractGatewayErrorProvenance(
      new ProviderAdapterValidationError({
        provider: "codex",
        operation: "listModels",
        issue: `${"x".repeat(2_000)} token=do-not-retain`,
      }),
    );

    expect(provenance.source).toBe("provider-adapter");
    expect(provenance.provider).toBe("codex");
    expect(provenance.operation).toBe("listModels");
    expect(provenance.detail).not.toContain("do-not-retain");
    expect(provenance.detail?.length).toBeLessThanOrEqual(1_013);
    expect(provenance.detailTruncated).toBe(true);
  });

  it("bounds and sanitizes operation and method metadata with visible truncation", () => {
    const operation = `operation-${"o".repeat(5_000)}`;
    const method = `method-${"m".repeat(5_000)}`;
    const adapter = extractGatewayErrorProvenance(
      new ProviderAdapterValidationError({
        provider: "codex",
        operation,
        issue: "short secret=TOP_SECRET",
      }),
    );
    const request = extractGatewayErrorProvenance(
      new ProviderAdapterRequestError({
        provider: "codex",
        method,
        detail: "short secret=TOP_SECRET",
      }),
    );

    expect(adapter.operation?.length).toBeLessThanOrEqual(269);
    expect(adapter.operation).toMatch(/^operation-o+… \[truncated\]$/);
    expect(adapter.operationTruncated).toBe(true);
    expect(adapter.detail).toBe("short secret=[redacted]");
    expect(adapter.detail).not.toContain("TOP_SECRET");
    expect(request.method?.length).toBeLessThanOrEqual(269);
    expect(request.method).toMatch(/^method-m+… \[truncated\]$/);
    expect(request.methodTruncated).toBe(true);
    expect(request.detail).toBe("short secret=[redacted]");
    expect(request.detail).not.toContain("TOP_SECRET");
  });

  it("does not enumerate unknown cause objects and marks the typed chain bounded", () => {
    const unknownCause = { config: "must-not-appear", nested: { credential: "secret" } };
    const provenance = extractGatewayErrorProvenance(
      new ProviderValidationError({
        operation: "listModels",
        issue: "typed wrapper",
        cause: unknownCause,
      }),
    );

    expect(provenance.errorKind).toBe("ProviderValidationError");
    expect(provenance.detail).toBe("typed wrapper");
    expect(provenance.causeTruncated).toBe(true);
    expect(JSON.stringify(provenance)).not.toContain("config");
    expect(JSON.stringify(provenance)).not.toContain("credential");
  });

  it("terminates a cyclic typed cause without serializing it", () => {
    const cyclicCause: { cause?: unknown; secret?: string } = { secret: "must-not-appear" };
    cyclicCause.cause = cyclicCause;
    const provenance = extractGatewayErrorProvenance(
      new ProviderAdapterValidationError({
        provider: "codex",
        operation: "listModels",
        issue: "cyclic wrapper",
        cause: cyclicCause,
      }),
    );

    expect(provenance.errorKind).toBe("ProviderAdapterValidationError");
    expect(provenance.causeTruncated).toBe(true);
    expect(provenance.causeDepth).toBe(0);
    expect(JSON.stringify(provenance)).not.toContain("must-not-appear");
  });

  it("terminates cyclic and deep known typed cause chains", () => {
    const cycleA = new ProviderValidationError({ operation: "a", issue: "a" });
    const cycleB = new ProviderValidationError({ operation: "b", issue: "b", cause: cycleA });
    (cycleA as { cause?: unknown }).cause = cycleB;
    const cyclic = extractGatewayErrorProvenance(cycleA);
    expect(cyclic.errorKind).toBe("ProviderValidationError");
    expect(cyclic.operation).toBe("a");
    expect(cyclic.causeDepth).toBe(2);
    expect(cyclic.causeTruncated).toBe(true);

    let deep: ProviderValidationError = new ProviderValidationError({
      operation: "deep-0",
      issue: "deep-0",
    });
    for (let index = 1; index < 8; index += 1) {
      deep = new ProviderValidationError({
        operation: `deep-${index}`,
        issue: `deep-${index}`,
        cause: deep,
      });
    }
    const deepProvenance = extractGatewayErrorProvenance(deep);
    expect(deepProvenance.causeDepth).toBe(4);
    expect(deepProvenance.causeTruncated).toBe(true);
  });

  it("returns an opaque marker for an unknown root value", () => {
    const provenance = extractGatewayErrorProvenance({ config: "must-not-appear" });
    expect(provenance).toEqual({
      source: "unknown",
      errorKind: "unknown",
      provider: null,
      operation: null,
      operationTruncated: false,
      method: null,
      methodTruncated: false,
      detail: null,
      detailTruncated: false,
      causeDepth: 0,
      causeTruncated: false,
    });
  });
});
