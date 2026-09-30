import { describe, expect, it } from "vitest";
import { childDiagnosticSpan, retryDiagnosticAttempt, startDiagnosticTrace } from "./traceContext";

describe("diagnostic trace context", () => {
  it("uses W3C-sized IDs and preserves the trace across spans and retries", () => {
    const root = startDiagnosticTrace();
    const child = childDiagnosticSpan(root);
    const retry = retryDiagnosticAttempt(child);
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/u);
    expect(root.spanId).toMatch(/^[0-9a-f]{16}$/u);
    expect(child.traceId).toBe(root.traceId);
    expect(child.parentSpanId).toBe(root.spanId);
    expect(retry.traceId).toBe(root.traceId);
    expect(retry.attemptId).toMatch(/^[0-9a-f]{16}$/u);
    expect(retry.spanId).not.toBe(child.spanId);
  });
});
