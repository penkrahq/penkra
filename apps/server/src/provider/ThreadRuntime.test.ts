import {
  ProviderConnectionId,
  ThreadId,
  type ProviderKind,
  type ProviderRuntimeEvent,
} from "@penkra/contracts";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";

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
