import {
  ProviderConnectionId,
  ThreadId,
  type ProviderKind,
  type ProviderRuntimeEvent,
} from "@penkra/contracts";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";

import type {
  CapturedProcess,
  CapturedProcessTree,
  ProcessTreeKiller,
  TerminalKillSignal,
} from "../processTreeKiller";
import {
  ProviderProcessExitUnprovenError,
  teardownProviderProcessTree,
} from "./supervisedProcessTeardown";

import { makeThreadRuntime as makeRuntimeOwner } from "./ThreadRuntime.ts";
import { ProviderAdapterProcessError, type ProviderAdapterError } from "./Errors.ts";
import type { ProviderAdapterShape } from "./Services/ProviderAdapter.ts";

const thread = ThreadId.make("runtime-owner");
const peer = ThreadId.make("runtime-peer");
const makeThreadRuntime = (
  retireNativeContinuation: (
    threadId: ThreadId,
    provider: ProviderKind,
  ) => Effect.Effect<void, unknown> = () => Effect.void,
) => makeRuntimeOwner({ retireNativeContinuation });

describe("ThreadRuntime ownership", () => {
  it("preserves the existing Connection when a different Connection is disconnected during preparation", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = makeThreadRuntime();
        const original = ProviderConnectionId.make("original");
        const replacement = ProviderConnectionId.make("replacement");
        let active = false;
        let stops = 0;
        const adapter = {
          provider: "codex",
          hasSession: () => Effect.sync(() => active),
          startSession: () =>
            Effect.sync(() => {
              active = true;
              return {};
            }),
          stopSession: () =>
            Effect.sync(() => {
              active = false;
              stops++;
            }),
        } as unknown as ProviderAdapterShape<ProviderAdapterError>;
        const input = (connectionId: typeof original, assertion: Effect.Effect<void, unknown>) => ({
          threadId: thread,
          runtimeMode: "full-access" as const,
          managedLaunch: {
            connectionId,
            binaryPath: "/managed/codex",
            isolationKey: connectionId,
            profileRoot: `/profiles/${connectionId}`,
            nativeStateRoot: "/native/thread",
            childEnvironment: (env: NodeJS.ProcessEnv) => env,
            assertCurrentCredentials: assertion,
          },
        });
        yield* runtime.ensure(thread, "codex", (lease) =>
          runtime.startNative(adapter, {
            ...input(original, Effect.void),
            lifecycleGeneration: lease.generation,
          }),
        );
        const entered = yield* Deferred.make<void>();
        const pending = yield* runtime
          .ensure(thread, "codex", (lease) =>
            runtime.startNative(adapter, {
              ...input(
                replacement,
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
              ),
              lifecycleGeneration: lease.generation,
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        expect(runtime.threadsForConnection(replacement)).toEqual([thread]);
        yield* runtime.cancelStart(thread, "connection-removed");
        yield* Fiber.await(pending);
        expect(runtime.ownsConnection(thread, replacement)).toBe(false);
        expect(runtime.ownsConnection(thread, original)).toBe(true);
        expect(runtime.state(thread)).toBe("ready");
        expect(active).toBe(true);
        expect(stops).toBe(0);
      }),
    );
  });
  it("joins an already-fired idle disposal before shutdown completes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const runtime = makeThreadRuntime();
          yield* runtime.ensure(thread, "claudeAgent", (lease) => Effect.sync(lease.commit));
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          runtime.scheduleIdle(
            thread,
            100,
            runtime
              .stop(thread, "idle", (lease) =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(Effect.sync(lease.retire)),
                ),
              )
              .pipe(Effect.orDie),
          );
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(100));
          yield* Deferred.await(entered);
          expect(runtime.state(thread)).toBe("stopping");
          const shutdown = yield* runtime.beginShutdown.pipe(Effect.forkChild);
          expect(shutdown.pollUnsafe()).toBeUndefined();
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(shutdown);
          expect(runtime.state(thread)).toBe("none");
          expect(runtime.hasIdleJob(thread)).toBe(false);
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects a retired credential profile before invoking native startup", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = makeThreadRuntime();
        let nativeStarts = 0;
        const adapter = {
          provider: "claudeAgent",
          hasSession: () => Effect.succeed(false),
          startSession: () =>
            Effect.sync(() => {
              nativeStarts++;
              throw new Error("must not start");
            }),
        } as unknown as ProviderAdapterShape<ProviderAdapterError>;
        const result = yield* Effect.result(
          runtime.ensure(thread, "claudeAgent", (lease) =>
            runtime.startNative(adapter, {
              threadId: thread,
              runtimeMode: "full-access",
              lifecycleGeneration: lease.generation,
              managedLaunch: {
                binaryPath: "/managed/claude",
                assertCurrentCredentials: Effect.fail(new Error("Credential retired")),
                isolationKey: "old",
                profileRoot: "/retired/profile",
                nativeStateRoot: "/native/thread",
                childEnvironment: (environment) => environment,
              },
            }),
          ),
        );
        expect(result._tag).toBe("Failure");
        expect(nativeStarts).toBe(0);
        expect(runtime.state(thread)).toBe("none");
      }),
    );
  });
  it("tracks Connection ownership before native startup acknowledges and waits for cancellation cleanup", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = makeThreadRuntime();
        const connectionId = ProviderConnectionId.make("pending-connection");
        const entered = yield* Deferred.make<void>();
        const cleaning = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const adapter = {
          provider: "codex",
          hasSession: () => Effect.succeed(false),
          startSession: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(release))),
              ),
            ),
          stopSession: () => Effect.void,
        } as unknown as ProviderAdapterShape<ProviderAdapterError>;
        const startup = yield* runtime
          .ensure(thread, "codex", (lease) =>
            runtime.startNative(adapter, {
              threadId: thread,
              runtimeMode: "full-access",
              lifecycleGeneration: lease.generation,
              managedLaunch: {
                connectionId,
                binaryPath: "/managed/codex",
                assertCurrentCredentials: Effect.void,
                isolationKey: connectionId,
                profileRoot: "/managed/profile",
                nativeStateRoot: "/native/thread",
                childEnvironment: (environment) => environment,
              },
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        expect(runtime.threadsForConnection(connectionId)).toEqual([thread]);
        const cancellation = yield* runtime
          .cancelStart(thread, "connection-removed")
          .pipe(Effect.forkChild);
        yield* Deferred.await(cleaning);
        expect(cancellation.pollUnsafe()).toBeUndefined();
        yield* runtime.ensure(peer, "codex", (lease) => Effect.sync(lease.commit));
        expect(runtime.state(peer)).toBe("ready");
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(cancellation)).toBe(true);
        yield* Fiber.await(startup);
        expect(runtime.threadsForConnection(connectionId)).toEqual([]);
        expect(runtime.state(thread)).toBe("none");
        expect(runtime.state(peer)).toBe("ready");
      }),
    );
  });
  it("quiesces pending startup before shutdown and rejects later admission", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = makeThreadRuntime();
        const entered = yield* Deferred.make<void>();
        const cleaning = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const start = yield* runtime
          .ensure(thread, "codex", () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(release))),
              ),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const shutdown = yield* runtime.beginShutdown.pipe(Effect.forkChild);
        yield* Deferred.await(cleaning);
        expect(shutdown.pollUnsafe()).toBeUndefined();
        let admitted = false;
        const rejected = yield* Effect.result(
          runtime.ensure(peer, "codex", () =>
            Effect.sync(() => {
              admitted = true;
            }),
          ),
        );
        expect(rejected._tag).toBe("Failure");
        expect(admitted).toBe(false);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(shutdown)).toEqual([thread]);
        yield* Fiber.await(start);
        expect(runtime.state(thread)).toBe("none");
      }),
    );
  });

  it("attempts every process owner even when another provider fails to close", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = makeThreadRuntime();
        const stopped: string[] = [];
        const adapters = ["codex", "claudeAgent"].map((provider) => ({
          provider,
          stopAll: () =>
            Effect.sync(() => stopped.push(provider)).pipe(
              Effect.andThen(
                provider === "codex"
                  ? Effect.fail(
                      new ProviderAdapterProcessError({
                        provider,
                        threadId: thread,
                        detail: "close failed",
                      }),
                    )
                  : Effect.void,
              ),
            ),
        })) as unknown as ReadonlyArray<ProviderAdapterShape<ProviderAdapterError>>;
        yield* runtime.beginShutdown;
        const result = yield* Effect.result(runtime.closeProcesses(adapters));
        expect(result._tag).toBe("Failure");
        expect(stopped.toSorted()).toEqual(["claudeAgent", "codex"]);
      }),
    );
  });

  it("keeps the live generation during replacement preparation until native ownership changes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = makeThreadRuntime();
        yield* runtime.ensure(thread, "codex", (lease) => Effect.sync(lease.commit));
        const liveGeneration = runtime.currentGeneration(thread);
        const preparing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const replacement = yield* runtime
          .ensure(thread, "codex", (lease) =>
            Deferred.succeed(preparing, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Effect.sync(lease.commit)),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(preparing);
        yield* Effect.sync(() =>
          expect(runtime.currentGeneration(thread)).toBe(liveGeneration),
        ).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        yield* Fiber.join(replacement);
      }),
    );
  });

  it("records native running/ready state and ignores exits from a retired generation", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = makeThreadRuntime();
        yield* runtime.ensure(thread, "codex", (lease) => Effect.sync(lease.commit));
        expect(runtime.state(thread)).toBe("ready");
        const event = (type: string, lifecycleGeneration = runtime.currentGeneration(thread)) =>
          ({
            type,
            threadId: thread,
            provider: "codex",
            lifecycleGeneration,
          }) as ProviderRuntimeEvent;
        yield* runtime.observe(event("turn.started"));
        expect(runtime.state(thread)).toBe("running");
        yield* runtime.observe(event("session.exited", "retired-owner"));
        expect(runtime.state(thread)).toBe("running");
        yield* runtime.observe(event("turn.completed"));
        expect(runtime.state(thread)).toBe("ready");
        yield* runtime.stop(thread, "archive", (lease) => Effect.sync(lease.retire));
        expect(runtime.state(thread)).toBe("none");
      }),
    );
  });

  it("cancels a starting thread, joins cleanup, and keeps other threads independent", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = makeThreadRuntime();
        const entered = yield* Deferred.make<void>();
        const abortSeen = yield* Deferred.make<void>();
        const releaseCleanup = yield* Deferred.make<void>();
        const start = yield* runtime
          .ensure(thread, "codex", () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Deferred.succeed(abortSeen, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseCleanup)),
                ),
              ),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const cancelling = yield* runtime
          .interrupt(thread, () => Effect.die("must cancel, not send a turn interrupt"))
          .pipe(Effect.forkChild);
        yield* Deferred.await(abortSeen);
        expect(cancelling.pollUnsafe()).toBeUndefined();
        const peerResult = yield* runtime.ensure(peer, "claudeAgent", (lease) =>
          Effect.sync(() => {
            lease.commit();
            return "peer ready";
          }),
        );
        expect(peerResult).toBe("peer ready");
        let replacementEntered = false;
        const attempted = yield* Deferred.make<void>();
        const replacement = yield* Deferred.succeed(attempted, undefined).pipe(
          Effect.andThen(
            runtime.ensure(thread, "codex", (lease) =>
              Effect.sync(() => {
                replacementEntered = true;
                lease.commit();
              }),
            ),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(attempted);
        expect(replacementEntered).toBe(false);
        yield* Deferred.succeed(releaseCleanup, undefined);
        yield* Fiber.join(cancelling);
        yield* Fiber.await(start);
        yield* Fiber.join(replacement);
        expect(replacementEntered).toBe(true);
        expect(runtime.state(thread)).toBe("ready");
      }),
    );
  });

  it("does not serialize a live-turn interrupt behind another control request", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = makeThreadRuntime();
        yield* runtime.ensure(thread, "codex", (lease) => Effect.sync(lease.commit));
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* runtime
          .withCurrent(thread, () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        expect(yield* runtime.interrupt(thread, (generation) => Effect.succeed(generation))).toBe(
          runtime.currentGeneration(thread),
        );
        expect(holder.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
      }),
    );
  });

  it.each(["codex", "claudeAgent", "opencode"] as const)(
    "retires an unconfirmed %s continuation before admitting a replacement",
    async (provider) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const retired: ProviderKind[] = [];
          const runtime = makeThreadRuntime((id, kind) =>
            Effect.sync(() => {
              expect(id).toBe(thread);
              retired.push(kind);
            }),
          );
          yield* runtime.ensure(thread, provider, (lease) => Effect.sync(lease.commit));
          const oldGeneration = runtime.currentGeneration(thread);
          const cleanup: Effect.Effect<void, ProviderAdapterError> = Effect.fail(
            new ProviderAdapterProcessError({
              provider,
              threadId: thread,
              detail: "exit proof failed",
            }),
          );
          const adapter = {
            provider,
            stopSession: () => cleanup,
          } as unknown as ProviderAdapterShape<ProviderAdapterError>;
          yield* Effect.result(
            runtime.stop(thread, "selection-change", () =>
              runtime.dispose(adapter, thread, "selection-change"),
            ),
          );
          expect(runtime.state(thread)).toBe("none");
          expect(runtime.currentGeneration(thread)).toBeUndefined();
          expect(retired).toEqual([provider]);
          let started = false;
          const result = yield* Effect.result(
            runtime.ensure(thread, provider, (lease) =>
              Effect.sync(() => {
                lease.commit();
                started = true;
              }),
            ),
          );
          expect(result._tag).toBe("Success");
          expect(started).toBe(true);
          expect(runtime.currentGeneration(thread)).not.toBe(oldGeneration);
          expect(runtime.state(thread)).toBe("ready");
        }),
      );
    },
  );

  it("reports failed start cleanup but retires its continuation instead of blocking future starts", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = makeThreadRuntime();
        const entered = yield* Deferred.make<void>();
        const start = yield* runtime
          .ensure(thread, "claudeAgent", () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Effect.die("native cleanup failed")),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const cancelled = yield* Effect.result(runtime.interrupt(thread, () => Effect.void));
        expect(cancelled._tag).toBe("Failure");
        expect(runtime.state(thread)).toBe("none");
        yield* Fiber.await(start);
      }),
    );
  });

  it("joins retirement before the replacement starts while another thread remains independent", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const durable = yield* Deferred.make<void>();
        const runtime = makeThreadRuntime(() =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(durable))),
        );
        yield* runtime.ensure(thread, "codex", (lease) => Effect.sync(lease.commit));
        const adapter = {
          provider: "codex",
          stopSession: () =>
            Effect.fail(
              new ProviderAdapterProcessError({
                provider: "codex",
                threadId: thread,
                detail: "controlled stop failure",
              }),
            ),
        } as unknown as ProviderAdapterShape<ProviderAdapterError>;
        const stop = yield* Effect.result(
          runtime.stop(thread, "user-stop", () => runtime.dispose(adapter, thread, "user-stop")),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        let started = false;
        const replacement = yield* runtime
          .ensure(thread, "codex", (lease) =>
            Effect.sync(() => {
              started = true;
              lease.commit();
            }),
          )
          .pipe(Effect.forkChild);
        yield* runtime.ensure(peer, "codex", (lease) => Effect.sync(lease.commit));
        expect(runtime.state(peer)).toBe("ready");
        expect(started).toBe(false);
        yield* Deferred.succeed(durable, undefined);
        expect((yield* Fiber.join(stop))._tag).toBe("Failure");
        yield* Fiber.join(replacement);
        expect(started).toBe(true);
        expect(runtime.state(thread)).toBe("ready");
      }),
    );
  });

  it("does not admit native work while retirement persistence fails and retries only on a new admission", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        let writable = false;
        let writes = 0;
        const runtime = makeThreadRuntime(() =>
          Effect.suspend(() => {
            writes++;
            return writable
              ? Effect.void
              : Effect.fail(new Error("controlled persistence failure"));
          }),
        );
        yield* runtime.ensure(thread, "codex", (lease) => Effect.sync(lease.commit));
        const adapter = {
          provider: "codex",
          stopSession: () =>
            Effect.fail(
              new ProviderAdapterProcessError({
                provider: "codex",
                threadId: thread,
                detail: "controlled stop failure",
              }),
            ),
        } as unknown as ProviderAdapterShape<ProviderAdapterError>;
        yield* Effect.exit(
          runtime.stop(thread, "user-stop", () => runtime.dispose(adapter, thread, "user-stop")),
        );
        expect(writes).toBe(1);
        let started = false;
        const attempt = () =>
          runtime.ensure(thread, "codex", (lease) =>
            Effect.sync(() => {
              started = true;
              lease.commit();
            }),
          );
        expect((yield* Effect.result(attempt()))._tag).toBe("Failure");
        expect(started).toBe(false);
        expect(writes).toBe(2);
        writable = true;
        yield* attempt();
        expect(writes).toBe(3);
        expect(started).toBe(true);
      }),
    );
  });
});

function deterministicClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe("teardownProviderProcessTree", () => {
  it.each([
    { phase: "TERM", emptyAt: 2, escalated: false },
    { phase: "KILL", emptyAt: 4, escalated: true },
  ])("accepts verified exit at the final $phase inspection", async ({ emptyAt, escalated }) => {
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 902, command: "provider-worker" }],
      captureComplete: true,
    };
    const clock = deterministicClock();
    const signals: TerminalKillSignal[] = [];
    let inspections = 0;
    const result = await teardownProviderProcessTree(
      {
        rootPid: 901,
        rootExited: Promise.resolve(),
        termGraceMs: 1,
        forceExitMs: 1,
        pollMs: 1,
        inspectIntervalMs: 10,
      },
      {
        processTreeKiller: {
          capture: () => tree,
          signal: ({ signal }) => signals.push(signal),
          inspect: () => ({
            verified: true,
            survivors: ++inspections >= emptyAt ? [] : tree.descendants,
          }),
        },
        ...clock,
      },
    );

    expect(result).toEqual({ escalated, signalErrors: [] });
    expect(inspections).toBe(emptyAt);
    expect(signals).toEqual(escalated ? ["SIGTERM", "SIGKILL"] : ["SIGTERM"]);
  });

  it("escalates ignored TERM and returns only after root and descendants prove exit", async () => {
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 102, command: "provider-worker" }],
      captureComplete: true,
    };
    const runningDescendants = new Map<number, CapturedProcess>([[102, tree.descendants[0]!]]);
    const signals: Array<{ signal: TerminalKillSignal; includeRootTree: boolean | undefined }> = [];
    let resolveRootExit: (() => void) | undefined;
    const rootExited = new Promise<void>((resolve) => {
      resolveRootExit = resolve;
    });
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => tree,
      inspect: () => ({ verified: true, survivors: [...runningDescendants.values()] }),
      signal: ({ signal, includeRootTree }) => {
        signals.push({ signal, includeRootTree });
        if (signal === "SIGKILL") {
          runningDescendants.clear();
          resolveRootExit?.();
        }
      },
    };
    const clock = deterministicClock();

    await expect(
      teardownProviderProcessTree(
        { rootPid: 101, rootExited, termGraceMs: 10, forceExitMs: 10, pollMs: 5 },
        {
          processTreeKiller,
          ...clock,
        },
      ),
    ).resolves.toEqual({ escalated: true, signalErrors: [] });
    expect(signals).toEqual([
      { signal: "SIGTERM", includeRootTree: true },
      { signal: "SIGKILL", includeRootTree: true },
    ]);
  });

  it("force-kills captured descendants without re-signalling a root that exited after TERM", async () => {
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 202, command: "provider-grandchild" }],
      captureComplete: true,
    };
    let descendantsRunning = true;
    let resolveRootExit: (() => void) | undefined;
    const rootExited = new Promise<void>((resolve) => {
      resolveRootExit = resolve;
    });
    const signals: Array<{ signal: TerminalKillSignal; includeRootTree: boolean | undefined }> = [];
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => tree,
      inspect: () => ({
        verified: true,
        survivors: descendantsRunning ? tree.descendants : [],
      }),
      signal: ({ signal, includeRootTree }) => {
        signals.push({ signal, includeRootTree });
        if (signal === "SIGTERM") resolveRootExit?.();
        if (signal === "SIGKILL") descendantsRunning = false;
      },
    };
    const clock = deterministicClock();

    await expect(
      teardownProviderProcessTree(
        { rootPid: 201, rootExited, termGraceMs: 10, forceExitMs: 10, pollMs: 5 },
        {
          processTreeKiller,
          ...clock,
        },
      ),
    ).resolves.toEqual({ escalated: true, signalErrors: [] });
    expect(signals.at(-1)).toEqual({ signal: "SIGKILL", includeRootTree: false });
  });

  it("does not accept root exit as descendant proof when the snapshot failed", async () => {
    const tree: CapturedProcessTree = { descendants: [], captureComplete: false };
    const signals: Array<{ signal: TerminalKillSignal; includeRootTree: boolean | undefined }> = [];
    const clock = deterministicClock();

    const failure = await teardownProviderProcessTree(
      {
        rootPid: 401,
        rootExited: Promise.resolve(),
        termGraceMs: 10,
        forceExitMs: 10,
        pollMs: 5,
      },
      {
        processTreeKiller: {
          capture: () => tree,
          inspect: () => ({ verified: true, survivors: [] }),
          signal: ({ signal, includeRootTree }) => signals.push({ signal, includeRootTree }),
        },
        ...clock,
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
    expect(failure).toMatchObject({
      rootPid: 401,
      rootExited: true,
      captureComplete: false,
      remainingDescendantPids: null,
    });
    expect(signals).toEqual([
      { signal: "SIGTERM", includeRootTree: true },
      { signal: "SIGKILL", includeRootTree: false },
    ]);
  });

  it("retries an incomplete capture before signaling and retains partial identities", async () => {
    const firstTree: CapturedProcessTree = {
      descendants: [{ pid: 452, command: "provider-worker" }],
      captureComplete: false,
    };
    const secondTree: CapturedProcessTree = {
      descendants: [{ pid: 453, command: "provider-helper" }],
      captureComplete: true,
    };
    const capturedTrees: CapturedProcessTree[] = [];
    let captureCalls = 0;
    let resolveRootExit: (() => void) | undefined;
    const rootExited = new Promise<void>((resolve) => {
      resolveRootExit = resolve;
    });
    const clock = deterministicClock();

    await expect(
      teardownProviderProcessTree(
        { rootPid: 451, rootExited, termGraceMs: 10, forceExitMs: 10, pollMs: 5 },
        {
          processTreeKiller: {
            capture: () => {
              captureCalls += 1;
              return captureCalls === 1 ? firstTree : secondTree;
            },
            inspect: () => ({ verified: true, survivors: [] }),
            signal: ({ signal, tree }) => {
              capturedTrees.push(tree);
              if (signal === "SIGTERM") resolveRootExit?.();
            },
          },
          ...clock,
        },
      ),
    ).resolves.toEqual({ escalated: false, signalErrors: [] });

    expect(captureCalls).toBe(2);
    expect(capturedTrees[0]?.captureComplete).toBe(true);
    expect(capturedTrees[0]?.descendants.map(({ pid }) => pid)).toEqual([452, 453]);
  });

  it("still fails closed on an incomplete snapshot when the root never proves exit", async () => {
    const tree: CapturedProcessTree = { descendants: [], captureComplete: false };
    const clock = deterministicClock();

    const failure = await teardownProviderProcessTree(
      { rootPid: 501, rootExited: new Promise(() => undefined), termGraceMs: 5, forceExitMs: 5 },
      {
        processTreeKiller: {
          capture: () => tree,
          inspect: () => ({ verified: true, survivors: [] }),
          signal: () => undefined,
        },
        ...clock,
      },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
    expect(failure).toMatchObject({ rootPid: 501, rootExited: false, captureComplete: false });
  });

  it("fails closed when forced termination cannot prove process-tree exit", async () => {
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 302, command: "stuck-provider" }],
      captureComplete: true,
    };
    const clock = deterministicClock();

    const failure = await teardownProviderProcessTree(
      { rootPid: 301, rootExited: new Promise(() => undefined), termGraceMs: 5, forceExitMs: 5 },
      {
        processTreeKiller: {
          capture: () => tree,
          inspect: () => ({ verified: true, survivors: tree.descendants }),
          signal: () => undefined,
        },
        ...clock,
      },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
    expect(failure).toMatchObject({
      name: "ProviderProcessExitUnprovenError",
      rootPid: 301,
      rootExited: false,
      remainingDescendantPids: [302],
    });
  });

  it("does not scan descendants before the root proves exit", async () => {
    // Each inspection is a synchronous `ps`. Descendant identity cannot end the
    // wait until the root has exited, so polling it beforehand only blocks the
    // event loop. Only the two give-up scans that build the failure detail remain.
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 602, command: "stuck-provider" }],
      captureComplete: true,
    };
    let inspectCalls = 0;
    const clock = deterministicClock();

    const failure = await teardownProviderProcessTree(
      {
        rootPid: 601,
        rootExited: new Promise(() => undefined),
        termGraceMs: 500,
        forceExitMs: 500,
      },
      {
        processTreeKiller: {
          capture: () => tree,
          inspect: () => {
            inspectCalls += 1;
            return { verified: true, survivors: tree.descendants };
          },
          signal: () => undefined,
        },
        ...clock,
      },
    ).catch((error: unknown) => error);

    expect(inspectCalls).toBe(2);
    expect(failure).toMatchObject({ remainingDescendantPids: [602] });
  });

  it("throttles descendant scans instead of running one per poll", async () => {
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 702, command: "provider-worker" }],
      captureComplete: true,
    };
    let inspectCalls = 0;
    let sleepCalls = 0;
    let resolveRootExit: (() => void) | undefined;
    const rootExited = new Promise<void>((resolve) => {
      resolveRootExit = resolve;
    });
    let now = 0;

    await teardownProviderProcessTree(
      {
        rootPid: 701,
        rootExited,
        termGraceMs: 1_000,
        forceExitMs: 1_000,
        pollMs: 25,
        inspectIntervalMs: 250,
      },
      {
        processTreeKiller: {
          capture: () => tree,
          inspect: () => {
            inspectCalls += 1;
            return { verified: true, survivors: tree.descendants };
          },
          signal: ({ signal }) => {
            if (signal === "SIGTERM") resolveRootExit?.();
          },
        },
        now: () => now,
        sleep: async (milliseconds: number) => {
          sleepCalls += 1;
          now += milliseconds;
        },
      },
    ).catch(() => undefined);

    // The root exits immediately, so every poll used to trigger its own `ps`.
    expect(sleepCalls).toBeGreaterThan(60);
    expect(inspectCalls).toBeLessThanOrEqual(sleepCalls / 4);
  });
});
