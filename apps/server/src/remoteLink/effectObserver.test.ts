import { Effect } from "effect";
import { expect, it } from "vitest";

it("notifies a later fiber observer when an earlier observer removes itself", async () => {
  const finish = Promise.withResolvers<void>();
  const observedFirst = Promise.withResolvers<void>();
  const fiber = Effect.runFork(Effect.promise(() => finish.promise));
  let laterObserved = false;
  let removeFirst: () => void;
  removeFirst = fiber.addObserver(() => {
    removeFirst();
    observedFirst.resolve();
  });
  fiber.addObserver(() => {
    laterObserved = true;
  });
  finish.resolve();
  await observedFirst.promise;
  expect(fiber.pollUnsafe()).toBeDefined();
  expect(laterObserved).toBe(true);
});
