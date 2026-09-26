import { FolderId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import {
  resolveSingleFolderId,
  resolveThreadPickerTitle,
  resolveThreadWorkingDirectory,
} from "./-chatThreadRoute.logic";

describe("Thread route logic", () => {
  it("resolves the Thread's effective working directory", () => {
    expect(
      resolveThreadWorkingDirectory({
        projectCwd: "/project",
        threadWorkingDirectory: "/worktree",
      }),
    ).toBe("/worktree");
    expect(
      resolveThreadWorkingDirectory({
        projectCwd: "/project",
        threadWorkingDirectory: "/chosen",
      }),
    ).toBe("/chosen");
  });

  it("uses draft project identity only when the server Thread has none", () => {
    const server = FolderId.makeUnsafe("server-project");
    const draft = FolderId.makeUnsafe("draft-project");
    expect(resolveSingleFolderId({ threadFolderId: server, draftFolderId: draft })).toBe(server);
    expect(resolveSingleFolderId({ threadFolderId: null, draftFolderId: draft })).toBe(draft);
  });

  it("normalizes empty Thread picker titles", () => {
    expect(resolveThreadPickerTitle(null)).toBe("New chat");
    expect(resolveThreadPickerTitle("Design review")).toBe("Design review");
  });
});
