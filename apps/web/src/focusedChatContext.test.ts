import { FolderId, SpaceId, ThreadId, TurnId, singletonThreadDeckId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import { type DraftThreadState } from "./composerDraftStore";
import { resolveFocusedChatContext } from "./focusedChatContext";
import type { Project, Thread } from "./types";

const PROJECT_ID = FolderId.makeUnsafe("project-1");
const THREAD_A = ThreadId.makeUnsafe("thread-a");

function makeProject(): Project {
  return {
    id: PROJECT_ID,
    name: "Project",
    remoteName: "Project",
    folderName: "folder",
    localName: null,
    cwd: "/tmp/project",
    defaultModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    expanded: true,
    spaceId: SpaceId.makeUnsafe("space-test"),
    scripts: [],
  };
}

function makeThread(threadId: ThreadId, overrides: Partial<Thread> = {}): Thread {
  const thread = {
    id: threadId,
    deckId: singletonThreadDeckId(threadId),
    deckSortOrder: 0,
    codexThreadId: null,
    folderId: PROJECT_ID,
    title: `Thread ${threadId}`,
    modelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    runtimeMode: "full-access",
    session: null,
    messages: [],
    error: null,
    createdAt: "2026-04-07T10:00:00.000Z",
    updatedAt: "2026-04-07T10:00:00.000Z",
    latestTurn: {
      turnId: TurnId.makeUnsafe("turn-1"),
      state: "completed",
      requestedAt: "2026-04-07T10:00:00.000Z",
      startedAt: "2026-04-07T10:00:00.000Z",
      completedAt: "2026-04-07T10:01:00.000Z",
      assistantMessageId: null,
    },
    lastVisitedAt: "2026-04-07T10:01:00.000Z",
    activities: [],
    ...overrides,
  };
  return Object.assign({}, thread, {
    deckId: overrides.deckId ?? singletonThreadDeckId(threadId),
    deckSortOrder: overrides.deckSortOrder ?? 0,
  }) as Thread;
}

function makeDraftThread(overrides: Partial<DraftThreadState> = {}): DraftThreadState {
  return {
    folderId: PROJECT_ID,
    deckId: singletonThreadDeckId(THREAD_A),
    createdAt: "2026-04-07T10:00:00.000Z",
    runtimeMode: "full-access",
    entryPoint: "chat",
    ...overrides,
  };
}

describe("resolveFocusedChatContext", () => {
  it("uses the route thread and its project", () => {
    const context = resolveFocusedChatContext({
      routeThreadId: THREAD_A,
      threads: [makeThread(THREAD_A)],
      folders: [makeProject()],
      draftThreadsByThreadId: {},
    });

    expect(context.focusedThreadId).toBe(THREAD_A);
    expect(context.activeThread?.id).toBe(THREAD_A);
    expect(context.activeFolderId).toBe(PROJECT_ID);
  });

  it("uses a draft thread when the route has no server thread yet", () => {
    const context = resolveFocusedChatContext({
      routeThreadId: THREAD_A,
      threads: [],
      folders: [makeProject()],
      draftThreadsByThreadId: { [THREAD_A]: makeDraftThread() },
    });

    expect(context.activeDraftThread).toBeDefined();
    expect(context.activeFolderId).toBe(PROJECT_ID);
  });
});
