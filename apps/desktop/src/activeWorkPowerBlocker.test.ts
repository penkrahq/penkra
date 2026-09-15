import { describe, expect, it, vi } from "vitest";

import { ActiveWorkPowerBlocker, type DisplaySleepBlocker } from "./activeWorkPowerBlocker";

function createHarness() {
  const blocker: DisplaySleepBlocker = {
    start: vi.fn(() => 41),
    stop: vi.fn(),
  };
  const onError = vi.fn();
  const onStateChange = vi.fn();
  const manager = new ActiveWorkPowerBlocker({ blocker, onError, onStateChange });
  return { blocker, manager, onError, onStateChange };
}

describe("ActiveWorkPowerBlocker", () => {
  it("starts one display-sleep blocker while thread or voice work is active", () => {
    const { blocker, manager } = createHarness();

    manager.setOwnerState(7, { threadExecution: true, voice: false });
    manager.setOwnerState(7, { threadExecution: true, voice: true });

    expect(blocker.start).toHaveBeenCalledOnce();
    expect(blocker.start).toHaveBeenCalledWith("prevent-display-sleep");
  });

  it("keeps blocking across an atomic thread-to-voice transition", () => {
    const { blocker, manager } = createHarness();

    manager.setOwnerState(7, { threadExecution: true, voice: false });
    manager.setOwnerState(7, { threadExecution: false, voice: true });

    expect(blocker.start).toHaveBeenCalledOnce();
    expect(blocker.stop).not.toHaveBeenCalled();
  });

  it("keeps blocking until the final renderer releases", () => {
    const { blocker, manager } = createHarness();

    manager.setOwnerState(7, { threadExecution: true, voice: false });
    manager.setOwnerState(8, { threadExecution: false, voice: true });
    manager.releaseOwner(7);
    expect(blocker.stop).not.toHaveBeenCalled();

    manager.releaseOwner(8);
    expect(blocker.stop).toHaveBeenCalledOnce();
    expect(blocker.stop).toHaveBeenCalledWith(41);
  });

  it("does not let an older window veto a newer app-wide idle projection", () => {
    const { blocker, manager } = createHarness();

    manager.setOwnerState(7, {
      threadExecution: true,
      voice: false,
      snapshotSequence: 10,
    });
    manager.setOwnerState(8, {
      threadExecution: false,
      voice: false,
      snapshotSequence: 11,
    });

    expect(blocker.stop).toHaveBeenCalledWith(41);

    manager.releaseOwner(8);
    expect(blocker.start).toHaveBeenCalledOnce();

    manager.setOwnerState(7, {
      threadExecution: true,
      voice: false,
      snapshotSequence: 12,
    });
    expect(blocker.start).toHaveBeenCalledTimes(2);
  });

  it("reports the renderer and thread claims behind the native assertion", () => {
    const { manager, onStateChange } = createHarness();

    manager.setOwnerState(7, {
      threadExecution: true,
      voice: false,
      activeThreadIds: ["thread-a", "thread-b"],
    });
    expect(onStateChange).toHaveBeenLastCalledWith({
      ownerId: 7,
      state: {
        threadExecution: true,
        voice: false,
        activeThreadIds: ["thread-a", "thread-b"],
      },
      ownerCount: 1,
      latestSnapshotSequence: null,
      blocksDisplaySleep: true,
    });

    manager.releaseOwner(7);
    expect(onStateChange).toHaveBeenLastCalledWith({
      ownerId: 7,
      state: null,
      ownerCount: 0,
      latestSnapshotSequence: null,
      blocksDisplaySleep: false,
    });
  });

  it("does not report sequence-only updates for unchanged active work", () => {
    const { manager, onStateChange } = createHarness();

    manager.setOwnerState(7, {
      threadExecution: true,
      voice: false,
      activeThreadIds: ["thread-a"],
      snapshotSequence: 10,
    });
    manager.setOwnerState(7, {
      threadExecution: true,
      voice: false,
      activeThreadIds: ["thread-a"],
      snapshotSequence: 11,
    });

    expect(onStateChange).toHaveBeenCalledOnce();
  });

  it("releases when an owner reports no active work", () => {
    const { blocker, manager } = createHarness();

    manager.setOwnerState(7, { threadExecution: true, voice: true });
    manager.setOwnerState(7, { threadExecution: false, voice: false });

    expect(blocker.stop).toHaveBeenCalledWith(41);
  });

  it("releases the blocker during shutdown", () => {
    const { blocker, manager } = createHarness();

    manager.setOwnerState(7, { threadExecution: true, voice: false });
    manager.shutdown();

    expect(blocker.stop).toHaveBeenCalledWith(41);
  });

  it("reports native failures and can retry", () => {
    const { blocker, manager, onError } = createHarness();
    vi.mocked(blocker.start).mockImplementationOnce(() => {
      throw new Error("unavailable");
    });

    expect(() => manager.setOwnerState(7, { threadExecution: true, voice: false })).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();

    manager.setOwnerState(7, { threadExecution: true, voice: false });
    expect(blocker.start).toHaveBeenCalledTimes(2);
  });

  it("forgets a blocker id even when releasing it fails", () => {
    const { blocker, manager, onError } = createHarness();
    vi.mocked(blocker.stop).mockImplementationOnce(() => {
      throw new Error("unavailable");
    });

    manager.setOwnerState(7, { threadExecution: true, voice: false });
    expect(() => manager.releaseOwner(7)).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();

    manager.setOwnerState(7, { threadExecution: false, voice: true });
    expect(blocker.start).toHaveBeenCalledTimes(2);
  });
});
