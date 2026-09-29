import type { OrchestrationCommand } from "@penkra/contracts";
import type { QaActionFlow } from "@penkra/shared/diagnostics/qaEvidence";

export interface QaCommandCheckpoint {
  readonly flow: string;
  readonly step: string;
}

/** Checkpoints tied to actual command admission, before and after persistence. */
export function qaCommandCheckpoint(
  command: OrchestrationCommand,
  phase: "dispatch" | "accepted",
): QaCommandCheckpoint | null {
  switch (command.type) {
    case "thread.turn.start":
      return { flow: "send", step: phase === "dispatch" ? "send.dispatched" : "send.accepted" };
    case "thread.create":
      return {
        flow: "thread_create",
        step: phase === "dispatch" ? "thread.create_requested" : "thread.created",
      };
    case "thread.archive":
      return {
        flow: "archive",
        step: phase === "dispatch" ? "archive.requested" : "thread.archived",
      };
    case "thread.turn.interrupt":
      return phase === "dispatch" ? { flow: "stop", step: "stop.requested" } : null;
    case "thread.turn.recover":
      return phase === "dispatch" && command.reason === "play"
        ? { flow: "play", step: "play.requested" }
        : null;
    default:
      return null;
  }
}

/** A persisted command receipt is an independent result for these three flows. */
export function qaAcceptedCommandAction(command: OrchestrationCommand): QaActionFlow | null {
  if (command.type === "thread.turn.start") return "send";
  if (command.type === "thread.create") return "thread-create";
  if (command.type === "thread.archive") return "archive";
  return null;
}
