import type { DesktopBridge, DiagnosticTraceContext } from "@penkra/contracts";

type SendDiagnosticsBridge = Pick<
  DesktopBridge,
  "recordDiagnosticCheckpoint" | "armSendDiagnosticExpectation"
>;

function emitQuietly(operation: (() => Promise<void>) | undefined): void {
  try {
    void operation?.().catch(() => undefined);
  } catch {
    // Diagnostics cannot prevent or delay a send.
  }
}

export function createSendDiagnosticLifecycle(
  trace: DiagnosticTraceContext,
  bridge: SendDiagnosticsBridge | undefined,
): {
  preflight: (threadId?: string) => void;
  dispatch: <T>(threadId: string, send: () => T) => T;
} {
  return {
    preflight(threadId) {
      emitQuietly(
        bridge?.recordDiagnosticCheckpoint
          ? () =>
              bridge.recordDiagnosticCheckpoint!({
                ...trace,
                ...(threadId ? { threadId } : {}),
                flow: "send",
                step: "composer.preflight",
              })
          : undefined,
      );
    },
    dispatch(threadId, send) {
      emitQuietly(
        bridge?.armSendDiagnosticExpectation
          ? () => bridge.armSendDiagnosticExpectation!({ ...trace, threadId })
          : undefined,
      );
      return send();
    },
  };
}
