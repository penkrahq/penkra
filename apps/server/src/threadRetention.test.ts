// FILE: threadRetention.test.ts
// Purpose: Verifies inactive-thread selection without running the server loop.
// Layer: Server maintenance tests
// Exports: Vitest coverage for threadRetention helpers.

import {
  CommandId,
  FolderId,
  SpaceId,
  ThreadId,
  TurnId,
  singletonThreadDeckId,
  type OrchestrationReadModel,
} from "@penkra/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  getInactiveThreadIdsForRetention,
  hasActiveDaysAfter,
  THREAD_RETENTION_ARCHIVED_ACTIVE_DAYS,
} from "./threadRetention";
import { decideOrchestrationCommand } from "./orchestration/decider";
import { projectEvent } from "./orchestration/projector";

function makeReadModelThread(
  overrides: Partial<OrchestrationReadModel["threads"][number]> = {},
): OrchestrationReadModel["threads"][number] {
  const id = overrides.id ?? ThreadId.makeUnsafe("thread-active");
  return {
    id,
    deckId: singletonThreadDeckId(id),
    deckSortOrder: 0,
    folderId: FolderId.makeUnsafe("project-1"),
    title: "Thread",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    latestUserMessageAt: null,
    deletedAt: null,
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestTurn: null,
    session: null,
    messages: [],
    activities: [],
    ...overrides,
  } as OrchestrationReadModel["threads"][number];
}

function makeReadModel(threads: OrchestrationReadModel["threads"]): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    spaces: [],
    folders: [],
    decks: threads.map((thread) => ({
      id: thread.deckId,
      spaceId: SpaceId.makeUnsafe("space-1"),
      threadIds: [thread.id],
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    })),
    threads,
    updatedAt: "2026-04-20T00:00:00.000Z",
  };
}

describe("thread retention", () => {
  const activeDays = Array.from(
    { length: 7 },
    (_, index) => `2026-04-${String(index + 2).padStart(2, "0")}`,
  );

  it("archives after seven active days, not seven calendar days", () => {
    const staleThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-stale"),
      latestUserMessageAt: "2026-04-01T00:00:00.000Z",
    });
    const recentThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-recent"),
      latestUserMessageAt: "2026-04-06T00:00:00.000Z",
    });

    expect(
      getInactiveThreadIdsForRetention(makeReadModel([staleThread, recentThread]), activeDays),
    ).toEqual([staleThread.id]);
    expect(
      getInactiveThreadIdsForRetention(makeReadModel([staleThread]), activeDays.slice(0, 6)),
    ).toEqual([]);
  });

  it("does not archive after two months away and one active day on return", () => {
    const thread = makeReadModelThread();
    expect(getInactiveThreadIdsForRetention(makeReadModel([thread]), ["2026-06-01"])).toEqual([]);
  });

  it("does not select busy or pending threads even when they are old", () => {
    const oldActivityAt = "2026-04-01T00:00:00.000Z";

    expect(
      getInactiveThreadIdsForRetention(
        makeReadModel([
          makeReadModelThread({
            id: ThreadId.makeUnsafe("thread-running"),
            latestUserMessageAt: oldActivityAt,
            session: {
              threadId: ThreadId.makeUnsafe("thread-running"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: oldActivityAt,
            },
          }),
          makeReadModelThread({
            id: ThreadId.makeUnsafe("thread-pending"),
            latestUserMessageAt: oldActivityAt,
            hasPendingUserInput: true,
          }),
        ]),
        activeDays,
      ),
    ).toEqual([]);
  });

  it("can archive an idle errored thread with a stale active turn id", () => {
    const thread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-error"),
      session: {
        threadId: ThreadId.makeUnsafe("thread-error"),
        status: "error",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: TurnId.makeUnsafe("stale-turn"),
        lastError: "failed",
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
    });
    expect(getInactiveThreadIdsForRetention(makeReadModel([thread]), activeDays)).toEqual([
      thread.id,
    ]);
  });

  it("does not select pinned threads even when they are old", () => {
    const oldActivityAt = "2026-04-01T00:00:00.000Z";
    const pinnedThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-pinned"),
      isPinned: true,
      latestUserMessageAt: oldActivityAt,
    });
    const unpinnedThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-unpinned"),
      latestUserMessageAt: oldActivityAt,
    });

    expect(
      getInactiveThreadIdsForRetention(makeReadModel([pinnedThread, unpinnedThread]), activeDays),
    ).toEqual([unpinnedThread.id]);
  });

  it("does not archive a thread that is already archived", () => {
    const archivedThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-archived"),
      archivedAt: "2026-04-01T00:00:00.000Z",
    });
    expect(getInactiveThreadIdsForRetention(makeReadModel([archivedThread]), activeDays)).toEqual(
      [],
    );
  });

  it("respects a recent unarchive even when the last user message is old", () => {
    const restoredThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-restored"),
      latestUserMessageAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-19T00:00:00.000Z",
    });
    expect(getInactiveThreadIdsForRetention(makeReadModel([restoredThread]), activeDays)).toEqual(
      [],
    );
  });

  it("respects a recent visit even when the last message and update are old", () => {
    const visitedThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-visited"),
      latestUserMessageAt: "2026-04-01T00:00:00.000Z",
      lastVisitedAt: "2026-04-19T00:00:00.000Z",
    });
    expect(getInactiveThreadIdsForRetention(makeReadModel([visitedThread]), activeDays)).toEqual(
      [],
    );
  });

  it("requires thirty active days after archiving for permanent deletion", () => {
    const afterArchive = Array.from({ length: THREAD_RETENTION_ARCHIVED_ACTIVE_DAYS }, (_, index) =>
      new Date(Date.UTC(2026, 3, index + 2)).toISOString().slice(0, 10),
    );
    expect(hasActiveDaysAfter(afterArchive.slice(0, 29), "2026-04-01T00:00:00.000Z", 30)).toBe(
      false,
    );
    expect(hasActiveDaysAfter(afterArchive, "2026-04-01T00:00:00.000Z", 30)).toBe(true);
    expect(hasActiveDaysAfter(["2026-06-01"], "2026-04-01T00:00:00.000Z", 30)).toBe(false);
  });

  it("rejects a stale archive after the thread is visited", async () => {
    const thread = makeReadModelThread({
      updatedAt: "2026-04-01T00:00:00.000Z",
      lastVisitedAt: "2026-04-19T00:00:00.000Z",
    });
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: makeReadModel([thread]),
          command: {
            type: "thread.archive",
            commandId: CommandId.makeUnsafe("retention-stale-archive"),
            threadId: thread.id,
            expectedUpdatedAt: thread.updatedAt,
            expectedLastVisitedAt: null,
          },
        }),
      ),
    ).rejects.toThrow("changed before retention archive");
  });

  it("rejects expired deletion after the archive is restored", async () => {
    const thread = makeReadModelThread({ archivedAt: null });
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: makeReadModel([thread]),
          command: {
            type: "thread.delete",
            commandId: CommandId.makeUnsafe("retention-stale-delete"),
            threadId: thread.id,
            expectedArchivedAt: "2026-04-01T00:00:00.000Z",
          },
        }),
      ),
    ).rejects.toThrow("archive changed before retention deletion");
  });

  it("records an open as activity without marking the thread read", async () => {
    const thread = makeReadModelThread({
      updatedAt: "2026-04-01T00:00:00.000Z",
      lastVisitedAt: "2026-04-01T00:00:00.000Z",
    });
    const openedAt = new Date().toISOString();
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: makeReadModel([thread]),
        command: {
          type: "thread.update",
          commandId: CommandId.makeUnsafe("retention-open"),
          threadId: thread.id,
          lastOpenedAt: openedAt,
        },
      }),
    );
    const event = Array.isArray(decided) ? decided[0] : decided;
    expect(event?.type).toBe("thread.updated");
    if (event?.type !== "thread.updated") return;
    expect(event.payload.lastOpenedAt).toBe(openedAt);
    expect(event.payload.lastVisitedAt).toBeUndefined();
    expect(event.payload.updatedAt).not.toBe(thread.updatedAt);
  });

  it("moves a legacy retention tombstone into Archive and restores deck membership", async () => {
    const deletedAt = "2026-04-01T00:00:00.000Z";
    const thread = makeReadModelThread({ deletedAt });
    const base = makeReadModel([thread]);
    const readModel: OrchestrationReadModel = {
      ...base,
      decks: [],
      folders: [
        {
          id: thread.folderId,
          spaceId: SpaceId.makeUnsafe("space-1"),
          title: "Folder",
          workspaceRoot: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: deletedAt,
          updatedAt: deletedAt,
          deletedAt: null,
        },
      ],
    };
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.retention-recover",
          commandId: CommandId.makeUnsafe("thread-retention-recover:test"),
          threadId: thread.id,
          expectedDeletedAt: deletedAt,
        },
      }),
    );
    const event = Array.isArray(decided) ? decided[0] : decided;
    expect(event?.type).toBe("thread.archived");
    if (!event) return;
    const projected = await Effect.runPromise(projectEvent(readModel, { ...event, sequence: 1 }));
    expect(projected.threads[0]?.deletedAt).toBeNull();
    expect(projected.threads[0]?.archivedAt).not.toBeNull();
    expect(projected.decks[0]?.threadIds).toEqual([thread.id]);
  });
});
