/**
 * DevServerManager - Server-owned dev-server process orchestration.
 *
 * Dev servers are first-class background processes keyed by project id, fully
 * decoupled from chat threads. Each runs in a managed PTY (via TerminalManager)
 * under a synthetic `dev-server:<folderId>` thread so its lifetime survives
 * WebSocket reconnects and never clutters the thread list. The manager keeps an
 * in-memory registry, broadcasts changes over a PubSub for the
 * `project.devServerEvent` push channel, and reaps entries when their PTY exits.
 *
 * @module DevServerManager
 */
import {
  DEFAULT_TERMINAL_ID,
  FolderId,
  type ProjectDevServer,
  type ProjectDevServerEvent,
  type ProjectListDevServersResult,
  type ProjectRunDevServerInput,
  type ProjectRunDevServerResult,
  type ProjectStopDevServerInput,
  type ProjectStopDevServerResult,
  type ServerLocalServerProcess,
} from "@penkra/contracts";
import { localServerMatchesRun } from "@penkra/shared/localServers";
import { Effect, Layer, PubSub, Ref, ServiceMap, Stream } from "effect";

import { TerminalManager, type TerminalError } from "./terminal/Services/Manager";

// Dev servers reuse the terminal infrastructure under a reserved synthetic
// thread namespace so their PTYs never collide with real chat-thread terminals.
const DEV_SERVER_THREAD_PREFIX = "dev-server:";
const DEV_SERVER_TERMINAL_COLS = 120;
const DEV_SERVER_TERMINAL_ROWS = 30;

const devServerThreadId = (folderId: FolderId): string => `${DEV_SERVER_THREAD_PREFIX}${folderId}`;

const parseDevServerFolderId = (threadId: string): FolderId | null => {
  if (!threadId.startsWith(DEV_SERVER_THREAD_PREFIX)) {
    return null;
  }
  const raw = threadId.slice(DEV_SERVER_THREAD_PREFIX.length);
  return raw.length > 0 ? FolderId.makeUnsafe(raw) : null;
};

export function findProjectDevServerForLocalServer(input: {
  localServer: ServerLocalServerProcess;
  devServers: readonly ProjectDevServer[];
}): ProjectDevServer | null {
  for (const devServer of input.devServers) {
    if (localServerMatchesRun(input.localServer, devServer)) {
      return devServer;
    }
  }
  return null;
}

export interface DevServerManagerShape {
  /** Start (or restart) the dev server for a project and return its descriptor. */
  readonly run: (
    input: ProjectRunDevServerInput,
  ) => Effect.Effect<ProjectRunDevServerResult, TerminalError>;
  /** Stop the dev server for a project. Resolves with whether one was running. */
  readonly stop: (input: ProjectStopDevServerInput) => Effect.Effect<ProjectStopDevServerResult>;
  /** Snapshot of all currently tracked dev servers. */
  readonly list: Effect.Effect<ProjectListDevServersResult>;
  /** Live stream of dev-server lifecycle events (excludes the initial snapshot). */
  readonly stream: Stream.Stream<ProjectDevServerEvent>;
}

export class DevServerManager extends ServiceMap.Service<DevServerManager, DevServerManagerShape>()(
  "penkra/devServerManager",
) {}

export const DevServerManagerLive = Layer.effect(
  DevServerManager,
  Effect.gen(function* () {
    const terminalManager = yield* TerminalManager;
    const pubsub = yield* Effect.acquireRelease(
      PubSub.unbounded<ProjectDevServerEvent>(),
      PubSub.shutdown,
    );
    const registry = yield* Ref.make<Record<FolderId, ProjectDevServer>>({});

    const publish = (event: ProjectDevServerEvent) => PubSub.publish(pubsub, event);

    // Reap a tracked dev server whose PTY exited or errored. Guarded so that a
    // deliberate stop (which removes the entry first) cannot double-publish, and
    // so a stale exit for an already-replaced project is ignored.
    const reapExited = (folderId: FolderId) =>
      Ref.modify(registry, (current) => {
        if (!current[folderId]) {
          return [false, current] as const;
        }
        const next = { ...current };
        delete next[folderId];
        return [true, next] as const;
      }).pipe(
        Effect.flatMap((removed) =>
          removed ? publish({ type: "removed", folderId, reason: "exited" }) : Effect.void,
        ),
      );

    const unsubscribe = yield* terminalManager.subscribe((event) => {
      if (event.type !== "exited" && event.type !== "error") {
        return;
      }
      const folderId = parseDevServerFolderId(event.threadId);
      if (!folderId) {
        return;
      }
      Effect.runFork(reapExited(folderId));
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

    const run: DevServerManagerShape["run"] = (input) =>
      Effect.gen(function* () {
        const threadId = devServerThreadId(input.folderId);

        // If a dev server is already tracked for this project, tear its PTY down
        // first so the command always lands in a fresh shell. A deliberate close
        // emits no exit event, so the reaper stays quiet during the swap.
        const existing = (yield* Ref.get(registry))[input.folderId];
        if (existing) {
          yield* terminalManager
            .close({ threadId, deleteHistory: true })
            .pipe(Effect.catch(() => Effect.void));
        }

        const snapshot = yield* terminalManager.open({
          threadId,
          terminalId: DEFAULT_TERMINAL_ID,
          cwd: input.cwd,
          cols: DEV_SERVER_TERMINAL_COLS,
          rows: DEV_SERVER_TERMINAL_ROWS,
          // Dev servers are headless: drain + retain history, but never broadcast
          // their continuous output to clients that have no terminal UI for them.
          streamOutput: false,
          ...(input.env ? { env: input.env } : {}),
        });

        yield* terminalManager.write({
          threadId,
          terminalId: DEFAULT_TERMINAL_ID,
          data: `${input.command}\r`,
        });

        const server: ProjectDevServer = {
          folderId: input.folderId,
          command: input.command,
          cwd: input.cwd,
          pid: snapshot.pid,
          startedAt: new Date().toISOString(),
          status: "running",
        };
        yield* Ref.update(registry, (current) => ({ ...current, [input.folderId]: server }));
        yield* publish({ type: "upserted", server });
        return { server };
      });

    const stop: DevServerManagerShape["stop"] = (input) =>
      Effect.gen(function* () {
        // Remove from the registry *before* closing so the PTY teardown cannot be
        // mistaken for a crash by the reaper.
        const removed = yield* Ref.modify(registry, (current) => {
          if (!current[input.folderId]) {
            return [false, current] as const;
          }
          const next = { ...current };
          delete next[input.folderId];
          return [true, next] as const;
        });
        if (!removed) {
          return { stopped: false };
        }
        yield* publish({ type: "removed", folderId: input.folderId, reason: "stopped" });
        yield* terminalManager
          .close({ threadId: devServerThreadId(input.folderId), deleteHistory: true })
          .pipe(Effect.catch(() => Effect.void));
        return { stopped: true };
      });

    const list: DevServerManagerShape["list"] = Ref.get(registry).pipe(
      Effect.map((current) => ({ servers: Object.values(current) })),
    );

    return {
      run,
      stop,
      list,
      get stream() {
        return Stream.fromPubSub(pubsub);
      },
    } satisfies DevServerManagerShape;
  }),
);
