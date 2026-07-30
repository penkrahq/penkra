import { EventEmitter } from "node:events";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  DESKTOP_PARENT_PID_ENV_KEY,
  type DesktopParentProcess,
  consumeDesktopParentPidFromEnvironment,
  isDesktopParentGone,
  waitForDesktopParentDisconnect,
} from "./desktopParentLifecycle";

class FakeParentProcess extends EventEmitter implements DesktopParentProcess {
  readonly channel: unknown = {};
  connected = true;
  ppid = process.pid;
}

describe("waitForDesktopParentDisconnect", () => {
  it("completes when the Electron IPC parent disconnects", async () => {
    const parentProcess = new FakeParentProcess();
    const wait = Effect.runPromise(
      waitForDesktopParentDisconnect({
        parentProcess,
        expectedParentPid: process.pid,
      }),
    );

    parentProcess.connected = false;
    parentProcess.emit("disconnect");

    await expect(wait).resolves.toBeUndefined();
  });

  it("completes immediately when the IPC parent is already gone", async () => {
    const parentProcess = new FakeParentProcess();
    parentProcess.connected = false;

    await expect(
      Effect.runPromise(
        waitForDesktopParentDisconnect({
          parentProcess,
          expectedParentPid: process.pid,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("detects a reparented POSIX backend even if the old pid was recycled", () => {
    expect(
      isDesktopParentGone({
        expectedParentPid: 42,
        currentParentPid: 1,
        isExpectedParentLive: true,
        platform: "darwin",
      }),
    ).toBe(true);
  });

  it("consumes the expected parent pid without leaving it for provider children", () => {
    const environment = {
      [DESKTOP_PARENT_PID_ENV_KEY]: "1234",
    };
    expect(consumeDesktopParentPidFromEnvironment(environment, "darwin")).toBe(1234);
    expect(environment).toEqual({});
  });
});
