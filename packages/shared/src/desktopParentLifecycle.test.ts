import { describe, expect, it } from "vitest";

import { bindDesktopParentPid, DESKTOP_PARENT_PID_ENV_KEY } from "./desktopParentLifecycle";

describe("bindDesktopParentPid", () => {
  it("binds a backend environment to its exact Electron parent without mutating the input", () => {
    const inherited = { KEEP_ME: "yes" };

    expect(bindDesktopParentPid(inherited, 4321)).toEqual({
      KEEP_ME: "yes",
      [DESKTOP_PARENT_PID_ENV_KEY]: "4321",
    });
    expect(inherited).toEqual({ KEEP_ME: "yes" });
  });

  it("rejects invalid parent identities", () => {
    expect(() => bindDesktopParentPid({}, 0)).toThrow("Invalid desktop parent pid");
  });
});
