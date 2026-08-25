import { describe, expect, it } from "vitest";

import { inspectDesktopAppControllerBundle } from "./verify-desktop-app-controller-bundle.ts";

describe("desktop App controller bundle verification", () => {
  it("accepts one self-contained Node controller", () => {
    expect(inspectDesktopAppControllerBundle('const url = require("node:url");\n')).toEqual([]);
  });

  it("rejects Electron and sibling build chunks", () => {
    expect(
      inspectDesktopAppControllerBundle(
        [
          'const electron = require("electron");',
          'require("./shared-controller.js");',
          'export { runtime } from "./runtime.js";',
        ].join("\n"),
      ),
    ).toEqual([
      "imports the Electron runtime",
      "depends on a sibling CommonJS chunk",
      "depends on a sibling ES module chunk",
    ]);
  });
});
