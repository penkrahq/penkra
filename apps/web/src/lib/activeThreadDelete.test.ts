// FILE: activeThreadDelete.test.ts
// Purpose: Characterizes shared active-thread deletion ordering and failure boundaries.
// Layer: Web orchestration helper tests

import { FolderId, ThreadId } from "@penkra/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  events: [] as string[],
  updateThread: vi.fn(),
  confirm: vi.fn(),
  reconcile: vi.fn(),
  removeDeletedThreadFromClientState: vi.fn(),
  orphanedWorktreePath: null as string | null,
  threads: [] as Array<{
    id: ThreadId;
    folderId: FolderId;
    session: { status: string } | null;
  }>,
  orphanResolver: vi.fn(),
  toast: vi.fn(),
}));

const THREAD_ID = ThreadId.make("thread-delete");
const PROJECT_ID = FolderId.make("project-delete");
const THREAD = {
  id: THREAD_ID,
  folderId: PROJECT_ID,
  session: { status: "running" },
};

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    dialogs: { confirm: harness.confirm },
    cleanCore: { updateThread: harness.updateThread },
  }),
}));

vi.mock("../store", () => ({
  useStore: {
    getState: () => ({
      folders: [{ id: PROJECT_ID, cwd: "/repo" }],
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
  harness.updateThread
    .mockReset()
    .mockImplementation(async ({ update }: { update: { action: string } }) => {
      harness.events.push(update.action);
    });
  harness.reconcile.mockReset().mockImplementation(() => {
    harness.events.push("reconcile");
  });
  harness.toast.mockReset();
});

describe("deleteActiveThreadFromClient", () => {
  it("lets the server own runtime cleanup after delete acceptance", async () => {
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

    expect(harness.events).toEqual(["prepare", "delete", "reconcile", "onDeleted"]);
    expect(onDeleted).toHaveBeenCalledWith({ thread: THREAD, prepared: "prepared" });
  });

  it("leaves client state untouched when the server rejects deletion", async () => {
    harness.updateThread.mockImplementation(async ({ update }: { update: { action: string } }) => {
      harness.events.push(update.action);
      if (update.action === "delete") throw new Error("delete rejected");
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
