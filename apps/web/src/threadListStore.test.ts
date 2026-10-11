import { beforeEach, expect, it, vi } from "vitest";
import { FolderId, ThreadId, type CleanCoreThreadSummary } from "@penkra/contracts";
import {
  getThreadListById,
  loadThread,
  loadThreadPage,
  loadNextThreadPage,
  getThreadListPages,
  threadListScopeKey,
  resetThreadListForTests,
  subscribeThreadList,
} from "./threadListStore";

const api = vi.hoisted(() => ({
  getThread: vi.fn(),
  listThreads: vi.fn(),
  onSidebarChange: vi.fn(),
}));
vi.mock("./nativeApi", () => ({ ensureNativeApi: () => ({ cleanCore: api }) }));
function row(queue: string, updatedAt: string): CleanCoreThreadSummary {
  return {
    id: ThreadId.makeUnsafe("thread-51"),
    spaceId: "space" as CleanCoreThreadSummary["spaceId"],
    folderId: FolderId.makeUnsafe("folder"),
    title: "Outside the first page",
    provider: "codex",
    connectionId: null,
    model: "gpt-5.5",
    modelOptions: null,
    runtimeMode: "full-access",
    state: "running",
    activeTurnId: null,
    lastError: null,
    queue,
    createdBy: "user",
    createdByThreadId: null,
    sidebarSortOrder: null,
    lastActivityAt: null,
    lastMessagePreview: null,
    lastUserMessageAt: null,
    lastVisitedAt: null,
    openQuestionCount: 0,
    archivedAt: null,
    deletedAt: null,
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt,
  };
}
beforeEach(() => {
  resetThreadListForTests();
  vi.clearAllMocks();
  api.onSidebarChange.mockReturnValue(() => undefined);
});
it("reads an active thread's queue by ID without reading the first sidebar page", async () => {
  const thread = row('[{"messageId":"message-1"}]', "2026-10-10T00:00:01.000Z");
  api.getThread.mockResolvedValue(thread);
  await loadThread(thread.id);
  expect(api.getThread).toHaveBeenCalledExactlyOnceWith({ threadId: thread.id });
  expect(api.listThreads).not.toHaveBeenCalled();
  expect(getThreadListById().get(thread.id)).toEqual(thread);
});
it("refreshes the canonical queue after a broadcast and ignores an older in-flight reply", async () => {
  const old = row("[]", "2026-10-10T00:00:01.000Z");
  const current = row('[{"messageId":"message-1"}]', "2026-10-10T00:00:02.000Z");
  let resolveOlder!: (row: CleanCoreThreadSummary) => void;
  api.getThread.mockReturnValueOnce(
    new Promise<CleanCoreThreadSummary>((resolve) => {
      resolveOlder = resolve;
    }),
  );
  const pending = loadThread(old.id);
  api.getThread.mockResolvedValueOnce(current);
  let applied!: () => void;
  const updated = new Promise<void>((resolve) => {
    applied = resolve;
  });
  const unsubscribe = subscribeThreadList(applied);
  const broadcast = api.onSidebarChange.mock.calls[0]![0] as (change: {
    kind: "thread";
    threadId: CleanCoreThreadSummary["id"];
  }) => void;
  broadcast({ kind: "thread", threadId: old.id });
  await updated;
  resolveOlder(old);
  await pending;
  expect(getThreadListById().get(old.id)).toEqual(current);
  unsubscribe();
});

it("reads one scope page at a time, deduplicates a pending next page, and stops at its final cursor", async () => {
  const thread = row("[]", "2026-10-10T00:00:01.000Z");
  const scope = { spaceId: thread.spaceId, folderId: thread.folderId };
  const cursor = { sidebarSortOrder: 0, createdAt: thread.createdAt, id: thread.id };
  api.listThreads.mockResolvedValueOnce({ threads: [thread], nextCursor: cursor });
  await loadThreadPage(scope);
  expect(api.listThreads).toHaveBeenCalledExactlyOnceWith({ ...scope, after: null });
  let release!: (page: { threads: CleanCoreThreadSummary[]; nextCursor: null }) => void;
  api.listThreads.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const next = loadNextThreadPage(scope);
  expect(loadNextThreadPage(scope)).toBe(next);
  expect(api.listThreads).toHaveBeenLastCalledWith({ ...scope, after: cursor });
  const other = { ...thread, id: ThreadId.makeUnsafe("thread-52") };
  release({ threads: [other], nextCursor: null });
  await next;
  await loadNextThreadPage(scope);
  expect(api.listThreads).toHaveBeenCalledTimes(2);
  expect(getThreadListPages().get(threadListScopeKey(scope.spaceId, scope.folderId))).toEqual({
    nextCursor: null,
    loading: false,
  });
  expect([...getThreadListById().keys()]).toEqual([thread.id, other.id]);
});
it("keeps a newer move and visit when an older page reply arrives after a broadcast", async () => {
  const old = row("[]", "2026-10-10T00:00:01.000Z");
  const current = {
    ...old,
    sidebarSortOrder: 2,
    lastVisitedAt: "2026-10-10T00:00:02.000Z",
    updatedAt: "2026-10-10T00:00:02.000Z",
  };
  let release!: (page: { threads: CleanCoreThreadSummary[]; nextCursor: null }) => void;
  api.listThreads.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const pending = loadThreadPage({ spaceId: old.spaceId, folderId: old.folderId });
  api.getThread.mockResolvedValueOnce(current);
  let applied!: () => void;
  const changed = new Promise<void>((resolve) => {
    applied = resolve;
  });
  const unsubscribe = subscribeThreadList(applied);
  const broadcast = api.onSidebarChange.mock.calls[0]![0] as (change: {
    kind: "thread";
    threadId: CleanCoreThreadSummary["id"];
  }) => void;
  broadcast({ kind: "thread", threadId: old.id });
  await changed;
  release({ threads: [old], nextCursor: null });
  await pending;
  expect(getThreadListById().get(old.id)).toEqual(current);
  unsubscribe();
});
