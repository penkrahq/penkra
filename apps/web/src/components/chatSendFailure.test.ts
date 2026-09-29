import { afterEach, describe, expect, it, vi } from "vitest";
import { recordChatSendFailure } from "./chatSendFailure";

afterEach(() => vi.unstubAllGlobals());

describe("send failure diagnostics", () => {
  it("records a failed preflight on its send trace without message content", () => {
    const recordDiagnosticIncident = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", { desktopBridge: { recordDiagnosticIncident } });
    recordChatSendFailure("SEND_PREFLIGHT_REJECTED", {
      traceId: "ab".repeat(16),
      spanId: "cd".repeat(8),
    });
    expect(recordDiagnosticIncident).toHaveBeenCalledWith({
      traceId: "ab".repeat(16),
      spanId: "cd".repeat(8),
      kind: "external.failed",
      code: "SEND_PREFLIGHT_REJECTED",
      where: "browser.send",
      severity: "error",
      expected: { accepted: true },
      actual: { accepted: false },
    });
  });
});
