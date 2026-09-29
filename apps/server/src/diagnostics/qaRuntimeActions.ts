import { qaEvidenceConfigFromEnv, recordQaAction } from "@penkra/shared/diagnostics/qaEvidence";

type RuntimeFlow = "stop" | "play" | "queue";
const pending = new Map<
  string,
  {
    flow: RuntimeFlow;
    threadId: string;
    turnId: string;
    traceId: string;
    at: number;
    admitted: boolean;
    observed: boolean;
  }
>();
const MAX_PENDING = 128;
const TTL_MS = 120_000;

function enabled(): boolean {
  try {
    return qaEvidenceConfigFromEnv() !== null;
  } catch {
    return false;
  }
}

function sign(flow: RuntimeFlow, traceId: string): void {
  try {
    recordQaAction(flow, traceId);
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
  sign(flow, traceId);
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
  readonly eventType: "turn.started" | "turn.completed" | "turn.aborted";
  readonly state: "running" | "interrupted" | "ready" | "error";
}): void {
  if (!enabled() || !input.logicalTurnId) return;
  const flows: RuntimeFlow[] =
    input.eventType === "turn.started" && input.state === "running"
      ? ["play", "queue"]
      : input.state === "interrupted"
        ? ["stop"]
        : [];
  for (const flow of flows) {
    const key = `${flow}:${input.threadId}:${input.logicalTurnId}`;
    const candidate = pending.get(key);
    if (!candidate || Date.now() - candidate.at > TTL_MS) continue;
    if (!candidate.admitted) {
      candidate.observed = true;
      continue;
    }
    pending.delete(key);
    sign(flow, candidate.traceId);
  }
}
