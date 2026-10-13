// FILE: userTurnMarker.ts
// Purpose: Single predicate for the marker chip above a sent user message
// ("Sent by agent" / "Steering conversation"). Shared by the transcript
// renderer (MessagesTimeline) and the row-height estimator (timelineHeight) so
// what gets rendered and what gets measured can never drift apart.
// Layer: web chat feature (pure logic, no I/O).

// Agent-dispatched turns take
// precedence over the steer marker so the origin stays visible even for
// steered dispatches.
import type { MessageOrigin } from "@penkra/contracts";

export type UserTurnMarkerKind = "agent" | "steer";

export function resolveUserTurnMarker(message: {
  readonly origin?: MessageOrigin | undefined;
  readonly steered?: true | undefined;
}): UserTurnMarkerKind | null {
  if (message.origin?._tag === "agent") {
    return "agent";
  }
  if (message.steered) {
    return "steer";
  }
  return null;
}

export interface UserTurnMediaCounts {
  readonly imageCount: number;
  readonly fileCount: number;
  readonly assistantSelectionCount: number;
  readonly fileCommentCount: number;
  readonly pastedTextCount: number;
}

// The marker chip sits directly above any leading media row, and its bottom
// margin is larger when media follows. Renderer and height estimator must agree
// on which attachment kinds count as media, or estimated row heights drift from
// what actually renders.
export function hasLeadingUserMedia(counts: UserTurnMediaCounts): boolean {
  return (
    counts.imageCount > 0 ||
    counts.fileCount > 0 ||
    counts.assistantSelectionCount > 0 ||
    counts.fileCommentCount > 0 ||
    counts.pastedTextCount > 0
  );
}
