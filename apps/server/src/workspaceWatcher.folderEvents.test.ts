import { EventEmitter } from "node:events";
import { Effect, Exit, Layer, Queue, Scope, Stream } from "effect";
import {
  FolderId,
  SpaceId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@penkra/contracts";
import { expect, it, vi } from "vitest";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine";
import { WorkspaceWatcherLive } from "./workspaceWatcher";

const watch = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  watch,
}));

it("watches newly created folders, moves a changed root, and retains an unchanged watch through the live event consumer", async () => {
  const events = await Effect.runPromise(Queue.unbounded<OrchestrationEvent>());
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let roots: string[] = [];
  let readComplete: (() => void) | undefined;
  let watchComplete: (() => void) | undefined;
  const closers: ReturnType<typeof vi.fn>[] = [];
  watch.mockImplementation(() => {
    const subscription = new EventEmitter();
    const close = vi.fn();
    Object.assign(subscription, { close });
    closers.push(close);
    watchComplete?.();
    return subscription;
  });
  const engine = {
    getCommandReadModel: () =>
      Effect.sync(() => {
        readComplete?.();
        const at = "2026-10-11T00:00:00.000Z";
        const spaceId = SpaceId.makeUnsafe("watch-space");
        return {
          snapshotSequence: 0,
          spaces: [
            {
              id: spaceId,
              name: "Watch space",
              icon: "bag",
              sortOrder: 0,
              createdAt: at,
              updatedAt: at,
              archivedAt: null,
              deletedAt: null,
            },
          ],
          folders: roots.map((workspaceRoot) => ({
            id: FolderId.makeUnsafe("watch-folder"),
            title: "Watch folder",
            workspaceRoot,
            defaultModelSelection: null,
            scripts: [],
            spaceId,
            sidebarSortOrder: 0,
            createdAt: at,
            updatedAt: at,
            archivedAt: null,
            deletedAt: null,
          })),
          threads: [],
          updatedAt: at,
        } satisfies OrchestrationReadModel;
      }),
    streamDomainEvents: Stream.fromQueue(events),
  } as unknown as OrchestrationEngineShape;
  try {
    await Effect.runPromise(
      Layer.buildWithScope(
        WorkspaceWatcherLive.pipe(Layer.provide(Layer.succeed(OrchestrationEngineService, engine))),
        scope,
      ),
    );
    expect(watch).not.toHaveBeenCalled();
    const publish = (type: OrchestrationEvent["type"]) =>
      Effect.runPromise(Queue.offer(events, { type } as OrchestrationEvent));
    const nextWatch = () =>
      new Promise<void>((resolve) => {
        watchComplete = resolve;
      });
    roots = ["/new-folder"];
    const created = nextWatch();
    await publish("folder.created");
    await created;
    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch.mock.calls[0]?.[0]).toBe("/new-folder");

    roots = ["/changed-folder"];
    const changed = nextWatch();
    await publish("folder.updated");
    await changed;
    expect(closers[0]).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenCalledTimes(2);
    expect(watch.mock.calls[1]?.[0]).toBe("/changed-folder");

    // Sequential stream processing gives a completion barrier: the next read
    // cannot begin until the preceding unchanged update finished reconciliation.
    let reads = 0;
    const unchanged = new Promise<void>((resolve) => {
      readComplete = () => {
        if (++reads === 2) resolve();
      };
    });
    await publish("folder.updated");
    await publish("folder.updated");
    await unchanged;
    expect(watch).toHaveBeenCalledTimes(2);
    expect(closers[1]).not.toHaveBeenCalled();
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await Effect.runPromise(Queue.shutdown(events));
  }
  expect(closers[1]).toHaveBeenCalledTimes(1);
});
