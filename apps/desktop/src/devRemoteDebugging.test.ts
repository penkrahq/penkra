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
  });
});
