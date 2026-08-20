// FILE: activeThreadDelete.test.ts
// Purpose: Characterizes shared active-thread deletion ordering and failure boundaries.
// Layer: Web orchestration helper tests

import { ContainerId, ThreadId } from "@penkra/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  events: [] as string[],
  dispatchCommand: vi.fn(),
  confirm: vi.fn(),
  disposeThread: vi.fn(),
  reconcile: vi.fn(),
  removeDeletedThreadFromClientState: vi.fn(),
  orphanedWorktreePath: null as string | null,
  threads: [] as Array<{
    id: ThreadId;
    projectId: ContainerId;
    session: { status: string } | null;
  }>,
  orphanResolver: vi.fn(),
  toast: vi.fn(),
}));

const THREAD_ID = ThreadId.makeUnsafe("thread-delete");
const PROJECT_ID = ContainerId.makeUnsafe("project-delete");
const THREAD = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  session: { status: "running" },
};

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    dialogs: { confirm: harness.confirm },
    orchestration: { dispatchCommand: harness.dispatchCommand },
  }),
}));

vi.mock("../store", () => ({
  useStore: {
    getState: () => ({
      projects: [{ id: PROJECT_ID, cwd: "/repo" }],
      removeDeletedThreadFromClientState: harness.removeDeletedThreadFromClientState,
    }),
  },
}));

vi.mock("../threadDerivation", () => ({
  getThreadFromState: () => THREAD,
  getThreadsFromState: () => harness.threads,
}));

vi.mock("../worktreeCleanup", () => ({
  formatWorktreePathForDisplay: (path: string) => path,
  getOrphanedWorktreePathForThread: harness.orphanResolver,
}));

vi.mock("../components/terminal/terminalRuntimeRegistry", () => ({
  terminalRuntimeRegistry: { disposeThread: harness.disposeThread },
}));

vi.mock("./deletedThreadClientReconciliation", () => ({
  reconcileDeletedThreadFromClient: harness.reconcile,
}));

vi.mock("../components/ui/toast", () => ({
  toastManager: { add: harness.toast },
}));

import { deleteActiveThreadFromClient } from "./activeThreadDelete";

beforeEach(() => {
  harness.events.length = 0;
  harness.orphanedWorktreePath = null;
  harness.threads = [THREAD];
  harness.orphanResolver.mockReset().mockImplementation(() => harness.orphanedWorktreePath);
  harness.confirm.mockReset().mockResolvedValue(false);
  harness.dispatchCommand.mockReset().mockImplementation(async (command: { type: string }) => {
    harness.events.push(command.type);
  });
  harness.disposeThread.mockReset().mockImplementation(() => {
    harness.events.push("terminal.dispose");
  });
  harness.reconcile.mockReset().mockImplementation(() => {
    harness.events.push("reconcile");
  });
  harness.toast.mockReset();
});

describe("deleteActiveThreadFromClient", () => {
  it("lets the server own runtime cleanup and disposes the renderer after delete acceptance", async () => {
    const onDeleted = vi.fn(() => {
      harness.events.push("onDeleted");
    });

    await deleteActiveThreadFromClient({
      threadId: THREAD_ID,
      prepareForDelete: () => {
        harness.events.push("prepare");
        return "prepared";
      },
      onDeleted,
    });

    expect(harness.events).toEqual([
      "prepare",
      "thread.delete",
      "terminal.dispose",
      "reconcile",
      "onDeleted",
    ]);
    expect(onDeleted).toHaveBeenCalledWith({ thread: THREAD, prepared: "prepared" });
  });

  it("leaves client state untouched when the server rejects deletion", async () => {
    harness.dispatchCommand.mockImplementation(async (command: { type: string }) => {
      harness.events.push(command.type);
      if (command.type === "thread.delete") throw new Error("delete rejected");
    });
    const onDeleted = vi.fn();

    await expect(
      deleteActiveThreadFromClient({
        threadId: THREAD_ID,
        onDeleted,
      }),
    ).rejects.toThrow("delete rejected");

    expect(harness.reconcile).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
