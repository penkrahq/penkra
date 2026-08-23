import { FolderId, SpaceId, ThreadId } from "@penkra/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSpacesUiStore } from "./spacesUiStore";

describe("spacesUiStore", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    useSpacesUiStore.setState({
      activeSpaceId: null,
      serverHydrated: false,
      pendingActiveSpace: null,
      lastThreadIdBySpace: {},
      lastFolderIdBySpace: {},
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("hydrates only from the durable server record", async () => {
    const personal = SpaceId.makeUnsafe("personal");
    const threadId = ThreadId.makeUnsafe("thread-main");
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
    const removed = SpaceId.makeUnsafe("removed");
    useSpacesUiStore.setState({ activeSpaceId: removed });
    useSpacesUiStore.getState().reconcile({
      activeSpaceIds: new Set(),
      snapshotSequence: 1,
      projectSpaceById: new Map(),
      threadProjectById: new Map(),
      threadSpaceById: new Map(),
    });
    expect(useSpacesUiStore.getState().activeSpaceId).toBeNull();
  });

  it("keeps an optimistic selection only until an authoritative snapshot can judge it", () => {
    const created = SpaceId.makeUnsafe("created");
    useSpacesUiStore.getState().setOptimisticActiveSpaceId(created, 12);

    const reconcile = (snapshotSequence: number, activeSpaceIds: ReadonlySet<SpaceId>) =>
      useSpacesUiStore.getState().reconcile({
        activeSpaceIds,
        snapshotSequence,
        projectSpaceById: new Map(),
        threadProjectById: new Map(),
        threadSpaceById: new Map(),
      });

    reconcile(11, new Set());
    expect(useSpacesUiStore.getState().activeSpaceId).toBe(created);
    reconcile(12, new Set());
    expect(useSpacesUiStore.getState().activeSpaceId).toBeNull();
    expect(useSpacesUiStore.getState().pendingActiveSpace).toBeNull();
  });

  it("keeps only the most recent folder-or-thread target per Space", () => {
    const work = SpaceId.makeUnsafe("work");
    const folderId = FolderId.makeUnsafe("folder-work");
    const threadId = ThreadId.makeUnsafe("thread-work");

    useSpacesUiStore.getState().rememberThread(work, threadId);
    useSpacesUiStore.getState().rememberProject(work, folderId);
    expect(useSpacesUiStore.getState().getLastThreadId(work)).toBeNull();
    expect(useSpacesUiStore.getState().getLastFolderId(work)).toBe(folderId);

    useSpacesUiStore.getState().rememberThread(work, threadId);
    expect(useSpacesUiStore.getState().getLastFolderId(work)).toBeNull();
    expect(useSpacesUiStore.getState().getLastThreadId(work)).toBe(threadId);
  });
});
