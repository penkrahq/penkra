import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FolderId, ThreadId } from "@penkra/contracts";
import { parseChatRouteSearch } from "../chatRouteSearch";
import { resolveChatIndexRestoreRoute } from "../routes/-chatIndexRoute.logic";
import { shouldRedirectArchivedThreadRoute } from "../routes/-chatThreadRoute.logic";

import {
  normalizeSidebarProjectThreadListCwd,
  persistSidebarUiState,
  readSidebarUiState,
} from "./Sidebar.uiState";

describe("Sidebar.uiState", () => {
  let storage = new Map<string, string>();

  beforeEach(() => {
    storage = new Map<string, string>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          clear: () => {
            storage.clear();
          },
          getItem: (key: string) => storage.get(key) ?? null,
          removeItem: (key: string) => {
            storage.delete(key);
          },
          setItem: (key: string, value: string) => {
            storage.set(key, value);
          },
        },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
  });

  it("defaults collapsed sidebar UI state with no thread list paging", () => {
    expect(readSidebarUiState()).toEqual({
      collapsedSpaceIds: [],
      chatThreadListExtraPages: 0,
      projectThreadListExtraPagesByCwd: {},
      dismissedThreadStatusKeyByThreadId: {},
      lastThreadRoute: null,
    });
  });

  it("persists project thread list paging by normalized cwd", () => {
    persistSidebarUiState({
      collapsedSpaceIds: ["space-work"],
      chatThreadListExtraPages: 2,
      projectThreadListExtraPagesByCwd: {
        "/Users/tester/Code/demo": 1,
        "/Users/tester/Code/demo/": 3,
        "/Users/tester/Code/other": 2,
      },
      dismissedThreadStatusKeyByThreadId: {
        "thread-123": "Plan Ready:turn-1",
      },
      lastThreadRoute: {
        threadId: "thread-123",
      },
    });

    expect(readSidebarUiState()).toEqual({
      collapsedSpaceIds: ["space-work"],
      chatThreadListExtraPages: 2,
      projectThreadListExtraPagesByCwd: {
        // Duplicate cwds that normalize to the same key keep the deepest paging.
        [normalizeSidebarProjectThreadListCwd("/Users/tester/Code/demo")]: 3,
        [normalizeSidebarProjectThreadListCwd("/Users/tester/Code/other")]: 2,
      },
      dismissedThreadStatusKeyByThreadId: {
        "thread-123": "Plan Ready:turn-1",
      },
      lastThreadRoute: {
        threadId: "thread-123",
      },
    });
  });

  it("ignores malformed persisted thread list paging entries", () => {
    window.localStorage.setItem(
      "penkra:sidebar-ui:v1",
      JSON.stringify({
        collapsedSpaceIds: ["space-work"],
        chatThreadListExtraPages: -4,
        projectThreadListExtraPagesByCwd: {
          "/Users/tester/Code/demo": 2,
          "/Users/tester/Code/zero": 0,
          "/Users/tester/Code/negative": -1,
          "/Users/tester/Code/bad": "nope",
          "": 3,
        },
        dismissedThreadStatusKeyByThreadId: {
          "thread-123": "Awaiting Input:turn-2",
          "": "bad",
          "thread-456": 42,
        },
        lastThreadRoute: {
          threadId: "thread-123",
          splitViewId: "split-old",
        },
      }),
    );

    expect(readSidebarUiState()).toEqual({
      collapsedSpaceIds: ["space-work"],
      chatThreadListExtraPages: 0,
      projectThreadListExtraPagesByCwd: {
        [normalizeSidebarProjectThreadListCwd("/Users/tester/Code/demo")]: 2,
      },
      dismissedThreadStatusKeyByThreadId: {
        "thread-123": "Awaiting Input:turn-2",
      },
      lastThreadRoute: {
        threadId: "thread-123",
      },
    });
  });

  it("sends an archived thread home from an old split URL and saved window state", () => {
    const threadId = ThreadId.makeUnsafe("thread-123");
    const folderId = FolderId.makeUnsafe("folder-1");
    window.localStorage.setItem(
      "penkra:split-threads:v1",
      JSON.stringify({ state: { splitViewsById: {} } }),
    );
    window.localStorage.setItem(
      "penkra:sidebar-ui:v1",
      JSON.stringify({
        lastThreadRoute: { threadId: "thread-123", splitViewId: "split-old" },
      }),
    );

    const rememberedRoute = readSidebarUiState().lastThreadRoute;
    expect(rememberedRoute).toEqual({ threadId });
    expect(window.localStorage.getItem("penkra:split-threads:v1")).toBeNull();
    expect(parseChatRouteSearch({ splitViewId: "split-old" })).toEqual({});
    expect(
      shouldRedirectArchivedThreadRoute({ archived: true, localArchiveNavigationPending: false }),
    ).toBe(true);
    expect(
      resolveChatIndexRestoreRoute({
        lastThreadRoute: rememberedRoute,
        threadIds: [threadId],
        sidebarThreadSummaryById: {
          [threadId]: { folderId, archivedAt: "2026-09-26T00:00:00.000Z" },
        },
        draftFolderIdByThreadId: new Map(),
        landingSpace: null,
      }),
    ).toBeNull();
  });

  it("migrates legacy all-or-nothing show-more state to one extra page", () => {
    window.localStorage.setItem(
      "penkra:sidebar-ui:v1",
      JSON.stringify({
        collapsedSpaceIds: [],
        chatThreadListExpanded: true,
        expandedProjectThreadListCwds: ["/Users/tester/Code/demo", "/Users/tester/Code/other"],
      }),
    );

    expect(readSidebarUiState()).toMatchObject({
      chatThreadListExtraPages: 1,
      projectThreadListExtraPagesByCwd: {
        [normalizeSidebarProjectThreadListCwd("/Users/tester/Code/demo")]: 1,
        [normalizeSidebarProjectThreadListCwd("/Users/tester/Code/other")]: 1,
      },
    });
  });

  it("drops malformed persisted last thread routes", () => {
    window.localStorage.setItem(
      "penkra:sidebar-ui:v1",
      JSON.stringify({
        lastThreadRoute: {
          threadId: 42,
          splitViewId: "split-123",
        },
      }),
    );

    expect(readSidebarUiState()).toEqual({
      collapsedSpaceIds: [],
      chatThreadListExtraPages: 0,
      projectThreadListExtraPagesByCwd: {},
      dismissedThreadStatusKeyByThreadId: {},
      lastThreadRoute: null,
    });
  });
});
