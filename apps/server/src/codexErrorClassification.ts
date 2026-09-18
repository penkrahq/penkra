// FILE: codexErrorClassification.ts
// Purpose: Classifies Codex error notifications by protocol shape rather than message text.

type CodexErrorNotificationShape = {
  readonly method?: unknown;
  readonly payload?: unknown;
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

export function isCodexToolAttemptFailure(
  notification: CodexErrorNotificationShape,
): boolean {
  if (notification.method !== "error") return false;
  const payload = asObject(notification.payload);
  if (payload?.willRetry === true) return false;
  const error = asObject(payload?.error);
  if (!error) return false;

  // Codex provider/transport failures carry a typed codexErrorInfo variant.
  // Untyped terminal notifications on the error method are failures of the
  // current tool attempt and are diagnostic-only.
  return error.codexErrorInfo === undefined || error.codexErrorInfo === null;
}
