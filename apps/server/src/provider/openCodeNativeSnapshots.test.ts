import type { Part } from "@opencode-ai/sdk/v2";
import { describe, expect, it } from "vitest";
import { preserveOpenCodeNativeSnapshots } from "./openCodeNativeSnapshots.ts";

const base = {
  projectID: "project",
  worktree: process.cwd(),
  sourceDataRoot: process.cwd(),
  targetDataRoot: process.cwd(),
  env: {},
  signal: new AbortController().signal,
};

describe("OpenCode snapshot admission", () => {
  it("does no Git work for a conversation without snapshots", async () => {
    await expect(preserveOpenCodeNativeSnapshots({ ...base, parts: [] })).resolves.toBeUndefined();
  });

  it("rejects invalid native hashes and escaping project identities before invoking Git", async () => {
    const parts = [{ type: "snapshot", snapshot: "not-a-tree-hash" }] as Part[];
    await expect(preserveOpenCodeNativeSnapshots({ ...base, parts })).rejects.toThrow(
      "tree identity",
    );
    await expect(
      preserveOpenCodeNativeSnapshots({ ...base, parts, projectID: "../escape" }),
    ).rejects.toThrow("project identity");
  });

  it("rejects a source/destination collision including a revert-only snapshot", async () => {
    await expect(
      preserveOpenCodeNativeSnapshots({ ...base, parts: [], revertSnapshot: "a".repeat(40) }),
    ).rejects.toThrow("identical");
  });
});
