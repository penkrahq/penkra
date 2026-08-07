import { describe, expect, it } from "vitest";

import { resolveDevElectronArgs } from "./electron-launch-args.mjs";

describe("resolveDevElectronArgs", () => {
  it("passes the application entrypoint before Penkra's ownership marker", () => {
    expect(resolveDevElectronArgs("/workspace/apps/desktop")).toEqual([
      "/workspace/apps/desktop",
      "--penkra-dev-root=/workspace/apps/desktop",
      "--penkra-dev-instance=1",
    ]);
  });
});
