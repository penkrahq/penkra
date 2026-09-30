import { startDiagnosticTrace } from "@penkra/shared/traceContext";

import { recordDiagnosticIncident } from "./recorder";

export function recordWsStreamDrop(input: {
  threadId: string;
  capacity: number;
  droppedAtLeast: number;
}): void {
  recordDiagnosticIncident({
    ...startDiagnosticTrace(),
    threadId: input.threadId,
    kind: "limit.exceeded",
    code: "DELIVERY_BLOCKED",
    where: "server.ws_rpc",
    severity: "error",
    expected: { count: input.capacity },
    actual: { count: input.droppedAtLeast },
    limit: {
      name: "liveUiStreamBufferCapacity",
      value: input.capacity,
      observed: input.capacity + input.droppedAtLeast,
    },
    context: { reason: "capacity" },
  });
}

export function recordWsResnapshot(input: {
  threadId: string;
  snapshotSequence: number;
  highWaterSequence: number;
  replayCount: number;
}): void {
  recordDiagnosticIncident({
    ...startDiagnosticTrace(),
    threadId: input.threadId,
    kind: "recovery.performed",
    code: "RECOVERY_PERFORMED",
    where: "server.ws_rpc",
    severity: "warn",
    expected: { sequence: input.snapshotSequence },
    actual: { sequence: input.highWaterSequence, count: input.replayCount },
  });
}
