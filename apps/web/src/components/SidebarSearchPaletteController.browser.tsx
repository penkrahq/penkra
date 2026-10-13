// FILE: SidebarSearchPaletteController.browser.tsx
// Purpose: Exercise server search outside loaded sidebar pages, stale reads and paging.
// Layer: Web browser regression tests

import "../index.css";
import {
  FolderId,
  type CleanCoreSearchThreadsInput,
  type CleanCoreSearchThreadsResult,
  type CleanCoreThreadSearchMatch,
  SpaceId,
  ThreadId,
} from "@penkra/contracts";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, expect, it, vi } from "vitest";
import { SidebarSearchPaletteController } from "./SidebarSearchPaletteController";
import { SidebarThreadPageEnd } from "./SidebarThreadPageEnd";
import { getThreadListById, resetThreadListForTests } from "../threadListStore";
import { toastManager } from "./ui/toast";

const api = vi.hoisted(() => ({
  searchThreads:
    vi.fn<(input: CleanCoreSearchThreadsInput) => Promise<CleanCoreSearchThreadsResult>>(),
  onSidebarChange: vi.fn(() => () => {}),
}));
vi.mock("../nativeApi", () => ({ ensureNativeApi: () => ({ cleanCore: api }) }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueries: () => [],
}));

const spaceId = SpaceId.makeUnsafe("search-space");
function result(id: string): CleanCoreThreadSearchMatch {
  return {
    latestTurn: null,
    id: ThreadId.makeUnsafe(id),
    spaceId,
    folderId: FolderId.makeUnsafe("folder"),
    title: id,
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
    matchKind: "title",
    messageId: null,
    messageText: null,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function mount(onOpenThread = vi.fn()) {
  const view = await render(
    <SidebarSearchPaletteController
      open
      spaceId={spaceId}
      mode="search"
      onModeChange={() => {}}
      onOpenChange={() => {}}
      actions={[]}
      folders={[]}
      projectById={new Map()}
      onCreateChat={() => {}}
      onCreateThread={() => {}}
      onOpenSettings={() => {}}
      onOpenFeedback={() => {}}
      onOpenUsageSettings={() => {}}
      onOpenProject={() => {}}
      onImportThread={async () => {}}
      onOpenThread={onOpenThread}
    />,
  );
  return { view, onOpenThread };
}
beforeEach(() => {
  resetThreadListForTests();
  api.searchThreads.mockReset().mockResolvedValue({ threads: [], nextCursor: null });
});

it("shows and opens a server result absent from loaded sidebar pages without another row read", async () => {
  const thread = result("Unloaded conversation");
  expect(getThreadListById().has(thread.id)).toBe(false);
  api.searchThreads.mockResolvedValue({ threads: [thread], nextCursor: null });
  const { view, onOpenThread } = await mount();
  try {
    await expect.element(page.getByText(thread.title, { exact: true })).toBeVisible();
    expect(api.searchThreads).toHaveBeenCalledExactlyOnceWith({
      spaceId,
      query: "",
      cursor: null,
    });
    await page.getByText(thread.title, { exact: true }).click();
    expect(onOpenThread).toHaveBeenCalledWith(thread.id);
    expect(getThreadListById().get(thread.id)?.title).toBe(thread.title);
  } finally {
    await view.unmount();
  }
});

it("drops a late reply from an older query before applying its rows", async () => {
  const older = deferred<CleanCoreSearchThreadsResult>();
  const newer = deferred<CleanCoreSearchThreadsResult>();
  api.searchThreads.mockImplementation((input) =>
    input.query === "older"
      ? older.promise
      : input.query === "newer"
        ? newer.promise
        : Promise.resolve({ threads: [], nextCursor: null }),
  );
  const { view } = await mount();
  try {
    const input = page.getByPlaceholder("Search folders, threads, and actions");
    await input.fill("older");
    await vi.waitFor(() =>
      expect(api.searchThreads).toHaveBeenCalledWith({
        spaceId,
        query: "older",
        cursor: null,
      }),
    );
    await input.fill("newer");
    await vi.waitFor(() =>
      expect(api.searchThreads).toHaveBeenCalledWith({
        spaceId,
        query: "newer",
        cursor: null,
      }),
    );
    newer.resolve({ threads: [result("Newer result")], nextCursor: null });
    await expect.element(page.getByText("Newer result", { exact: true })).toBeVisible();
    older.resolve({ threads: [result("Obsolete result")], nextCursor: null });
    await older.promise;
    await expect.element(page.getByText("Newer result", { exact: true })).toBeVisible();
    expect(getThreadListById().has("Obsolete result")).toBe(false);
    expect(document.body.textContent).not.toContain("Obsolete result");
  } finally {
    await view.unmount();
  }
});

it("shows the existing error toast for a failed server read", async () => {
  api.searchThreads.mockRejectedValue(new Error("search unavailable"));
  const toast = vi.spyOn(toastManager, "add");
  const { view } = await mount();
  try {
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Could not search threads",
          description: "search unavailable",
        }),
      ),
    );
    expect(api.searchThreads).toHaveBeenCalledTimes(1);
  } finally {
    toast.mockRestore();
    await view.unmount();
  }
});

it("loads the next keyset page when the list end intersects, once per pending page", async () => {
  let intersect!: IntersectionObserverCallback;
  let observed!: Element;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = callback;
      }
      observe(element: Element) {
        observed = element;
      }
      disconnect() {}
    },
  );
  const first = Array.from({ length: 50 }, (_, index) => result(`Thread ${index}`));
  const last = first[49]!;
  const cursor = { matchKind: last.matchKind, lastActivityAt: last.lastActivityAt, id: last.id };
  const next = deferred<CleanCoreSearchThreadsResult>();
  api.searchThreads
    .mockResolvedValueOnce({ threads: first, nextCursor: cursor })
    .mockImplementationOnce(() => next.promise);
  const { view } = await mount();
  try {
    await vi.waitFor(() => expect(observed?.hasAttribute("data-thread-page-end")).toBe(true));
    const entries = [{ isIntersecting: true, target: observed }] as IntersectionObserverEntry[];
    intersect(entries, {} as IntersectionObserver);
    intersect(entries, {} as IntersectionObserver);
    await vi.waitFor(() => expect(api.searchThreads).toHaveBeenCalledTimes(2));
    expect(api.searchThreads).toHaveBeenLastCalledWith({ spaceId, query: "", cursor });
    next.resolve({ threads: [result("Next page thread")], nextCursor: null });
    await vi.waitFor(() => expect(document.body.textContent).toContain("Next page thread"));
    expect(getThreadListById().size).toBe(51);
    expect(api.searchThreads).toHaveBeenCalledTimes(2);
  } finally {
    await view.unmount();
    vi.unstubAllGlobals();
  }
});

it("keeps the page-end observer across renders with unchanged paging values", async () => {
  const observe = vi.fn();
  const disconnect = vi.fn();
  const createObserver = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        createObserver(callback);
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  const onLoadNextPage = vi.fn();
  const view = await render(
    <SidebarThreadPageEnd loading={false} hasNextPage onLoadNextPage={onLoadNextPage} />,
  );
  try {
    expect(createObserver).toHaveBeenCalledOnce();
    await view.rerender(
      <SidebarThreadPageEnd loading={false} hasNextPage onLoadNextPage={onLoadNextPage} />,
    );
    expect(createObserver).toHaveBeenCalledOnce();
    expect(disconnect).not.toHaveBeenCalled();
    await view.rerender(
      <SidebarThreadPageEnd loading hasNextPage onLoadNextPage={onLoadNextPage} />,
    );
    expect(disconnect).toHaveBeenCalledOnce();
    expect(createObserver).toHaveBeenCalledOnce();
  } finally {
    await view.unmount();
    vi.unstubAllGlobals();
  }
});
