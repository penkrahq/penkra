import { describe, expect, it, vi } from "vitest";

import {
  buildAppiumServerArguments,
  collectDescendantProcessGroups,
  stopAppleAppiumProcessGroups,
} from "./appleAppiumServer";

describe("Apple Appium server contract", () => {
  it("binds only to loopback without relaxed security or session override", () => {
    const args = buildAppiumServerArguments(4729);
    expect(args).toEqual([
      "server",
      "--address",
      "127.0.0.1",
      "--port",
      "4729",
      "--base-path",
      "/",
      "--log-level",
      "warn",
    ]);
    expect(args).not.toContain("--relaxed-security");
    expect(args).not.toContain("--session-override");
  });
});

describe("Apple Appium process ownership", () => {
  it("finds direct detached child groups without sweeping unrelated descendants", () => {
    expect(
      collectDescendantProcessGroups(
        [
          { pid: 100, ppid: 1, pgid: 100 },
          { pid: 110, ppid: 100, pgid: 110 },
          { pid: 111, ppid: 110, pgid: 110 },
          { pid: 120, ppid: 100, pgid: 100 },
          { pid: 130, ppid: 999, pgid: 130 },
        ],
        100,
      ),
    ).toEqual([110]);
  });

  it("rejects when an owned Appium process group survives forced cleanup", async () => {
    const signal = vi.fn();
    const waitForExit = vi.fn(async () => false);

    await expect(
      stopAppleAppiumProcessGroups({
        processGroups: [100, 110],
        signal,
        waitForExit,
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({
      code: "APPIUM_STOP_FAILED",
      message: "Appium process groups remain live after cleanup: 100, 110.",
    });
    expect(signal.mock.calls).toEqual([
      [100, "SIGTERM"],
      [110, "SIGTERM"],
      [100, "SIGKILL"],
      [110, "SIGKILL"],
    ]);
    expect(waitForExit).toHaveBeenCalledTimes(4);
  });
});
