import { describe, expect, it } from "vitest";

import { getRightDockPaneMeta } from "./rightDockPaneMeta";

describe("getRightDockPaneMeta", () => {
  it("labels App panes", () => {
    expect(getRightDockPaneMeta("app").label).toBe("App");
  });
});
