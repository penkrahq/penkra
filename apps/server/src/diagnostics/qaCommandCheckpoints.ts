import type { OrchestrationCommand } from "@penkra/contracts";

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
