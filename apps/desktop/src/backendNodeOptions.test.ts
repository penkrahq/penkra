import { describe, expect, it } from "vitest";

import { DISABLE_SIGNAL_INSPECTOR_ARG, packagedNodeArgs } from "./backendNodeOptions";

describe("packaged Node processes", () => {
  it("ignore SIGUSR1 in a packaged app, so no debugger can attach", () => {
    expect(packagedNodeArgs(true)).toEqual([DISABLE_SIGNAL_INSPECTOR_ARG]);
    expect(DISABLE_SIGNAL_INSPECTOR_ARG).toBe("--disable-sigusr1");
  });

  it("keep SIGUSR1 in development, where debugging is wanted", () => {
    expect(packagedNodeArgs(false)).toEqual([]);
  });
});
