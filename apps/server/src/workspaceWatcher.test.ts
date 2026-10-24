import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { ThreadId, type ProjectWorkspaceChangeEvent } from "@penkra/contracts";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { makeInvalidationHub } from "./cleanCore/invalidationHub";

import {
  ensureDurableThreadWorkspace,
  DURABLE_THREAD_WORKSPACES_DIRNAME,
} from "./scratchWorkspaces";

import {
  deduplicateWorkspaceRoots,
  shouldIgnoreWorkspaceWatchPath,
  WorkspaceWatcherManager,
} from "./workspaceWatcher";

describe("deduplicateWorkspaceRoots", () => {
  it("keeps one watcher for nested folders and preserves sibling roots", () => {
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
  it("keeps one dirty-root invalidation per blocked subscriber, without a dropping buffer", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const hub = makeInvalidationHub<ProjectWorkspaceChangeEvent>((event) => event.cwd);
          const listening = yield* Deferred.make<void>();
          const drain = yield* Deferred.make<void>();
          const reader = yield* hub.stream(undefined, { cwd: "ready" }).pipe(
            Stream.tap((event) =>
              event.cwd === "ready"
                ? Deferred.succeed(listening, undefined).pipe(Effect.andThen(Deferred.await(drain)))
                : Effect.void,
            ),
            Stream.take(3),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* Deferred.await(listening);
          for (let i = 0; i < 10000; i++) {
            hub.publish({ cwd: "root-a" });
            hub.publish({ cwd: "root-b" });
          }
          yield* Deferred.succeed(drain, undefined);
          expect(yield* Fiber.join(reader)).toEqual([
            { cwd: "ready" },
            { cwd: "root-a" },
            { cwd: "root-b" },
          ]);
          yield* hub.close;
        }),
      ),
    );
  });
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

  it("ignores folders without a filesystem workspace root", async () => {
    const watched: string[] = [];
    const manager = new WorkspaceWatcherManager(
      async () => [null, "/tmp/workspace"],
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

  it("publishes file, git and lost-sync events as they arrive and ignores them after close", async () => {
    const root = path.resolve("/tmp/workspace-events");
    const events: ProjectWorkspaceChangeEvent[] = [];
    let callbacks!: { change: (path: string) => void; lostSync: () => void };
    const manager = new WorkspaceWatcherManager(
      async () => [root],
      (event) => events.push(event),
      (_watchRoot, change, lostSync) => {
        callbacks = { change, lostSync };
        return { close: () => undefined };
      },
    );
    await manager.start();
    callbacks.change(path.join(root, "src/index.ts"));
    expect(events).toEqual([{ cwd: root }]);
    callbacks.change(path.join(root, ".git/HEAD"));
    expect(events[1]).toEqual({
      cwd: root,
    });
    callbacks.lostSync();
    expect(events[2]).toEqual({ cwd: root });
    await manager.close();
    callbacks.change(path.join(root, "src/later.ts"));
    callbacks.lostSync();
    expect(events).toHaveLength(3);
  });

  it("publishes a real scratch-file edit with its thread cwd", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "penkra-scratch-watch-"));
    const cwd = ensureDurableThreadWorkspace(ThreadId.make("scratch-thread"), stateDir);
    const file = path.join(cwd, "note.txt");
    await writeFile(file, "before");
    let resolveEvent!: (event: ProjectWorkspaceChangeEvent) => void;
    const published = new Promise<ProjectWorkspaceChangeEvent>((resolve) => {
      resolveEvent = resolve;
    });
    const manager = new WorkspaceWatcherManager(
      async () => [],
      (event) => {
        if (event.cwd === cwd) resolveEvent(event);
      },
      undefined,
      path.join(stateDir, DURABLE_THREAD_WORKSPACES_DIRNAME),
    );
    try {
      await manager.start();
      await writeFile(file, "after");
      expect(await published).toEqual({
        cwd,
      });
    } finally {
      await manager.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("publishes recursive file changes and closes the built-in watcher", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "penkra-workspace-watcher-"));
    let resolveEvent!: (event: { cwd: string }) => void;
    const published = new Promise<{ cwd: string }>((resolve) => {
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
      const event = await published;
      expect(event).toMatchObject({ cwd: root });
      await manager.close();
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
