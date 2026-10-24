import { FolderId, SpaceId, ThreadId } from "@penkra/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSpacesUiStore } from "./spacesUiStore";

describe("spacesUiStore", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    useSpacesUiStore.setState({
      activeSpaceId: null,
      serverHydrated: false,
      lastThreadIdBySpace: {},
      lastFolderIdBySpace: {},
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("hydrates only from the durable server record", async () => {
    const personal = SpaceId.make("personal");
    const threadId = ThreadId.make("thread-main");
    Object.assign(window, {
      nativeApi: {
        server: {
          getSpaceNavigationState: vi.fn(async () => ({
            activeSpaceId: personal,
            lastThreadIdBySpace: { [personal]: threadId },
            lastFolderIdBySpace: {},
            updatedAt: "now",
          })),
          updateSpaceNavigationState: vi.fn(),
        },
      },
    });

    await useSpacesUiStore.getState().hydrateFromServer();

    expect(useSpacesUiStore.getState()).toMatchObject({
      activeSpaceId: personal,
      lastThreadIdBySpace: { [personal]: threadId },
      serverHydrated: true,
    });
    expect(window).not.toHaveProperty("sessionStorage");
  });

  it("does not invent a replacement for a missing active Space", () => {
    const removed = SpaceId.make("removed");
    useSpacesUiStore.setState({ activeSpaceId: removed });
    useSpacesUiStore.getState().reconcile({
      activeSpaceIds: new Set(),
      projectSpaceById: new Map(),
      threadProjectById: new Map(),
      threadSpaceById: new Map(),
    });
    expect(useSpacesUiStore.getState().activeSpaceId).toBeNull();
  });

  it("keeps a selected Space while the committed navigation includes it", () => {
    const created = SpaceId.make("created");
    useSpacesUiStore.getState().setActiveSpaceId(created);
    useSpacesUiStore.getState().reconcile({
      activeSpaceIds: new Set([created]),
      projectSpaceById: new Map(),
      threadProjectById: new Map(),
      threadSpaceById: new Map(),
    });
    expect(useSpacesUiStore.getState().activeSpaceId).toBe(created);
  });

  it("keeps only the most recent folder-or-thread target per Space", () => {
    const work = SpaceId.make("work");
    const folderId = FolderId.make("folder-work");
    const threadId = ThreadId.make("thread-work");

    useSpacesUiStore.getState().rememberThread(work, threadId);
    useSpacesUiStore.getState().rememberProject(work, folderId);
    expect(useSpacesUiStore.getState().getLastThreadId(work)).toBeNull();
    expect(useSpacesUiStore.getState().getLastFolderId(work)).toBe(folderId);

    useSpacesUiStore.getState().rememberThread(work, threadId);
    expect(useSpacesUiStore.getState().getLastFolderId(work)).toBeNull();
    expect(useSpacesUiStore.getState().getLastThreadId(work)).toBe(threadId);
  });
});
