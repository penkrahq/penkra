import path from "node:path";

import { describe, expect, it } from "vitest";

import { deduplicateWorkspaceRoots } from "./workspaceWatcher";

describe("deduplicateWorkspaceRoots", () => {
  it("keeps one watcher for nested projects and preserves sibling roots", () => {
    const base = path.resolve("/tmp/workspaces");
    expect(
      deduplicateWorkspaceRoots([
        path.join(base, "repo", "packages", "web"),
        path.join(base, "repo"),
        path.join(base, "repo"),
        path.join(base, "sibling"),
      ]),
    ).toEqual([path.join(base, "repo"), path.join(base, "sibling")]);
  });

  it("does not confuse a shared string prefix with directory ancestry", () => {
    expect(deduplicateWorkspaceRoots(["/tmp/repo", "/tmp/repository"])).toEqual([
      path.resolve("/tmp/repo"),
      path.resolve("/tmp/repository"),
    ]);
  });
});
