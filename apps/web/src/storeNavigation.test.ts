import { FolderId, SpaceId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";
import { syncServerNavigation, syncServerStartup } from "./storeProjection";
import { initialState } from "./storeState";
import { makeProject, makeReadModelProject, makeState, makeThread } from "./storeTestFixtures";

const at = "2026-10-12T00:00:00.000Z";
const spaceId = SpaceId.make("space");
const space = {
  id: spaceId,
  name: "Work",
  icon: "bag" as const,
  sortOrder: 0,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
};
const folder = makeReadModelProject({ spaceId, workspaceRoot: "/tmp/shared" });

describe("canonical navigation re-reads", () => {
  it("hydrates cold startup with folders before readiness", () => {
    const initial = { ...initialState, spaces: [], folders: [], startupHydrated: false };
    const ready = syncServerStartup(initial, {
      navigation: { spaces: [space], folders: [folder] },
      runningThreads: [],
    });
    expect(initial.startupHydrated).toBe(false);
    expect(initial.folders).toEqual([]);
    expect(ready.startupHydrated).toBe(true);
    expect(ready.folders.find((row) => row.spaceId === spaceId)?.id).toBe(folder.id);
  });
  it("does not manufacture a folder for a genuinely empty Space", () => {
    const ready = syncServerStartup(initialState, {
      navigation: { spaces: [space], folders: [] },
      runningThreads: [],
    });
    expect(ready.startupHydrated).toBe(true);
    expect(ready.spaces[0]?.id).toBe(spaceId);
    expect(ready.folders).toEqual([]);
  });
  it("applies complete current navigation again on reconnect", () => {
    const before = syncServerStartup(initialState, {
      navigation: { spaces: [space], folders: [folder] },
      runningThreads: [],
    });
    const after = syncServerStartup(before, {
      navigation: { spaces: [space], folders: [{ ...folder, title: "After reconnect" }] },
      runningThreads: [],
    });
    expect(after.startupHydrated).toBe(true);
    expect(after.folders[0]?.name).toBe("After reconnect");
  });
  it("adds complete folder and Space rows without waiting for a domain event", () => {
    const state = syncServerNavigation(
      { ...makeState(makeThread()), spaces: [], folders: [] },
      { spaces: [space], folders: [folder] },
    );
    expect(state.spaces[0]).toMatchObject({ id: spaceId, name: "Work" });
    expect(state.folders[0]).toMatchObject({
      id: folder.id,
      cwd: "/tmp/shared",
      name: folder.title,
    });
  });
  it("replaces authoritative titles and roots while preserving separate identities at one path", () => {
    const old = makeProject({
      id: FolderId.make("old"),
      spaceId,
      cwd: "/tmp/shared",
      name: "Local",
      localName: "Local",
      remoteName: "Original",
    });
    const state = syncServerNavigation(
      { ...makeState(makeThread()), spaces: [space], folders: [old] },
      {
        spaces: [space],
        folders: [
          { ...folder, id: old.id, title: "Renamed" },
          { ...folder, id: FolderId.make("new") },
        ],
      },
    );
    expect(state.folders).toHaveLength(2);
    expect(state.folders[0]).toMatchObject({
      id: old.id,
      name: "Renamed",
      localName: null,
      cwd: "/tmp/shared",
    });
    expect(state.folders[1]?.id).toBe("new");
  });
  it("keeps a virtual folder virtual", () => {
    const state = syncServerNavigation(
      { ...makeState(makeThread()), folders: [] },
      { spaces: [space], folders: [{ ...folder, title: "Ideas", workspaceRoot: null }] },
    );
    expect(state.folders[0]).toMatchObject({ name: "Ideas", folderName: "Ideas", cwd: "" });
  });
  it("removes omitted folders, including archived folders, on the authoritative read", () => {
    const initial = {
      ...makeState(makeThread()),
      folders: [makeProject({ id: folder.id, spaceId })],
    };
    expect(syncServerNavigation(initial, { spaces: [space], folders: [] }).folders).toEqual([]);
  });
  it("removes an empty Space without manufacturing a new folder assignment", () => {
    const initial = {
      ...makeState(makeThread()),
      spaces: [space],
      folders: [makeProject({ id: folder.id, spaceId })],
    };
    const state = syncServerNavigation(initial, { spaces: [], folders: [folder] });
    expect(state.spaces).toEqual([]);
    expect(state.folders[0]?.spaceId).toBe(spaceId);
  });
  it("restores a Space from the latest read without changing its folders", () => {
    const initial = {
      ...makeState(makeThread()),
      spaces: [],
      folders: [makeProject({ id: folder.id, spaceId })],
    };
    const state = syncServerNavigation(initial, {
      spaces: [{ ...space, name: "Restored Work" }],
      folders: [folder],
    });
    expect(state.spaces[0]?.name).toBe("Restored Work");
    expect(state.folders[0]?.spaceId).toBe(spaceId);
  });
  it("an empty authoritative read clears every navigation row", () => {
    const initial = {
      ...makeState(makeThread()),
      spaces: [space],
      folders: [makeProject({ id: folder.id, spaceId })],
    };
    const state = syncServerNavigation(initial, { spaces: [], folders: [] });
    expect(state.spaces).toEqual([]);
    expect(state.folders).toEqual([]);
  });
});
