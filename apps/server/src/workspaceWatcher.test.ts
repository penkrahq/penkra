import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  deduplicateWorkspaceRoots,
  shouldIgnoreWorkspaceWatchPath,
  WorkspaceWatcherManager,
} from "./workspaceWatcher";

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

describe("workspace watcher lifecycle", () => {
  it("filters high-churn implementation paths without hiding project metadata", () => {
    const root = path.resolve("/tmp/workspace");
    expect(shouldIgnoreWorkspaceWatchPath(root, path.join(root, "node_modules/pkg/index.js"))).toBe(
      true,
    );
    expect(shouldIgnoreWorkspaceWatchPath(root, path.join(root, ".git/objects/ab/cd"))).toBe(true);
    expect(shouldIgnoreWorkspaceWatchPath(root, path.join(root, ".git/HEAD"))).toBe(false);
    expect(shouldIgnoreWorkspaceWatchPath(root, path.join(root, "src/index.ts"))).toBe(false);
  });

  it("closes a watcher created by an in-flight reconciliation before close resolves", async () => {
    let releaseRoots!: (roots: string[]) => void;
    const roots = new Promise<string[]>((resolve) => {
      releaseRoots = resolve;
    });
    let closeCount = 0;
    const manager = new WorkspaceWatcherManager(
      () => roots,
      () => undefined,
      () => ({
        close: () => {
          closeCount += 1;
        },
      }),
    );

    const starting = manager.start();
    const closing = manager.close();
    releaseRoots([path.resolve("/tmp/workspace")]);
    await Promise.all([starting, closing]);
    await manager.close();

    expect(closeCount).toBe(1);
  });

  it("ignores projects without a filesystem workspace root", async () => {
    const watched: string[] = [];
    const manager = new WorkspaceWatcherManager(
      async () => [null, undefined, "", "   ", "/tmp/workspace"],
      () => undefined,
      (watchRoot) => {
        watched.push(watchRoot);
        return { close: () => undefined };
      },
    );

    await manager.start();
    expect(watched).toEqual([path.resolve("/tmp/workspace")]);
    await manager.close();
  });

  it("publishes recursive file changes and closes the built-in watcher", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "penkra-workspace-watcher-"));
    let resolveEvent!: (event: { cwd: string; filesChanged: boolean }) => void;
    const published = new Promise<{ cwd: string; filesChanged: boolean }>((resolve) => {
      resolveEvent = resolve;
    });
    const manager = new WorkspaceWatcherManager(
      async () => [root],
      (event) => resolveEvent(event),
    );

    try {
      await manager.start();
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "src", "index.ts"), "export {};\n");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const event = await Promise.race([
        published,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("workspace watcher did not publish")), 5_000);
        }),
      ]).finally(() => clearTimeout(timeout));
      expect(event).toMatchObject({ cwd: root, filesChanged: true });
      await manager.close();
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
