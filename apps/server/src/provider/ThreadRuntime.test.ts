import { ProviderConnectionId, ThreadId, type ProviderRuntimeEvent } from "@penkra/contracts";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { makeThreadRuntime } from "./ThreadRuntime.ts";
import { ProviderAdapterProcessError, type ProviderAdapterError } from "./Errors.ts";
import type { ProviderAdapterShape } from "./Services/ProviderAdapter.ts";

const thread = ThreadId.makeUnsafe("runtime-owner");
const peer = ThreadId.makeUnsafe("runtime-peer");

describe("ThreadRuntime ownership", () => {
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
        yield* runtime.retireProfile("/retired/profile");
        const result = yield* Effect.result(
          runtime.ensure(thread, "claudeAgent", (lease) =>
            runtime.startNative(adapter, {
              threadId: thread,
              runtimeMode: "full-access",
              lifecycleGeneration: lease.generation,
              managedLaunch: {
                binaryPath: "/managed/claude",
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
        const connectionId = ProviderConnectionId.makeUnsafe("pending-connection");
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

  it("does not admit a replacement after a failed disposal until explicit cleanup succeeds", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = makeThreadRuntime();
        yield* runtime.ensure(thread, "codex", (lease) => Effect.sync(lease.commit));
        let cleanup: Effect.Effect<void, ProviderAdapterError> = Effect.fail(
          new ProviderAdapterProcessError({
            provider: "codex",
            threadId: thread,
            detail: "exit proof failed",
          }),
        );
        const adapter = {
          provider: "codex",
          stopSession: () => cleanup,
        } as unknown as ProviderAdapterShape<ProviderAdapterError>;
        yield* Effect.result(
          runtime.stop(thread, "selection-change", () =>
            runtime.dispose(adapter, thread, "selection-change"),
          ),
        );
        expect(runtime.state(thread)).toBe("stopping");
        let started = false;
        const result = yield* Effect.result(
          runtime.ensure(thread, "claudeAgent", () =>
            Effect.sync(() => {
              started = true;
            }),
          ),
        );
        expect(result._tag).toBe("Failure");
        expect(started).toBe(false);
        cleanup = Effect.void;
        yield* runtime.stop(thread, "selection-change", () =>
          runtime.dispose(adapter, thread, "selection-change"),
        );
        yield* runtime.ensure(thread, "claudeAgent", (lease) => Effect.sync(lease.commit));
        expect(runtime.state(thread)).toBe("ready");
      }),
    );
  });

  it("keeps failed start cleanup owned instead of declaring a cancelled process gone", async () => {
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
        expect(runtime.state(thread)).toBe("stopping");
        yield* Fiber.await(start);
      }),
    );
  });
});
