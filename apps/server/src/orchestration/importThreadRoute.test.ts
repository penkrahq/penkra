import { ThreadId } from "@penkra/contracts";
import { assert, it, vi } from "@effect/vitest";
import { Effect, Option } from "effect";

import { makeImportThreadHandler } from "./importThreadRoute.ts";

it.effect("fails before reading or starting a global provider session", () =>
  Effect.gen(function* () {
    const startSession = vi.fn(() => Effect.die("must not start"));
    const getByProvider = vi.fn(() => Effect.die("must not inspect global state"));
    const handler = makeImportThreadHandler({
      projectionSnapshotQuery: {
        getThreadDetailById: () =>
          Effect.succeed(
            Option.some({
              id: ThreadId.makeUnsafe("import-thread"),
              session: null,
            }),
          ),
      },
      providerService: { startSession },
      providerAdapterRegistry: {
        getByProvider,
      },
    } as never);

    const result = yield* Effect.exit(
      handler({
        threadId: ThreadId.makeUnsafe("import-thread"),
        externalId: "native-session",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(startSession.mock.calls.length, 0);
    assert.strictEqual(getByProvider.mock.calls.length, 0);
  }),
);
