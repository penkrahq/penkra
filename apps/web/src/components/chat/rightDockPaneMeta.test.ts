import { describe, expect, it } from "vitest";

import { getRightDockPaneMeta } from "./rightDockPaneMeta";

describe("getRightDockPaneMeta", () => {
  it("labels the explorer pane", () => {
    expect(getRightDockPaneMeta("explorer").label).toBe("Explorer");
  });
});
