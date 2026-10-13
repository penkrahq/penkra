import * as SqlClient from "effect/unstable/sql/SqlClient";
// FILE: workspaceWatcher.ts
// Purpose: Watch folder roots and durable thread scratch folders; publish cwd-scoped filesystem changes.
// Layer: Server infrastructure

import path from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";

import type { ProjectWorkspaceChangeEvent } from "@penkra/contracts";
import { Effect, Fiber, Layer, PubSub, Queue, ServiceMap, Stream } from "effect";

import { ServerConfig } from "./config";
import { DURABLE_THREAD_WORKSPACES_DIRNAME } from "./scratchWorkspaces";

import { getNavigation } from "./cleanCore/navigation";
import { ThreadPublisher } from "./cleanCore/ThreadPublisher";

interface WorkspaceWatchSubscription {
  readonly close: () => void;
}

type CreateWorkspaceWatch = (
  watchRoot: string,
  onPathChange: (changedPath: string) => void,
  onLostSync: () => void,
) => WorkspaceWatchSubscription;

export interface WorkspaceWatcherShape {
  readonly stream: Stream.Stream<ProjectWorkspaceChangeEvent>;
  readonly close: Effect.Effect<void>;
}

export class WorkspaceWatcher extends ServiceMap.Service<WorkspaceWatcher, WorkspaceWatcherShape>()(
  "penkra/workspaceWatcher",
) {}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function deduplicateWorkspaceRoots(roots: readonly string[]): string[] {
  const normalized = [...new Set(roots.map((root) => path.resolve(root)))].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
  return normalized.filter(
    (candidate, index) =>
      !normalized.slice(0, index).some((ancestor) => isWithin(ancestor, candidate)),
  );
}

function isGitMetadataPath(projectRoot: string, changedPath: string): boolean {
  const relative = path.relative(projectRoot, changedPath);
  return relative === ".git" || relative.startsWith(`.git${path.sep}`);
}

export function shouldIgnoreWorkspaceWatchPath(watchRoot: string, changedPath: string): boolean {
  const relative = path.relative(watchRoot, changedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return true;
  const segments = relative.split(path.sep);
  if (
    segments.includes("node_modules") ||
    segments.includes("dist") ||
    segments.includes(".turbo")
  ) {
    return true;
  }
  if (segments[0] === ".git" && (segments[1] === "objects" || segments[1] === "subtree-cache")) {
    return true;
  }
  return path.basename(relative).endsWith(".tmp");
}

function createNodeWorkspaceWatch(
  watchRoot: string,
  onPathChange: (changedPath: string) => void,
  onLostSync: () => void,
): FSWatcher {
  const subscription = watch(watchRoot, { recursive: true }, (_eventType, filename) => {
    if (filename === null) {
      onLostSync();
      return;
    }
    const changedPath = path.resolve(watchRoot, filename.toString());
    if (!shouldIgnoreWorkspaceWatchPath(watchRoot, changedPath)) onPathChange(changedPath);
  });
  subscription.on("error", onLostSync);
  return subscription;
}

export class WorkspaceWatcherManager {
  private projectRoots: string[] = [];
  private subscriptions = new Map<string, WorkspaceWatchSubscription>();
  private reconcileRunning: Promise<void> | null = null;
  private closeRunning: Promise<void> | null = null;
  private reconcileAgain = false;
  private closed = false;

  constructor(
    private readonly readProjectRoots: () => Promise<readonly (string | null)[]>,
    private readonly publish: (event: ProjectWorkspaceChangeEvent) => void,
    private readonly createWorkspaceWatch: CreateWorkspaceWatch = createNodeWorkspaceWatch,
    private readonly scratchRoot: string | null = null,
  ) {}

  start(): Promise<void> {
    return this.reconcile();
  }

  reconcile(): Promise<void> {
    if (this.reconcileRunning) {
      this.reconcileAgain = true;
      return this.reconcileRunning;
    }
    this.reconcileRunning = (async () => {
      do {
        this.reconcileAgain = false;
        await this.reconcileOnce();
      } while (this.reconcileAgain && !this.closed);
    })().finally(() => {
      this.reconcileRunning = null;
    });
    return this.reconcileRunning;
  }

  private async reconcileOnce(): Promise<void> {
    if (this.closed) return;
    const roots = await this.readProjectRoots();
    this.projectRoots = [
      ...new Set(
        [...roots, this.scratchRoot]
          .filter((root): root is string => root !== null)
          .map((root) => path.resolve(root)),
      ),
    ];
    const desiredWatchRoots = new Set(deduplicateWorkspaceRoots(this.projectRoots));

    for (const [watchRoot, subscription] of this.subscriptions) {
      if (desiredWatchRoots.has(watchRoot)) continue;
      subscription.close();
      this.subscriptions.delete(watchRoot);
    }

    for (const watchRoot of desiredWatchRoots) {
      if (this.subscriptions.has(watchRoot)) continue;
      try {
        const subscription = this.createWorkspaceWatch(
          watchRoot,
          (changedPath) => this.publishPathChange(watchRoot, changedPath),
          () => this.publishLostSync(watchRoot),
        );
        if (this.closed) {
          subscription.close();
          return;
        }
        this.subscriptions.set(watchRoot, subscription);
      } catch {
        this.publishLostSync(watchRoot);
      }
    }
  }

  private rootsForWatch(watchRoot: string): string[] {
    return this.projectRoots.filter((root) => isWithin(watchRoot, root));
  }

  private publishPathChange(watchRoot: string, changedPath: string): void {
    const scratchRelative =
      this.scratchRoot !== null && isWithin(this.scratchRoot, changedPath)
        ? path.relative(this.scratchRoot, changedPath).split(path.sep)
        : [];
    // One recursive parent watch also sees scratch folders created after startup.
    // Attribute their files to the per-thread cwd used by the query keys.
    const scratchCwd =
      this.scratchRoot !== null && scratchRelative.length > 1
        ? path.join(this.scratchRoot, scratchRelative[0]!)
        : null;
    const matchingRoots = [
      ...this.rootsForWatch(watchRoot),
      ...(scratchCwd === null ? [] : [scratchCwd]),
    ].filter((root) => isWithin(root, changedPath));
    const projectRoot = matchingRoots.toSorted((left, right) => right.length - left.length)[0];
    if (!projectRoot) return;
    const gitChanged = isGitMetadataPath(projectRoot, changedPath);
    this.publishChange({
      cwd: projectRoot,
      filesChanged: !gitChanged,
      gitChanged,
      lostSync: false,
    });
  }

  private publishLostSync(watchRoot: string): void {
    for (const projectRoot of this.rootsForWatch(watchRoot)) {
      this.publishChange({
        cwd: projectRoot,
        filesChanged: true,
        gitChanged: true,
        lostSync: true,
      });
    }
  }

  private publishChange(event: ProjectWorkspaceChangeEvent): void {
    if (this.closed) return;
    this.publish(event);
  }

  async close(): Promise<void> {
    if (this.closeRunning) return this.closeRunning;
    this.closed = true;
    this.closeRunning = (async () => {
      // Reconciliation may already be reading the project roots. Wait for it to
      // observe `closed` and close any late watcher before declaring the file
      // watcher fully drained.
      await this.reconcileRunning;
      for (const subscription of this.subscriptions.values()) subscription.close();
      this.subscriptions.clear();
    })();
    return this.closeRunning;
  }
}

export const WorkspaceWatcherLive = Layer.effect(
  WorkspaceWatcher,
  Effect.gen(function* () {
    const publisher = yield* ThreadPublisher;
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ServerConfig;
    const scratchRoot = path.join(config.stateDir, DURABLE_THREAD_WORKSPACES_DIRNAME);
    yield* Effect.promise(() => mkdir(scratchRoot, { recursive: true, mode: 0o700 }));
    const changes = yield* Effect.acquireRelease(
      PubSub.sliding<ProjectWorkspaceChangeEvent>(256),
      PubSub.shutdown,
    );
    const manager = new WorkspaceWatcherManager(
      () =>
        Effect.runPromise(
          getNavigation.pipe(
            Effect.map((navigation) => navigation.folders.map((folder) => folder.workspaceRoot)),
            Effect.provideService(SqlClient.SqlClient, sql),
          ),
        ),
      (event) => void Effect.runFork(PubSub.publish(changes, event)),
      createNodeWorkspaceWatch,
      scratchRoot,
    );

    yield* Effect.acquireRelease(
      Effect.promise(() => manager.start()),
      () => Effect.promise(() => manager.close()),
    );
    const navigationFiber = yield* Stream.fromPubSub(publisher.sidebarChanges).pipe(
      Stream.filter((change) => change.kind === "navigation"),
      Stream.runForEach(() =>
        Effect.promise(() => manager.reconcile()).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("failed to reconcile workspace file watchers", { cause }),
          ),
        ),
      ),
      Effect.forkScoped,
    );

    const close = yield* Effect.cached(
      Effect.uninterruptible(
        Fiber.interrupt(navigationFiber).pipe(
          Effect.andThen(Effect.promise(() => manager.close())),
        ),
      ),
    );

    return { stream: Stream.fromPubSub(changes), close } satisfies WorkspaceWatcherShape;
  }),
);
