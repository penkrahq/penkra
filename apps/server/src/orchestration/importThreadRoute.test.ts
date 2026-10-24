import { ThreadId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { makeImportThreadHandler } from "./importThreadRoute.ts";

it.effect("fails before reading or starting a global provider session", () =>
  Effect.gen(function* () {
    const handler = makeImportThreadHandler({
      projectionSnapshotQuery: {
        getThreadDetailById: () =>
          Effect.succeed(
            Option.some({
              id: ThreadId.make("import-thread"),
              session: null,
            } as never),
          ),
      },
    });

    const error = yield* Effect.flip(
      handler({
        threadId: ThreadId.make("import-thread"),
        externalId: "native-session",
      }),
    );
    assert.strictEqual(error._tag, "ImportThreadError");
    assert.strictEqual(
      error.message,
      "Thread import is unavailable until its Connection-selection flow is finalized.",
    );
  }),
);
