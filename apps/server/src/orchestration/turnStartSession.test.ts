import { ThreadId, type OrchestrationSession } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import { deriveTurnStartSession } from "./turnStartSession.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-turn-start-session");
const REQUESTED_AT = "2026-07-21T00:00:00.000Z";

function makeSession(status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId: THREAD_ID,
    status,
    providerName: "codex",
    activeTurnId: null,
    lastError: status === "error" ? "runtime exploded" : null,
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

function derive(currentSession: OrchestrationSession | null) {
  return deriveTurnStartSession({
    threadId: THREAD_ID,
    currentSession,
    providerName: "opencode",
    requestedAt: REQUESTED_AT,
  });
}

describe("deriveTurnStartSession", () => {
  it("creates a starting session when no session exists", () => {
    expect(derive(null)).toEqual({
      threadId: THREAD_ID,
      status: "starting",
      providerName: "opencode",
      activeTurnId: null,
      lastError: null,
      updatedAt: REQUESTED_AT,
    });
  });

  it("preserves the established provider when restarting an idle session", () => {
    expect(derive(makeSession("ready"))).toMatchObject({
      status: "starting",
      providerName: "codex",
      activeTurnId: null,
      lastError: null,
    });
  });

  it.each(["starting", "running"] as const)("does not replace a %s session", (status) => {
    expect(derive(makeSession(status))).toBeNull();
  });

  it("clears terminal error details when a new turn starts", () => {
    expect(derive(makeSession("error"))).toMatchObject({
      status: "starting",
      activeTurnId: null,
      lastError: null,
    });
  });
});
