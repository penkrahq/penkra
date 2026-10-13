// @vitest-environment happy-dom
// Exercises the real Sidebar and its stores; only transport/query and physical DnD boundaries are stubbed.
import { FolderId, SpaceId, ThreadId, type CleanCoreThreadSummary } from "@penkra/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, createContext, Profiler, useContext, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ listThreads: vi.fn(), onSidebarChange: vi.fn(() => () => {}) }));
vi.mock("../nativeApi", () => ({
  ensureNativeApi: () => ({ cleanCore: api }),
  readNativeApi: () => null,
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: undefined, isPending: false, isFetching: false }),
  useQueries: () => [],
}));
vi.mock("../threadDetailSubscriptionRetention", () => ({
  retainThreadDetailSubscription: () => () => {},
}));
vi.mock("./sidebar/SidebarDnd", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sidebar/SidebarDnd")>()),
  SortableSidebarNode: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarContainerDropTarget: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarContainerDropPreview: () => null,
  SidebarDndMonitor: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import Sidebar from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";
import { persistSidebarUiState, readSidebarUiState } from "./Sidebar.uiState";
import { applyThreadRow, resetThreadListForTests } from "../threadListStore";
import { useStore } from "../store";
import { useSpacesUiStore } from "../spacesUiStore";
import type { Project, Space } from "../types";

const spaceId = SpaceId.makeUnsafe("sidebar-stable-space");
const folderId = FolderId.makeUnsafe("sidebar-stable-folder");
const targetId = ThreadId.makeUnsafe("sidebar-target");
const previousId = ThreadId.makeUnsafe("sidebar-previous");
const at = "2026-10-11T00:00:00.000Z";
const folder: Project = {
  id: folderId,
  spaceId,
  name: "Stable folder",
  remoteName: "Stable folder",
  folderName: "stable",
  localName: null,
  cwd: "/stable",
  defaultModelSelection: null,
  expanded: true,
};
const space: Space = {
  id: spaceId,
  name: "Stable space",
  icon: "bag",
  sortOrder: 0,
  createdAt: at,
  updatedAt: at,
};
function row(id: ThreadId, title: string): CleanCoreThreadSummary {
  return {
    latestTurn: null,
    id,
    spaceId,
    folderId,
    title,
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
    createdAt: at,
    updatedAt: at,
  };
}
const ForceRender = createContext(0);
function MountedSidebar() {
  useContext(ForceRender);
  return (
    <SidebarProvider>
      <Sidebar />
    </SidebarProvider>
  );
}
const originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
let root: Root | undefined;
let container: HTMLElement;
let client: QueryClient;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  window.localStorage.clear();
  resetThreadListForTests();
  vi.clearAllMocks();
  const rows = [row(targetId, "Target"), row(previousId, "Previous")];
  rows.forEach(applyThreadRow);
  api.listThreads.mockResolvedValue({ threads: rows, nextCursor: null });
  useStore.setState({ spaces: [space], folders: [folder], threadsHydrated: true });
  useSpacesUiStore.setState({ activeSpaceId: spaceId });
  persistSidebarUiState({
    collapsedSpaceIds: [],
    chatThreadListExtraPages: 0,
    projectThreadListExtraPagesByCwd: { "/stable": 2 },
    dismissedThreadStatusKeyByThreadId: {
      [targetId]: "seen-target",
      [previousId]: "seen-previous",
    },
    lastThreadRoute: { threadId: previousId },
  });
  client = new QueryClient();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  client.clear();
  document.body.replaceChildren();
  if (originalGetAnimations)
    Object.defineProperty(Element.prototype, "getAnimations", originalGetAnimations);
  else Reflect.deleteProperty(Element.prototype, "getAnimations");
});

it("converges with collapsed paging, dismissed statuses and route activation, then stays stable on unchanged renders", async () => {
  const route = createRootRoute();
  const threadRoute = createRoute({
    getParentRoute: () => route,
    path: "/$threadId",
    component: MountedSidebar,
  });
  const router = createRouter({
    routeTree: route.addChildren([threadRoute]),
    history: createMemoryHistory({ initialEntries: [`/${previousId}`] }),
  });
  expect(readSidebarUiState().projectThreadListExtraPagesByCwd).toEqual({ "/stable": 2 });
  expect(readSidebarUiState().dismissedThreadStatusKeyByThreadId).toEqual({
    [targetId]: "seen-target",
    [previousId]: "seen-previous",
  });
  await router.load();
  const commits = vi.fn();
  const render = (version: number) =>
    root!.render(
      <QueryClientProvider client={client}>
        <ForceRender.Provider value={version}>
          <Profiler id="sidebar" onRender={commits}>
            <RouterProvider router={router} />
          </Profiler>
        </ForceRender.Provider>
      </QueryClientProvider>,
    );
  await act(async () => render(0));
  const target = container.querySelector<HTMLElement>('[data-thread-item][aria-label="Target"]');
  expect(target).not.toBeNull();
  await act(async () => {
    target!.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        buttons: 1,
        pointerType: "mouse",
      }),
    );
  });
  expect(target!.getAttribute("data-state")).toBe("default");
  expect(
    container
      .querySelector('[data-thread-item][aria-label="Previous"]')
      ?.getAttribute("data-state"),
  ).toBe("active");
  await act(async () => {
    await router.navigate({ to: "/$threadId", params: { threadId: targetId } });
  });
  expect(target!.getAttribute("data-state")).toBe("active");
  await act(async () => {
    useStore.setState({ folders: [{ ...folder, expanded: false }] });
    applyThreadRow({
      ...row(previousId, "Previous"),
      archivedAt: "2026-10-11T00:00:01.000Z",
      updatedAt: "2026-10-11T00:00:01.000Z",
    });
  });
  expect(readSidebarUiState().projectThreadListExtraPagesByCwd).toEqual({});
  expect(readSidebarUiState().dismissedThreadStatusKeyByThreadId).toEqual({
    [targetId]: "seen-target",
  });
  expect(readSidebarUiState().lastThreadRoute).toEqual({ threadId: targetId });
  commits.mockClear();
  await act(async () => render(1));
  expect(commits).toHaveBeenCalledTimes(1);
  commits.mockClear();
  await act(async () => render(2));
  expect(commits).toHaveBeenCalledTimes(1);
});
