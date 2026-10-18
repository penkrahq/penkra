import { Deferred, Effect, Fiber } from "effect";
import { expect, it, vi } from "vitest";

import { writeServerListeningWhenReady } from "./effectServer";
import { makeServerReadiness } from "./server/readiness";

it("writes the desktop listening line exactly once, only after full readiness", async () => {
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const readiness = yield* makeServerReadiness;
          const waiting = yield* Deferred.make<void>();
          const fiber = yield* writeServerListeningWhenReady(
            {
              awaitServerReady: Deferred.succeed(waiting, undefined).pipe(
                Effect.andThen(readiness.awaitServerReady),
              ),
            },
            "::1",
            5123,
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(waiting);
          yield* readiness.markHttpListening;
          yield* readiness.markPushBusReady;
          yield* readiness.markTerminalSubscriptionsReady;
          expect(write).not.toHaveBeenCalled();
          yield* readiness.markOrchestrationSubscriptionsReady;
          yield* Fiber.join(fiber);
          expect(write).toHaveBeenCalledExactlyOnceWith("Listening on http://[::1]:5123\n");
          yield* readiness.markOrchestrationSubscriptionsReady;
          expect(write).toHaveBeenCalledTimes(1);
        }),
      ),
    );
  } finally {
    write.mockRestore();
  }
});
