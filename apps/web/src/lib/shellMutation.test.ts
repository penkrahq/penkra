import type { NativeApi } from "@penkra/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "~/store";
import { initialState } from "~/storeState";
import { dispatchShellCommand } from "./shellMutation";

const command = {
  type: "space.archive" as const,
  commandId: "command-1" as never,
  spaceId: "space-1" as never,
};

function api(
  dispatchCommand: ReturnType<typeof vi.fn>,
  getShellSnapshot: ReturnType<typeof vi.fn>,
) {
  return { orchestration: { dispatchCommand, getShellSnapshot } } as unknown as NativeApi;
}

describe("dispatchShellCommand", () => {
  beforeEach(() => useStore.setState({ ...initialState }));

  it("repairs a missed stream event from the authoritative shell snapshot", async () => {
    const getShellSnapshot = vi.fn().mockResolvedValue({
      snapshotSequence: 7,
      spaces: [],
      archivedSpaces: [],
      folders: [],
      archivedFolders: [],
      threads: [],
      updatedAt: "2026-08-21T00:00:00.000Z",
    });

    await dispatchShellCommand(
      api(vi.fn().mockResolvedValue({ sequence: 7 }), getShellSnapshot),
      command,
    );

    expect(getShellSnapshot).toHaveBeenCalledOnce();
    expect(useStore.getState().shellSnapshotSequence).toBe(7);
  });

  it("does not query when the stream already reached the command receipt", async () => {
    useStore.setState({ shellSnapshotSequence: 9 });
    const getShellSnapshot = vi.fn();

    await dispatchShellCommand(
      api(vi.fn().mockResolvedValue({ sequence: 8 }), getShellSnapshot),
      command,
    );

    expect(getShellSnapshot).not.toHaveBeenCalled();
  });
});
