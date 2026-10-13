// Purpose: Process-local provider routing; durable resume identity lives on threads.
import type { ThreadId } from "@penkra/contracts";
import { Effect, Layer, Option } from "effect";
import { ProviderSessionDirectoryPersistenceError, ProviderValidationError } from "../Errors.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
  type ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const mergePayload = (previous: unknown, next: unknown) =>
  next === undefined
    ? previous
    : record(previous) && record(next)
      ? { ...previous, ...next }
      : next;
const makeProviderSessionDirectory = Effect.sync(() => {
  const bindings = new Map<ThreadId, ProviderRuntimeBinding>();
  const getBinding: ProviderSessionDirectoryShape["getBinding"] = (threadId) =>
    Effect.sync(() => Option.fromNullishOr(bindings.get(threadId)));
  return {
    upsert: (binding) =>
      Effect.gen(function* () {
        if (!binding.threadId)
          return yield* Effect.fail(
            new ProviderValidationError({
              operation: "ProviderSessionDirectory.upsert",
              issue: "threadId must be a non-empty string.",
            }),
          );
        const previous = bindings.get(binding.threadId);
        const compatible = previous?.provider === binding.provider ? previous : undefined;
        bindings.set(binding.threadId, {
          ...compatible,
          ...binding,
          adapterKey: binding.adapterKey ?? compatible?.adapterKey ?? binding.provider,
          lastSeenAt: new Date().toISOString(),
          resumeCursor:
            binding.resumeCursor === undefined ? compatible?.resumeCursor : binding.resumeCursor,
          runtimePayload: mergePayload(compatible?.runtimePayload, binding.runtimePayload),
        });
      }),
    getBinding,
    getProvider: (threadId) =>
      getBinding(threadId).pipe(
        Effect.flatMap((binding) =>
          Option.isSome(binding)
            ? Effect.succeed(binding.value.provider)
            : Effect.fail(
                new ProviderSessionDirectoryPersistenceError({
                  operation: "ProviderSessionDirectory.getProvider",
                  detail: `No live provider binding found for thread '${threadId}'.`,
                }),
              ),
        ),
      ),
    remove: (threadId) =>
      Effect.sync(() => {
        bindings.delete(threadId);
      }),
    listThreadIds: () => Effect.sync(() => [...bindings.keys()]),
    listBindings: () => Effect.sync(() => [...bindings.values()]),
  } satisfies ProviderSessionDirectoryShape;
});
export const ProviderSessionDirectoryLive = Layer.effect(
  ProviderSessionDirectory,
  makeProviderSessionDirectory,
);
export function makeProviderSessionDirectoryLive() {
  return Layer.effect(ProviderSessionDirectory, makeProviderSessionDirectory);
}
