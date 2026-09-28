import type { DiagnosticTraceContext } from "@penkra/contracts";

function randomHex(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function startDiagnosticTrace(): DiagnosticTraceContext {
  return { traceId: randomHex(16), spanId: randomHex(8) };
}

export function childDiagnosticSpan(parent: DiagnosticTraceContext): DiagnosticTraceContext {
  return {
    traceId: parent.traceId,
    spanId: randomHex(8),
    parentSpanId: parent.spanId,
    ...(parent.attemptId ? { attemptId: parent.attemptId } : {}),
  };
}

export function retryDiagnosticAttempt(parent: DiagnosticTraceContext): DiagnosticTraceContext {
  return { ...childDiagnosticSpan(parent), attemptId: randomHex(8) };
}
