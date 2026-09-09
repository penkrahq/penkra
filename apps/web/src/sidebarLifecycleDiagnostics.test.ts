import { beforeEach, describe, expect, it } from "vitest";

import {
  getSidebarLifecycleDiagnosticSamples,
  recordSidebarLifecycleDiagnostic,
  resetSidebarLifecycleDiagnostics,
} from "./sidebarLifecycleDiagnostics";

const baseState = {
  threadId: "thread-promoted",
  summaryPresent: true,
  activeSidebarThreadId: "thread-promoted",
  draftPromotedTo: "thread-promoted",
  hasLocalSendOwner: true,
  projectedWorkStatus: null,
  sessionStatus: null,
  sessionOrchestrationStatus: null,
  sessionUpdatedAt: null,
  latestTurnId: null,
  pendingTurnStartMessageId: null,
  latestTurnState: null,
  latestTurnRequestedAt: null,
  latestTurnStartedAt: null,
  latestTurnCompletedAt: null,
  derivedStatusLabel: "Working",
  derivedWorkStatus: "running" as const,
};

describe("sidebar lifecycle diagnostics", () => {
  beforeEach(resetSidebarLifecycleDiagnostics);

  it("records timestamped ownership and derived work state once per state", () => {
    recordSidebarLifecycleDiagnostic(baseState);
    recordSidebarLifecycleDiagnostic(baseState);
    expect(getSidebarLifecycleDiagnosticSamples()).toEqual([
      expect.objectContaining({ event: "derived-state", sequence: 1, ...baseState }),
    ]);
  });

  it("records a shell disappearing while local promotion remains owned", () => {
    recordSidebarLifecycleDiagnostic(baseState);
    recordSidebarLifecycleDiagnostic({
      ...baseState,
      summaryPresent: false,
      derivedStatusLabel: null,
      derivedWorkStatus: "idle",
    });
    expect(getSidebarLifecycleDiagnosticSamples("thread-promoted")).toHaveLength(2);
  });
});
