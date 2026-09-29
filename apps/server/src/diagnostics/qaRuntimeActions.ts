import { qaEvidenceConfigFromEnv, recordQaAction } from "@penkra/shared/diagnostics/qaEvidence";

type RuntimeFlow = "stop" | "play" | "queue";
const pending = new Map<
  string,
  { flow: RuntimeFlow; threadId: string; turnId: string; traceId: string; at: number }
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

/** Called after the command receipt has been durably accepted. */
export function armQaRuntimeAction(
  flow: RuntimeFlow,
  threadId: string,
  turnId: string,
  traceId: string,
): void {
  if (!enabled()) return;
  const now = Date.now();
  for (const [key, value] of pending) if (now - value.at > TTL_MS) pending.delete(key);
  if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!);
  pending.set(`${flow}:${threadId}:${turnId}`, { flow, threadId, turnId, traceId, at: now });
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
    pending.delete(key);
    try {
      recordQaAction(flow, candidate.traceId);
    } catch {
      process.stderr.write("[diagnostics] QA runtime action proof failed\n");
    }
  }
}
