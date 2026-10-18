import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { ServerConfig } from "../../config.ts";
import { OpenCodeRuntime } from "../../provider/opencodeRuntime.ts";
import { OpenCodeTextGeneration } from "../Services/TextGeneration.ts";
import { OpenCodeTextGenerationServiceLive } from "./OpenCodeTextGeneration.ts";

// Real service; only the provider transport/process is replaced. No credentials or live database.
let closed = 0,
  started = false,
  promptArguments: unknown[] = [];
const runtime = {
  startOpenCodeServerProcess: () =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed++;
        }),
      );
      return { url: "http://127.0.0.1:1", exitCode: Effect.never };
    }),
  createOpenCodeSdkClient: () => ({
    session: {
      create: async () => ({ data: { id: "audit-title" } }),
      prompt: (...args: unknown[]) => {
        started = true;
        promptArguments = args;
        return new Promise(() => {});
      },
    },
  }),
};
const layer = Layer.mergeAll(
  NodeServices.layer,
  OpenCodeTextGenerationServiceLive.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "penkra-title-audit-" })),
    Layer.provide(Layer.succeed(OpenCodeRuntime, runtime as never)),
    Layer.provide(NodeServices.layer),
  ),
);
it.effect(
  "keeps unfinished requests alive, cancels explicitly, and closes the process with its service",
  () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const service = yield* OpenCodeTextGeneration;
        const fiber = yield* service
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "Hello",
            modelSelection: { provider: "opencode", model: "openai/gpt-5" },
          })
          .pipe(Effect.forkChild);
        while (!started) yield* Effect.yieldNow;
        // One hour is a test observation horizon, not a proposed timeout.
        yield* TestClock.adjust(Duration.hours(1));
        expect(closed).toBe(0);
        expect(promptArguments).toHaveLength(1);
        expect(promptArguments[0]).not.toHaveProperty("signal");
        yield* Fiber.interrupt(fiber);
        yield* Effect.yieldNow;
        // Idle servers belong to the service, not a request or an expiry timer.
        yield* TestClock.adjust(Duration.millis(30_001));
        yield* Effect.yieldNow;
        expect(closed).toBe(0);
      }).pipe(Effect.provide(layer));
      expect(closed).toBe(1);
    }),
);
