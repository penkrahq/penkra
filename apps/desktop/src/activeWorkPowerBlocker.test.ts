import { describe, expect, it, vi } from "vitest";

import { ActiveWorkPowerBlocker, type DisplaySleepBlocker } from "./activeWorkPowerBlocker";

function createHarness() {
  const blocker: DisplaySleepBlocker = {
    start: vi.fn(() => 41),
    stop: vi.fn(),
  };
  const onError = vi.fn();
  const manager = new ActiveWorkPowerBlocker({ blocker, onError });
  return { blocker, manager, onError };
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
