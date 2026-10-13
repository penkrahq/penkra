// Desktop lifecycle cancellation for the native backend readiness signal.

export class BackendReadinessAbortedError extends Error {
  constructor() {
    super("Backend readiness wait was aborted.");
    this.name = "BackendReadinessAbortedError";
  }
}

export function isBackendReadinessAborted(error: unknown): error is BackendReadinessAbortedError {
  return error instanceof BackendReadinessAbortedError;
}
