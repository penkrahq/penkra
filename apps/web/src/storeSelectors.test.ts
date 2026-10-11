import { makeThreadSummary } from "./storeTestFixtures";
import { syncServerThreadShell } from "./storeProjection";
import { describe, expect, it } from "vitest";

import type { MessageId, FolderId, ThreadId } from "@penkra/contracts";

import type { AppState } from "./store";
import {
  createAllThreadsSelector,
  createAllThreadsMessagelessSelector,
  createComposerThreadMentionSourcesSelector,
  createThreadExistsSelector,
  isPersistedThreadOpenable,
  createThreadFolderIdSelector,
  createThreadShellsSelector,
} from "./storeSelectors";
import { applyOrchestrationEvents } from "./storeEventReducer";
import {
  makeDomainEvent,
  makeState as makeFullState,
  makeThread,
  makeReadModelThread,
} from "./storeTestFixtures";
import type { SidebarThreadSummary, ThreadShell } from "./types";

const threadIdA = "thread-a" as ThreadId;
const threadIdB = "thread-b" as ThreadId;
const messageId = "message-1" as MessageId;
const folderId = "project-1" as FolderId;

const shellA = { id: threadIdA, folderId, title: "A" } as ThreadShell;
const shellB = { id: threadIdB, folderId, title: "B" } as ThreadShell;
const summaryA = {
  id: threadIdA,
  folderId,
  title: "A",
  modelSelection: { provider: "codex", model: "gpt-5-codex" },
  session: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  latestTurn: null,
  hasPendingUserInput: false,
} as SidebarThreadSummary;

interface TestStateSlices {
  threadIds?: readonly ThreadId[];
  threadShellById?: Readonly<Record<string, ThreadShell>>;
  sidebarThreadSummaryById?: Readonly<Record<string, SidebarThreadSummary>>;
  messageIdsByThreadId?: Readonly<Record<string, readonly MessageId[]>>;
}

function makeState(slices: TestStateSlices): AppState {
  return {
    threadIds: slices.threadIds ?? [],
    threadShellById: slices.threadShellById ?? {},
    sidebarThreadSummaryById: slices.sidebarThreadSummaryById ?? {},
    messageIdsByThreadId: slices.messageIdsByThreadId ?? {},
  } as unknown as AppState;
}

describe("createThreadShellsSelector", () => {
  it("returns shells in threadIds order", () => {
    const selectShells = createThreadShellsSelector();
    const state = makeState({
      threadIds: [threadIdB, threadIdA],
      threadShellById: { [threadIdA]: shellA, [threadIdB]: shellB },
    });

    expect(selectShells(state).map((shell) => shell.id)).toEqual([threadIdB, threadIdA]);
  });

  it("stays reference-stable when unrelated state changes (e.g. streaming messages)", () => {
    const selectShells = createThreadShellsSelector();
    const threadIds = [threadIdA];
    const threadShellById = { [threadIdA]: shellA };

    const before = selectShells(makeState({ threadIds, threadShellById }));
    const after = selectShells(
      makeState({
        threadIds,
        threadShellById,
        messageIdsByThreadId: { [threadIdA]: [messageId] },
      }),
    );

    expect(after).toBe(before);
  });

  it("returns a new array when shells change", () => {
    const selectShells = createThreadShellsSelector();
    const threadIds = [threadIdA];

    const before = selectShells(makeState({ threadIds, threadShellById: { [threadIdA]: shellA } }));
    const after = selectShells(
      makeState({
        threadIds,
        threadShellById: { [threadIdA]: { ...shellA, title: "renamed" } },
      }),
    );

    expect(after).not.toBe(before);
    expect(after[0]?.title).toBe("renamed");
  });
});

describe("createComposerThreadMentionSourcesSelector", () => {
  it("reads visits and message recency only from canonical rows and keeps the same source array", () => {
    const selectSources = createComposerThreadMentionSourcesSelector();
    const row = makeThreadSummary({
      id: threadIdA,
      lastVisitedAt: "2026-02-14T00:00:00.000Z",
      lastUserMessageAt: "2026-02-15T00:00:00.000Z",
    });
    const rows = [row];
    const before = selectSources(rows);
    expect(before[0]).toMatchObject({
      id: threadIdA,
      lastVisitedAt: row.lastVisitedAt,
      latestUserMessageAt: row.lastUserMessageAt,
    });
    expect(selectSources(rows)).toBe(before);
    const renamed = selectSources([{ ...row, title: "Renamed" }]);
    expect(renamed[0]?.title).toBe("Renamed");
  });
});

describe("createAllThreadsSelector", () => {
  it("preserves the untouched thread identity when another thread shell changes", () => {
    const selectThreads = createAllThreadsSelector();
    const threadIds = [threadIdA, threadIdB];
    const before = selectThreads(
      makeState({
        threadIds,
        threadShellById: { [threadIdA]: shellA, [threadIdB]: shellB },
      }),
    );
    const after = selectThreads(
      makeState({
        threadIds,
        threadShellById: {
          [threadIdA]: { ...shellA, title: "renamed" },
          [threadIdB]: shellB,
        },
      }),
    );

    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });
});

describe("createAllThreadsMessagelessSelector", () => {
  it("is vacuously true with no threads", () => {
    const selectMessageless = createAllThreadsMessagelessSelector();
    expect(selectMessageless(makeState({}))).toBe(true);
  });

  it("is true when every thread has no message ids", () => {
    const selectMessageless = createAllThreadsMessagelessSelector();
    const state = makeState({
      threadIds: [threadIdA, threadIdB],
      messageIdsByThreadId: { [threadIdA]: [] },
    });
    expect(selectMessageless(state)).toBe(true);
  });

  it("is false once any thread has a message", () => {
    const selectMessageless = createAllThreadsMessagelessSelector();
    const state = makeState({
      threadIds: [threadIdA, threadIdB],
      messageIdsByThreadId: { [threadIdB]: [messageId] },
    });
    expect(selectMessageless(state)).toBe(false);
  });
});

describe("thread shell route selectors", () => {
  it("reacts to canonical archive and restore rows in each window's store", () => {
    const row = makeReadModelThread({ id: threadIdA });
    const initial = makeFullState(makeThread({ id: threadIdA }));
    const at = "2026-09-26T00:00:00.000Z";
    const archived = { ...row, archivedAt: at, updatedAt: at };
    const firstWindow = syncServerThreadShell(initial, row.id, archived);
    const secondWindow = syncServerThreadShell(initial, row.id, archived);
    expect(isPersistedThreadOpenable(firstWindow, row.id)).toBe(false);
    expect(isPersistedThreadOpenable(secondWindow, row.id)).toBe(false);
    const restored = syncServerThreadShell(firstWindow, row.id, { ...row, updatedAt: at });
    expect(isPersistedThreadOpenable(restored, row.id)).toBe(true);
    expect(isPersistedThreadOpenable({ threadShellById: {} }, row.id)).toBe(false);
  });
  it("resolve existence and project id without reading detail slices", () => {
    const state = makeState({
      threadIds: [threadIdA],
      threadShellById: { [threadIdA]: shellA },
    });
    Object.defineProperty(state, "messageIdsByThreadId", {
      get() {
        throw new Error("detail messages should not be read");
      },
    });

    expect(createThreadExistsSelector(threadIdA)(state)).toBe(true);
    expect(createThreadFolderIdSelector(threadIdA)(state)).toBe(folderId);
  });
});
