import type {
  PenkraCreateClientInput,
  PenkraCreateClientResult,
  PenkraCreateTodoInput,
  PenkraMutationResult,
  PenkraSnapshot,
  PenkraUpdateTodoInput,
} from "@synara/contracts";
import { Effect, Layer, PubSub, ServiceMap, Stream } from "effect";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine";
import { resolvePenkraRuntimeConfig } from "./config";
import { PenkraBackendClient } from "./backendClient";
import {
  coalesceRegistryReconciliations,
  reconcilePenkraRegistry,
  type RegistrySyncResult,
} from "./registrySync";
import { PenkraSocketClient } from "./socket";

export class PenkraRegistry extends ServiceMap.Service<
  PenkraRegistry,
  {
    readonly reconcile: Effect.Effect<RegistrySyncResult, Error>;
    readonly getSnapshot: Effect.Effect<PenkraSnapshot>;
    readonly createClient: (
      input: PenkraCreateClientInput,
    ) => Effect.Effect<PenkraCreateClientResult, Error>;
    readonly createTodo: (
      input: PenkraCreateTodoInput,
    ) => Effect.Effect<PenkraMutationResult, Error>;
    readonly updateTodo: (
      input: PenkraUpdateTodoInput,
    ) => Effect.Effect<PenkraMutationResult, Error>;
    readonly streamSnapshots: Stream.Stream<PenkraSnapshot>;
  }
>()("penkra/server/PenkraRegistry") {}

export const PenkraRegistryLive = Layer.effect(
  PenkraRegistry,
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const config = resolvePenkraRuntimeConfig();
    const snapshots = yield* PubSub.unbounded<PenkraSnapshot>();
    const reconcileRegistry = coalesceRegistryReconciliations(() =>
      reconcilePenkraRegistry({ config, engine }),
    );
    const socket = new PenkraSocketClient(
      config,
      (snapshot) => {
        void Effect.runPromise(PubSub.publish(snapshots, snapshot));
      },
      async () => {
        await reconcileRegistry();
      },
      (failure) => {
        Effect.runFork(
          Effect.logWarning("Penkra registry reconciliation failed", {
            phase: failure.phase,
            entity: failure.entity,
            id: failure.id,
            cause: failure.error,
          }),
        );
      },
    );
    const reconcile = Effect.tryPromise({
      try: reconcileRegistry,
      catch: toError,
    });

    const requireBackend = async (): Promise<PenkraBackendClient> => {
      if (!config) throw new Error("Penkra root is not configured");
      const backend = await PenkraBackendClient.fromHqConfig(config.hqConfigPath);
      if (!backend) throw new Error("Penkra HQ authentication is required");
      return backend;
    };

    return {
      reconcile,
      getSnapshot: Effect.promise(() => socket.getSnapshot()),
      createClient: (input) =>
        Effect.tryPromise({
          try: async () => {
            const backend = await requireBackend();
            const client = await backend.createClient(input);
            await reconcileRegistry();
            return client;
          },
          catch: toError,
        }),
      createTodo: (input) =>
        Effect.tryPromise({
          try: async () => ({ todoId: await (await requireBackend()).createTodo(input) }),
          catch: toError,
        }),
      updateTodo: (input) =>
        Effect.tryPromise({
          try: async () => ({ todoId: await (await requireBackend()).updateTodo(input) }),
          catch: toError,
        }),
      streamSnapshots: Stream.fromPubSub(snapshots),
    };
  }),
);

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("Penkra operation failed", { cause });
}
