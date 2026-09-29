import { recordServerQaActionAsync, serverQaProofConfig } from "./qaProofBuild";
import { recordDiagnosticCheckpoint } from "./recorder";

type Pending = {
  traceId: string;
  spanId: string;
  threadId: string;
  requested: boolean;
  at: number;
};
const pending = new Map<string, Pending>();
const TTL_MS = 120_000;
const MAX_PENDING = 128;

export function armQaProviderSwitch(
  commandId: string,
  threadId: string,
  traceId: string,
  spanId: string,
): void {
  try {
    if (!serverQaProofConfig()) return;
  } catch {
    return;
  }
  const now = Date.now();
  for (const [key, value] of pending) if (now - value.at > TTL_MS) pending.delete(key);
  if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!);
  pending.set(commandId, { traceId, spanId, threadId, requested: false, at: now });
}

export function clearQaProviderSwitch(commandId: string): void {
  pending.delete(commandId);
}

/** Called only after the switch journal is durable. */
export function requestedQaProviderSwitch(commandId: string, threadId: string): void {
  const state = pending.get(commandId);
  if (!state || state.threadId !== threadId || state.requested) return;
  state.requested = true;
  recordDiagnosticCheckpoint({
    traceId: state.traceId,
    spanId: state.spanId,
    threadId,
    flow: "app",
    step: "provider.switch_requested",
    outcome: "ok",
    fields: { commandId },
  });
}

/** Called only after the matching operation is durably committed. */
export function committedQaProviderSwitch(commandId: string, threadId: string): void {
  const state = pending.get(commandId);
  if (!state?.requested || state.threadId !== threadId) return;
  pending.delete(commandId);
  recordDiagnosticCheckpoint({
    traceId: state.traceId,
    spanId: state.spanId,
    threadId,
    flow: "app",
    step: "provider.switched",
    outcome: "ok",
    fields: { commandId },
  });
  void recordServerQaActionAsync("provider-switch", state.traceId).catch(() =>
    process.stderr.write("[diagnostics] QA provider-switch action proof failed\n"),
  );
}
