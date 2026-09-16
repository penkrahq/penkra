// FILE: scratchWorkspaces.test.ts
// Purpose: Verifies durable per-thread workspaces remain isolated and adopt
//          files from the legacy OS-temp location.
// Layer: Server filesystem utility tests

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ThreadId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import {
  DURABLE_THREAD_WORKSPACES_DIRNAME,
  ensureDurableThreadWorkspace,
} from "./scratchWorkspaces";

function temporaryRoot(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

describe("ensureDurableThreadWorkspace", () => {
  it("creates a private per-thread directory under the durable state root", () => {
    const stateDir = temporaryRoot("penkra-durable-workspace-");
    try {
      const workspace = ensureDurableThreadWorkspace(ThreadId.makeUnsafe("thread-1"), stateDir);
      const durableRoot = path.join(stateDir, DURABLE_THREAD_WORKSPACES_DIRNAME);
      expect(workspace).toContain(
        `${path.sep}${DURABLE_THREAD_WORKSPACES_DIRNAME}${path.sep}thread-1-`,
      );
      expect(path.relative(durableRoot, workspace).startsWith("..")).toBe(false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not let path-like thread ids escape the durable root", () => {
    const stateDir = temporaryRoot("penkra-durable-workspace-");
    try {
      const workspace = ensureDurableThreadWorkspace(
        ThreadId.makeUnsafe("../outside/thread"),
        stateDir,
      );
      const relative = path.relative(
        path.join(stateDir, DURABLE_THREAD_WORKSPACES_DIRNAME),
        workspace,
      );
      expect(relative.startsWith("..")).toBe(false);
      expect(path.isAbsolute(relative)).toBe(false);
      expect(workspace).not.toContain(`${path.sep}..${path.sep}`);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("adopts surviving files from the legacy temp workspace", () => {
    const stateDir = temporaryRoot("penkra-durable-workspace-");
    const legacyScratchRoot = temporaryRoot("penkra-legacy-workspace-");
    const threadId = ThreadId.makeUnsafe("thread-1");
    try {
      const firstWorkspace = ensureDurableThreadWorkspace(threadId, stateDir, {
        legacyScratchRoot,
      });
      rmSync(firstWorkspace, { recursive: true, force: true });
      const legacyWorkspace = path.join(legacyScratchRoot, path.basename(firstWorkspace));
      mkdirSync(legacyWorkspace, { recursive: true });
      writeFileSync(path.join(legacyWorkspace, "job-pipeline.csv"), "id,title\n1,Engineer\n");

      const adoptedWorkspace = ensureDurableThreadWorkspace(threadId, stateDir, {
        legacyScratchRoot,
      });

      expect(readFileSync(path.join(adoptedWorkspace, "job-pipeline.csv"), "utf8")).toBe(
        "id,title\n1,Engineer\n",
      );
      expect(existsSync(legacyWorkspace)).toBe(false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(legacyScratchRoot, { recursive: true, force: true });
    }
  });
});
