import { describe, expect, it, vi } from "vitest";

import { recordWebConsumedFailure } from "./webFailureCoverage";
import { openIndexedDbDatabase } from "./lib/indexedDb";

describe("browser consumed failure incidents", () => {
  it("records unavailable browser storage without its input values", async () => {
    const recordDiagnosticIncident = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", { desktopBridge: { recordDiagnosticIncident } });
    vi.stubGlobal("indexedDB", undefined);
    try {
      await expect(
        openIndexedDbDatabase({
          name: "private-store-name",
          version: 1,
          storeName: "private-store",
          keyPath: "id",
          label: "private-label",
        }),
      ).rejects.toThrow("IndexedDB is unavailable");
      expect(recordDiagnosticIncident).toHaveBeenCalledWith(
        expect.objectContaining({ code: "APP_OPERATION_FAILED", where: "browser.local_state" }),
      );
      expect(JSON.stringify(recordDiagnosticIncident.mock.calls)).not.toContain("private-");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["state", "browser.local_state"],
    ["runtime", "browser.client_runtime"],
  ] as const)("records %s without exception or user content", (category, where) => {
    const recordDiagnosticIncident = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", { desktopBridge: { recordDiagnosticIncident } });
    try {
      recordWebConsumedFailure(category);
      expect(recordDiagnosticIncident).toHaveBeenCalledOnce();
      expect(recordDiagnosticIncident).toHaveBeenCalledWith({
        traceId: expect.any(String),
        spanId: expect.any(String),
        kind: "command.failed",
        code: "APP_OPERATION_FAILED",
        where,
        severity: "error",
        expected: { accepted: true },
        actual: { accepted: false },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("isolates bridge failures", () => {
    vi.stubGlobal("window", {
      desktopBridge: {
        recordDiagnosticIncident: () => {
          throw new Error("offline");
        },
      },
    });
    try {
      expect(() => recordWebConsumedFailure("runtime")).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
