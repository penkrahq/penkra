import { qaEvidenceConfigFromEnv, recordQaAction } from "@penkra/shared/diagnostics/qaEvidence";
import { recordDiagnosticCheckpoint } from "./recorder";

type RuntimeFlow = "stop" | "play" | "queue";

/** A canonical native terminal can settle a turn whose session update was fenced out. */
export function shouldObserveQaLifecycle(input: {
  readonly eventType: "turn.started" | "turn.completed" | "turn.aborted";
  readonly state: "running" | "interrupted" | "ready" | "error";
  readonly shouldApply: boolean;
  readonly disposition: "applied" | "skipped";
  readonly projectedTurnState: string | null;
}): boolean {
  return (
    (input.shouldApply && input.disposition === "applied") ||
    ((input.eventType === "turn.completed" || input.eventType === "turn.aborted") &&
      input.state === "interrupted" &&
      input.projectedTurnState !== null)
  );
}

type PendingAction = {
  flow: RuntimeFlow;
  threadId: string;
  turnId: string;
  traceId: string;
  spanId: string;
  at: number;
  admitted: boolean;
  observed: boolean;
};
const pending = new Map<string, PendingAction>();
const MAX_PENDING = 128;
const TTL_MS = 120_000;

function enabled(): boolean {
  try {
    return qaEvidenceConfigFromEnv() !== null;
  } catch {
    return false;
  }
}

function complete(candidate: PendingAction): void {
  const step =
    candidate.flow === "stop"
      ? "turn.terminal"
      : candidate.flow === "play"
        ? "turn.started"
        : "queue.started";
  recordDiagnosticCheckpoint({
    traceId: candidate.traceId,
    spanId: candidate.spanId,
    threadId: candidate.threadId,
    flow: candidate.flow,
    step,
    outcome: "ok",
  });
  try {
    recordQaAction(candidate.flow, candidate.traceId);
  } catch {
    process.stderr.write("[diagnostics] QA runtime action proof failed\n");
  }
}

/** Register before dispatch so a fast provider event cannot outrun admission. */
export function prepareQaRuntimeAction(
  flow: RuntimeFlow,
  threadId: string,
  turnId: string,
  traceId: string,
  spanId = traceId.slice(0, 16),
): void {
  if (!enabled()) return;
  const now = Date.now();
  for (const [key, value] of pending) if (now - value.at > TTL_MS) pending.delete(key);
  if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!);
  pending.set(`${flow}:${threadId}:${turnId}`, {
    flow,
    threadId,
    turnId,
    traceId,
    spanId,
    at: now,
    admitted: false,
    observed: false,
  });
}

/** Only a durable command receipt makes an observed lifecycle event provable. */
export function admitQaRuntimeAction(
  flow: RuntimeFlow,
  threadId: string,
  turnId: string,
  traceId: string,
): void {
  const key = `${flow}:${threadId}:${turnId}`;
  const candidate = pending.get(key);
  if (!candidate || candidate.traceId !== traceId) return;
  candidate.admitted = true;
  if (!candidate.observed) return;
  pending.delete(key);
  complete(candidate);
}

export function clearQaRuntimeAction(
  flow: RuntimeFlow,
  threadId: string,
  turnId: string,
  traceId: string,
): void {
  const key = `${flow}:${threadId}:${turnId}`;
  if (pending.get(key)?.traceId === traceId) pending.delete(key);
}

/** Convenience for callers that already hold a durable admission receipt. */
export function armQaRuntimeAction(
  flow: RuntimeFlow,
  threadId: string,
  turnId: string,
  traceId: string,
): void {
  prepareQaRuntimeAction(flow, threadId, turnId, traceId);
  admitQaRuntimeAction(flow, threadId, turnId, traceId);
}

/** Called after the provider lifecycle event is accepted into the app state. */
export function settleQaRuntimeAction(input: {
  readonly threadId: string;
  readonly logicalTurnId: string | null;
  readonly nativeTurnId?: string | null;
  readonly eventType: "turn.started" | "turn.completed" | "turn.aborted";
  readonly state: "running" | "interrupted" | "ready" | "error";
}): void {
  if (!enabled() || (!input.logicalTurnId && !input.nativeTurnId)) return;
  const flows: RuntimeFlow[] =
    input.eventType === "turn.started" && input.state === "running"
      ? ["play", "queue"]
      : input.state === "interrupted"
        ? ["stop"]
        : [];
  for (const flow of flows) {
    const key = [input.logicalTurnId, input.nativeTurnId]
      .filter((turnId): turnId is string => !!turnId)
      .map((turnId) => `${flow}:${input.threadId}:${turnId}`)
      .find((candidateKey) => pending.has(candidateKey));
    if (!key) continue;
    const candidate = pending.get(key);
    if (!candidate || Date.now() - candidate.at > TTL_MS) continue;
    if (!candidate.admitted) {
      candidate.observed = true;
      continue;
    }
    pending.delete(key);
    complete(candidate);
  }
}
