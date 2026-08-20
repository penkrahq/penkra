import { describe, expect, it } from "vitest";

import { resolveThreadWorkspaceCwd } from "./threadEnvironment";

describe("resolveThreadWorkspaceCwd", () => {
  it("prefers the Thread working directory", () => {
    expect(
      resolveThreadWorkspaceCwd({
        projectCwd: "/project-root",
        workingDirectory: "/thread-folder",
      }),
    ).toBe("/thread-folder");
  });

  it("falls back to the project root", () => {
    expect(resolveThreadWorkspaceCwd({ projectCwd: "/project-root" })).toBe("/project-root");
    expect(resolveThreadWorkspaceCwd({})).toBeNull();
  });
});
