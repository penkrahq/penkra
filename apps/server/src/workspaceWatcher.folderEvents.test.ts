import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FolderId, SpaceId } from "@penkra/contracts";
import { Effect, Exit, Layer, Scope, ServiceMap } from "effect";
import { expect, it, vi } from "vitest";
import { ServerConfig } from "./config";
import { ThreadPublisher } from "./cleanCore/ThreadPublisher";
import { makeThreadPublisher } from "./cleanCore/threadStore";
import * as NodeSqliteClient from "./persistence/NodeSqliteClient";
import { DURABLE_THREAD_WORKSPACES_DIRNAME } from "./scratchWorkspaces";
import { WorkspaceWatcherLive } from "./workspaceWatcher";
const observed = vi.hoisted(() => ({
  roots: [] as string[],
  readComplete: undefined as (() => void) | undefined,
  watch: vi.fn(),
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  watch: observed.watch,
}));
vi.mock("./cleanCore/navigation", async (original) => {
  const { Effect } = await import("effect");
  return {
    ...(await original<typeof import("./cleanCore/navigation")>()),
    getNavigation: Effect.sync(() => {
      observed.readComplete?.();
      return {
        spaces: [],
        folders: observed.roots.map((workspaceRoot) => ({
          id: FolderId.makeUnsafe("watched"),
          spaceId: SpaceId.makeUnsafe("space"),
          title: "Watched",
          workspaceRoot,
          defaultModelSelection: null,
          sidebarSortOrder: 0,
          createdAt: "2026-10-12T00:00:00.000Z",
          updatedAt: "2026-10-12T00:00:00.000Z",
          archivedAt: null,
        })),
      };
    }),
  };
});
it("watches newly created folders, moves a changed root, and retains an unchanged watch through the bare change consumer", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "penkra-folder-watch-"));
  const scope = await Effect.runPromise(Scope.make("sequential"));
  const publisher = makeThreadPublisher();
  let watchComplete: (() => void) | undefined;
  const closers: ReturnType<typeof vi.fn>[] = [];
  observed.roots = [];
  observed.readComplete = undefined;
  observed.watch.mockReset();
  observed.watch.mockImplementation(() => {
    const subscription = new EventEmitter();
    const close = vi.fn();
    Object.assign(subscription, { close });
    closers.push(close);
    watchComplete?.();
    return subscription;
  });
  try {
    const context = await Effect.runPromise(
      Layer.buildWithScope(
        WorkspaceWatcherLive.pipe(
          Layer.provideMerge(Layer.succeed(ThreadPublisher, publisher)),
          Layer.provideMerge(NodeSqliteClient.layerMemory()),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), stateDir).pipe(Layer.provide(NodeServices.layer)),
          ),
        ),
        scope,
      ),
    );
    const scratchRoot = path.join(
      ServiceMap.get(context, ServerConfig).stateDir,
      DURABLE_THREAD_WORKSPACES_DIRNAME,
    );
    expect(observed.watch).toHaveBeenCalledOnce();
    expect(observed.watch.mock.calls[0]?.[0]).toBe(scratchRoot);
    const nextWatch = () =>
      new Promise<void>((resolve) => {
        watchComplete = resolve;
      });
    observed.roots = ["/new-folder"];
    const created = nextWatch();
    publisher.publishSidebar({ kind: "navigation" });
    await created;
    expect(observed.watch).toHaveBeenCalledTimes(2);
    expect(observed.watch.mock.calls[1]?.[0]).toBe("/new-folder");
    observed.roots = ["/changed-folder"];
    const changed = nextWatch();
    publisher.publishSidebar({ kind: "navigation" });
    await changed;
    expect(closers[1]).toHaveBeenCalledTimes(1);
    expect(observed.watch).toHaveBeenCalledTimes(3);
    expect(observed.watch.mock.calls[2]?.[0]).toBe("/changed-folder");
    const unchanged = new Promise<void>((resolve) => {
      observed.readComplete = () => {
        resolve();
      };
    });
    publisher.publishSidebar({ kind: "navigation" });
    publisher.publishSidebar({ kind: "navigation" });
    await unchanged;
    expect(observed.watch).toHaveBeenCalledTimes(3);
    expect(closers[2]).not.toHaveBeenCalled();
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    observed.readComplete = undefined;
    await rm(stateDir, { recursive: true, force: true });
  }
  expect(closers[0]).toHaveBeenCalledTimes(1);
  expect(closers[2]).toHaveBeenCalledTimes(1);
});
