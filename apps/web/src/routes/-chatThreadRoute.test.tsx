// FILE: -chatThreadRoute.test.tsx
// Purpose: Verify bounded route admission through the canonical thread store.
// Layer: Route tests

import { FolderId, SpaceId, ThreadId, type CleanCoreThreadSummary } from "@penkra/contracts";
import type { ReactElement } from "react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { applyThreadRow, resetThreadListForTests } from "../threadListStore";
import { Route } from "./_chat.$threadId";

const fixture = vi.hoisted(() => ({
  threadId: "thread-51",
  hydrated: true,
  drafts: {} as Record<string, { folderId: FolderId }>,
  requests: undefined as undefined | { current: Map<ThreadId, Promise<void>> },
  effects: [] as Array<() => void | (() => void)>,
  cleanups: [] as Array<() => void>,
  getThread: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  homeView: vi.fn(),
  loadComponent: undefined as undefined | (() => Promise<() => ReactElement | null>),
  component: undefined as undefined | (() => ReactElement | null),
}));
vi.mock("react", async () => ({
  ...(await vi.importActual("react")),
  useRef: (initial: Map<ThreadId, Promise<void>>) => {
    fixture.requests ??= { current: initial };
    return fixture.requests;
  },
  useEffect: (effect: () => void | (() => void)) => fixture.effects.push(effect),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
vi.mock("@tanstack/react-router", () => ({
  lazyRouteComponent: (
    load: () => Promise<Record<string, () => ReactElement | null>>,
    name: string,
  ) => {
    fixture.loadComponent = async () => (await load())[name]!;
    return () => fixture.component!();
  },
  createFileRoute: () => (options: unknown) => ({
    options,
    useParams: ({ select }: { select: (params: { threadId: string }) => unknown }) =>
      select({ threadId: fixture.threadId }),
  }),
  useNavigate: () => fixture.navigate,
}));
vi.mock("../store", () => ({
  useStore: (select: (state: { threadsHydrated: boolean }) => unknown) =>
    select({ threadsHydrated: fixture.hydrated }),
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (
    select: (state: { draftThreadsByThreadId: typeof fixture.drafts }) => unknown,
  ) => select({ draftThreadsByThreadId: fixture.drafts }),
}));
vi.mock("../nativeApi", () => ({
  ensureNativeApi: () => ({ cleanCore: { getThread: fixture.getThread } }),
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: fixture.toast } }));
vi.mock("../components/chat/SingleChatSurface", () => ({ SingleChatSurface: "chat-surface" }));

function row(): CleanCoreThreadSummary {
  return {
    latestTurn: null,
    id: ThreadId.makeUnsafe(fixture.threadId),
    spaceId: SpaceId.makeUnsafe("space"),
    folderId: FolderId.makeUnsafe("canonical-folder"),
    title: "Outside the loaded page",
    provider: "codex",
    connectionId: null,
    model: "gpt-5.5",
    modelOptions: null,
    runtimeMode: "full-access",
    state: "idle",
    activeTurnId: null,
    lastError: null,
    queue: "[]",
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
    updatedAt: "2026-10-10T00:00:00.000Z",
  };
}
function render() {
  for (const cleanup of fixture.cleanups) cleanup();
  fixture.cleanups = [];
  fixture.effects = [];
  const component = Route.options.component as () => ReactElement<{
    threadId: ThreadId;
    folderId: FolderId;
  }> | null;
  const result = component();
  for (const effect of fixture.effects) {
    const cleanup = effect();
    if (cleanup) fixture.cleanups.push(cleanup);
  }
  return result;
}
async function finishRead() {
  await fixture
    .requests!.current.get(ThreadId.makeUnsafe(fixture.threadId))
    ?.catch(() => undefined);
  await Promise.resolve();
}
beforeAll(async () => {
  fixture.component = await fixture.loadComponent!();
});
beforeEach(() => {
  resetThreadListForTests();
  vi.clearAllMocks();
  fixture.threadId = "thread-51";
  fixture.hydrated = true;
  fixture.drafts = {};
  fixture.requests = undefined;
  fixture.effects = [];
  fixture.cleanups = [];
  vi.stubGlobal("window", {
    desktopBridge: { threadHome: { view: fixture.homeView, leave: vi.fn() } },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});
afterEach(() => {
  for (const cleanup of fixture.cleanups) cleanup();
  resetThreadListForTests();
  vi.unstubAllGlobals();
});
it("reads an unloaded thread once, stays blank in flight, then opens its canonical row", async () => {
  let resolve!: (thread: CleanCoreThreadSummary) => void;
  fixture.getThread.mockReturnValue(
    new Promise<CleanCoreThreadSummary>((done) => {
      resolve = done;
    }),
  );
  expect(render()).toBeNull();
  expect(render()).toBeNull(); // Effect cleanup/replay must reuse the pending read.
  expect(fixture.getThread).toHaveBeenCalledExactlyOnceWith({
    threadId: ThreadId.makeUnsafe("thread-51"),
  });
  expect(fixture.navigate).not.toHaveBeenCalled();
  const thread = row();
  resolve(thread);
  await finishRead();
  expect(render()?.props).toEqual({ threadId: thread.id, folderId: thread.folderId });
  expect(fixture.homeView).toHaveBeenLastCalledWith({
    views: [{ threadId: thread.id, folderId: thread.folderId }],
    activeThreadId: thread.id,
  });
  expect(fixture.getThread).toHaveBeenCalledOnce();
  expect(fixture.navigate).not.toHaveBeenCalled();
});
it("goes home when the indexed read finds no thread", async () => {
  fixture.getThread.mockResolvedValue(null);
  expect(render()).toBeNull();
  await finishRead();
  expect(fixture.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/", replace: true });
  expect(fixture.getThread).toHaveBeenCalledOnce();
});
it.each(["archivedAt", "deletedAt"] as const)(
  "goes home when the loaded row has %s",
  async (field) => {
    fixture.getThread.mockResolvedValue({ ...row(), [field]: "2026-10-10T00:01:00.000Z" });
    expect(render()).toBeNull();
    await finishRead();
    expect(fixture.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/", replace: true });
    expect(fixture.getThread).toHaveBeenCalledOnce();
  },
);
it("opens a row already in the canonical store without a read", () => {
  const thread = row();
  applyThreadRow(thread);
  expect(render()?.props).toEqual({ threadId: thread.id, folderId: thread.folderId });
  expect(fixture.getThread).not.toHaveBeenCalled();
  expect(fixture.navigate).not.toHaveBeenCalled();
});
it("shows the existing error toast then goes home without retrying", async () => {
  fixture.getThread.mockRejectedValue(new Error("Indexed read failed"));
  expect(render()).toBeNull();
  await finishRead();
  expect(fixture.toast).toHaveBeenCalledExactlyOnceWith({
    type: "error",
    title: "Could not open the thread",
    description: "Indexed read failed",
  });
  expect(fixture.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/", replace: true });
  expect(fixture.getThread).toHaveBeenCalledOnce();
});
it("opens a local draft without a server read", () => {
  fixture.drafts[fixture.threadId] = {
    folderId: FolderId.makeUnsafe("draft-folder"),
  };
  expect(render()?.props.folderId).toBe("draft-folder");
  expect(fixture.getThread).not.toHaveBeenCalled();
});
it("waits for startup hydration before reading an absent row", async () => {
  fixture.hydrated = false;
  fixture.getThread.mockResolvedValue(row());
  expect(render()).toBeNull();
  expect(fixture.getThread).not.toHaveBeenCalled();
  fixture.hydrated = true;
  expect(render()).toBeNull();
  await finishRead();
  expect(render()).not.toBeNull();
  expect(fixture.getThread).toHaveBeenCalledOnce();
});
