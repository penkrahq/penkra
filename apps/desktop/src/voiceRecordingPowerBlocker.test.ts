import { describe, expect, it, vi } from "vitest";

import { VoiceRecordingPowerBlocker, type DisplaySleepBlocker } from "./voiceRecordingPowerBlocker";

function createHarness() {
  const blocker: DisplaySleepBlocker = {
    start: vi.fn(() => 41),
    stop: vi.fn(),
  };
  const onError = vi.fn();
  const manager = new VoiceRecordingPowerBlocker({ blocker, onError });
  return { blocker, manager, onError };
}

describe("VoiceRecordingPowerBlocker", () => {
  it("starts one display-sleep blocker for duplicate activation", () => {
    const { blocker, manager } = createHarness();

    manager.setRecordingActive(7, "first", true);
    manager.setRecordingActive(7, "first", true);

    expect(blocker.start).toHaveBeenCalledOnce();
    expect(blocker.start).toHaveBeenCalledWith("prevent-display-sleep");
  });

  it("keeps blocking until the final active owner releases", () => {
    const { blocker, manager } = createHarness();

    manager.setRecordingActive(7, "first", true);
    manager.setRecordingActive(8, "second", true);
    manager.releaseOwner(7);
    expect(blocker.stop).not.toHaveBeenCalled();

    manager.releaseOwner(8);
    expect(blocker.stop).toHaveBeenCalledOnce();
    expect(blocker.stop).toHaveBeenCalledWith(41);
  });

  it("tracks independent recording leases owned by the same renderer", () => {
    const { blocker, manager } = createHarness();

    manager.setRecordingActive(7, "first", true);
    manager.setRecordingActive(7, "second", true);
    manager.setRecordingActive(7, "first", false);
    expect(blocker.stop).not.toHaveBeenCalled();

    manager.setRecordingActive(7, "second", false);
    expect(blocker.stop).toHaveBeenCalledWith(41);
  });

  it("makes duplicate release harmless", () => {
    const { blocker, manager } = createHarness();

    manager.setRecordingActive(7, "first", true);
    manager.setRecordingActive(7, "first", false);
    manager.setRecordingActive(7, "first", false);

    expect(blocker.stop).toHaveBeenCalledOnce();
  });

  it("releases the blocker during shutdown", () => {
    const { blocker, manager } = createHarness();

    manager.setRecordingActive(7, "first", true);
    manager.shutdown();

    expect(blocker.stop).toHaveBeenCalledWith(41);
  });

  it("reports start failures without breaking recording state", () => {
    const { blocker, manager, onError } = createHarness();
    vi.mocked(blocker.start).mockImplementationOnce(() => {
      throw new Error("unavailable");
    });

    expect(() => manager.setRecordingActive(7, "first", true)).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();

    manager.setRecordingActive(7, "first", true);
    expect(blocker.start).toHaveBeenCalledTimes(2);
  });

  it("forgets a blocker id even when releasing it fails", () => {
    const { blocker, manager, onError } = createHarness();
    vi.mocked(blocker.stop).mockImplementationOnce(() => {
      throw new Error("unavailable");
    });

    manager.setRecordingActive(7, "first", true);
    expect(() => manager.releaseOwner(7)).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();

    manager.setRecordingActive(7, "first", true);
    expect(blocker.start).toHaveBeenCalledTimes(2);
  });
});
