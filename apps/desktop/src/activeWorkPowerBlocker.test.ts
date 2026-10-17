import { describe, expect, it, vi } from "vitest";
import { ActiveWorkPowerBlocker } from "./activeWorkPowerBlocker";
function harness() {
  const blocker = { start: vi.fn(() => 41), stop: vi.fn() };
  const onError = vi.fn();
  const onStateChange = vi.fn();
  return {
    blocker,
    onError,
    onStateChange,
    manager: new ActiveWorkPowerBlocker({ blocker, onError, onStateChange }),
  };
}
describe("ActiveWorkPowerBlocker", () => {
  it("blocks for server-owned work with no renderer or window", () => {
    const { manager, blocker } = harness();
    manager.setWorkingThreads(["server-thread"]);
    expect(blocker.start).toHaveBeenCalledWith("prevent-display-sleep");
    manager.releaseOwner(7);
    expect(blocker.stop).not.toHaveBeenCalled();
    manager.setWorkingThreads([]);
    expect(blocker.stop).toHaveBeenCalledWith(41);
  });
  it("holds one assertion across thread and multi-window voice changes", () => {
    const { manager, blocker } = harness();
    manager.setWorkingThreads(["a"]);
    manager.setVoice(7, true);
    manager.setVoice(8, true);
    manager.setWorkingThreads([]);
    manager.releaseOwner(7);
    expect(blocker.stop).not.toHaveBeenCalled();
    manager.releaseOwner(8);
    expect(blocker.stop).toHaveBeenCalledOnce();
    expect(blocker.start).toHaveBeenCalledOnce();
  });
  it("a renderer cannot override server work or keep a completed thread active", () => {
    const { manager, blocker } = harness();
    manager.setWorkingThreads(["a"]);
    manager.setVoice(7, false);
    manager.releaseOwner(7);
    expect(blocker.stop).not.toHaveBeenCalled();
    manager.setWorkingThreads([]);
    expect(blocker.stop).toHaveBeenCalledOnce();
  });
  it("reports identity changes even when the working count stays the same", () => {
    const { manager, onStateChange } = harness();
    manager.setWorkingThreads(["a"]);
    manager.setWorkingThreads(["a"]);
    expect(onStateChange).toHaveBeenCalledOnce();
    manager.setWorkingThreads(["b"]);
    expect(onStateChange).toHaveBeenLastCalledWith({
      working: ["b"],
      voiceOwners: [],
      blocksDisplaySleep: true,
    });
  });
  it("releases both sources during shutdown", () => {
    const { manager, blocker } = harness();
    manager.setWorkingThreads(["a"]);
    manager.setVoice(7, true);
    manager.shutdown();
    expect(blocker.stop).toHaveBeenCalledWith(41);
  });
  it("reports native start failures and attempts again on the next input", () => {
    const { manager, blocker, onError } = harness();
    blocker.start.mockImplementationOnce(() => {
      throw new Error("unavailable");
    });
    expect(() => manager.setWorkingThreads(["a"])).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
    manager.setWorkingThreads(["b"]);
    expect(blocker.start).toHaveBeenCalledTimes(2);
  });
  it("forgets a failed native release and reports its error", () => {
    const { manager, blocker, onError } = harness();
    manager.setWorkingThreads(["a"]);
    blocker.stop.mockImplementationOnce(() => {
      throw new Error("unavailable");
    });
    expect(() => manager.setWorkingThreads([])).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
    manager.setVoice(7, true);
    expect(blocker.start).toHaveBeenCalledTimes(2);
  });
});
