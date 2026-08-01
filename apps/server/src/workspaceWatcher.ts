// FILE: workspaceWatcher.ts
// Purpose: Watch active project roots once and publish coalesced cache invalidations.
// Layer: Server infrastructure

import path from "node:path";
import { watch, type FSWatcher } from "node:fs";

import type { ProjectWorkspaceChangeEvent } from "@penkra/contracts";
import { Effect, Fiber, Layer, PubSub, ServiceMap, Stream } from "effect";

import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";

const CHANGE_DEBOUNCE_MS = 150;

interface WorkspaceWatchSubscription {
  readonly close: () => void;
}

type CreateWorkspaceWatch = (
  watchRoot: string,
  onPathChange: (changedPath: string) => void,
  onLostSync: () => void,
) => WorkspaceWatchSubscription;

type PendingChange = ProjectWorkspaceChangeEvent & { timer: ReturnType<typeof setTimeout> };

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
  private pending = new Map<string, PendingChange>();
  private reconcileRunning: Promise<void> | null = null;
  private closeRunning: Promise<void> | null = null;
  private reconcileAgain = false;
  private closed = false;

  constructor(
    private readonly readProjectRoots: () => Promise<string[]>,
    private readonly publish: (event: ProjectWorkspaceChangeEvent) => void,
    private readonly createWorkspaceWatch: CreateWorkspaceWatch = createNodeWorkspaceWatch,
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
    this.projectRoots = [
      ...new Set((await this.readProjectRoots()).map((root) => path.resolve(root))),
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
          (changedPath) => this.queuePathChange(watchRoot, changedPath),
          () => this.queueLostSync(watchRoot),
        );
        if (this.closed) {
          subscription.close();
          return;
        }
        this.subscriptions.set(watchRoot, subscription);
      } catch {
        this.queueLostSync(watchRoot);
      }
    }
  }

  private rootsForWatch(watchRoot: string): string[] {
    return this.projectRoots.filter((root) => isWithin(watchRoot, root));
  }

  private queuePathChange(watchRoot: string, changedPath: string): void {
    const matchingRoots = this.rootsForWatch(watchRoot).filter((root) =>
      isWithin(root, changedPath),
    );
    const projectRoot = matchingRoots.toSorted((left, right) => right.length - left.length)[0];
    if (!projectRoot) return;
    const gitChanged = isGitMetadataPath(projectRoot, changedPath);
    this.queue({
      cwd: projectRoot,
      filesChanged: !gitChanged,
      gitChanged,
      lostSync: false,
    });
  }

  private queueLostSync(watchRoot: string): void {
    for (const projectRoot of this.rootsForWatch(watchRoot)) {
      this.queue({ cwd: projectRoot, filesChanged: true, gitChanged: true, lostSync: true });
    }
  }

  private queue(event: ProjectWorkspaceChangeEvent): void {
    if (this.closed) return;
    const existing = this.pending.get(event.cwd);
    if (existing) clearTimeout(existing.timer);
    const combined = {
      cwd: event.cwd,
      filesChanged: event.filesChanged || existing?.filesChanged === true,
      gitChanged: event.gitChanged || existing?.gitChanged === true,
      lostSync: event.lostSync || existing?.lostSync === true,
    };
    const timer = setTimeout(() => {
      this.pending.delete(event.cwd);
      this.publish(combined);
    }, CHANGE_DEBOUNCE_MS);
    this.pending.set(event.cwd, { ...combined, timer });
  }

  async close(): Promise<void> {
    if (this.closeRunning) return this.closeRunning;
    this.closed = true;
    this.closeRunning = (async () => {
      for (const change of this.pending.values()) clearTimeout(change.timer);
      this.pending.clear();
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
    const engine = yield* OrchestrationEngineService;
    const changes = yield* Effect.acquireRelease(
      PubSub.sliding<ProjectWorkspaceChangeEvent>(256),
      PubSub.shutdown,
    );
    const manager = new WorkspaceWatcherManager(
      () =>
        Effect.runPromise(
          engine
            .getReadModel()
            .pipe(
              Effect.map((model) =>
                model.projects
                  .filter((project) => project.deletedAt === null)
                  .map((project) => project.workspaceRoot),
              ),
            ),
        ),
      (event) => void Effect.runFork(PubSub.publish(changes, event)),
    );

    yield* Effect.acquireRelease(
      Effect.promise(() => manager.start()),
      () => Effect.promise(() => manager.close()),
    );
    const domainEventsFiber = yield* engine.streamDomainEvents.pipe(
      Stream.filter((event) => event.type.startsWith("project.")),
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
        Fiber.interrupt(domainEventsFiber).pipe(
          Effect.andThen(Effect.promise(() => manager.close())),
        ),
      ),
    );

    return { stream: Stream.fromPubSub(changes), close } satisfies WorkspaceWatcherShape;
  }),
);
