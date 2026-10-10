import { beforeEach, expect, it, vi } from "vitest";
import { ThreadId, type CleanCoreThreadSummary } from "@penkra/contracts";
import {
  getThreadListById,
  loadThread,
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
    folderId: null,
    title: "Outside the first page",
    provider: "codex",
    connectionId: null,
    model: "gpt-5.5",
    modelOptions: null,
    runtimeMode: "full-access",
    workingDirectory: null,
    state: "running",
    activeTurnId: null,
    lastError: null,
    queue,
    createdBy: "user",
    createdByThreadId: null,
    parentThreadId: null,
    deckId: null,
    deckSortOrder: 0,
    sidebarSortOrder: null,
    isPinned: 0,
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
