import { describe, expect, it } from "vitest";

import { resolveDevRemoteDebuggingPort } from "./devRemoteDebugging";

describe("resolveDevRemoteDebuggingPort", () => {
  it("leaves Chromium debugging disabled unless explicitly requested", () => {
    expect(resolveDevRemoteDebuggingPort({})).toBeNull();
  });

  it("accepts a valid loopback debugging port", () => {
    expect(
      resolveDevRemoteDebuggingPort({
        PENKRA_DEV_REMOTE_DEBUGGING_PORT: " 9333 ",
      }),
    ).toBe("9333");
  });

  it("derives a distinct endpoint for each numbered Penkra Dev instance", () => {
    const baseEnvironment = { PENKRA_DEV_REMOTE_DEBUGGING_PORT: "9555" };

    expect(
      resolveDevRemoteDebuggingPort({
        ...baseEnvironment,
        PENKRA_DEV_INSTANCE_NUMBER: "1",
      }),
    ).toBe("9555");
    expect(
      resolveDevRemoteDebuggingPort({
        ...baseEnvironment,
        PENKRA_DEV_INSTANCE_NUMBER: "2",
      }),
    ).toBe("9556");
    expect(
      resolveDevRemoteDebuggingPort({
        ...baseEnvironment,
        PENKRA_DEV_INSTANCE_NUMBER: "3",
      }),
    ).toBe("9557");
  });

  it("rejects malformed or out-of-range ports", () => {
    expect(() =>
      resolveDevRemoteDebuggingPort({
        PENKRA_DEV_REMOTE_DEBUGGING_PORT: "not-a-port",
      }),
    ).toThrow(/integer from 1 through 65535/u);
    expect(() =>
      resolveDevRemoteDebuggingPort({
        PENKRA_DEV_REMOTE_DEBUGGING_PORT: "65536",
      }),
    ).toThrow(/integer from 1 through 65535/u);
    expect(() =>
      resolveDevRemoteDebuggingPort({
        PENKRA_DEV_REMOTE_DEBUGGING_PORT: "65535",
        PENKRA_DEV_INSTANCE_NUMBER: "2",
      }),
    ).toThrow(/exceeds port 65535/u);
  });
});
