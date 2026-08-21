import type { NativeApi, OrchestrationShellSnapshot } from "@penkra/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMocks = vi.hoisted(() => ({
  syncServerShellSnapshot: vi.fn(),
}));

vi.mock("./store", () => ({
  useStore: {
    getState: () => storeMocks,
  },
}));

import { refreshEmptyRouteRestoreSnapshot } from "./chatRouteRecovery";

function shellSnapshot(input: {
  projects?: unknown[];
  threads?: unknown[];
}): OrchestrationShellSnapshot {
  return {
    projects: input.projects ?? [],
    threads: input.threads ?? [],
  } as unknown as OrchestrationShellSnapshot;
}

function makeApi(shell: OrchestrationShellSnapshot) {
  const orchestration = {
    getShellSnapshot: vi.fn().mockResolvedValue(shell),
    getSnapshot: vi.fn(),
    repairState: vi.fn(),
  };

  return {
    api: { orchestration } as unknown as NativeApi,
    orchestration,
  };
}

describe("refreshEmptyRouteRestoreSnapshot", () => {
  beforeEach(() => {
    storeMocks.syncServerShellSnapshot.mockClear();
  });

  it("treats a project-only shell as an authoritative empty Thread set", async () => {
    const shell = shellSnapshot({ projects: [{ id: "project-1" }] });
    const { api, orchestration } = makeApi(shell);

    await expect(refreshEmptyRouteRestoreSnapshot(api)).resolves.toBe(false);

    expect(orchestration.getSnapshot).not.toHaveBeenCalled();
    expect(orchestration.repairState).not.toHaveBeenCalled();
    expect(storeMocks.syncServerShellSnapshot).toHaveBeenCalledWith(shell);
  });

  it("stops at the shell snapshot when it already has threads", async () => {
    const shell = shellSnapshot({
      projects: [{ id: "project-1" }],
      threads: [{ id: "thread-1" }],
    });
    const { api, orchestration } = makeApi(shell);

    await expect(refreshEmptyRouteRestoreSnapshot(api)).resolves.toBe(true);

    expect(orchestration.getSnapshot).not.toHaveBeenCalled();
    expect(orchestration.repairState).not.toHaveBeenCalled();
    expect(storeMocks.syncServerShellSnapshot).toHaveBeenCalledWith(shell);
  });
});
