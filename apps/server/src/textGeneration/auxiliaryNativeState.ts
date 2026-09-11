import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import type { ProviderManagedLaunchContext } from "../provider/Services/ProviderAdapter.ts";
import { TextGenerationError } from "./Errors.ts";

/** The caller must await provider process shutdown before releasing this state. */
export const withAuxiliaryNativeState = <A>(
  provider: "codex" | "opencode",
  launch: ProviderManagedLaunchContext,
  use: (launch: ProviderManagedLaunchContext) => Effect.Effect<A, TextGenerationError>,
): Effect.Effect<A, TextGenerationError> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "penkra-thread-title-")),
      catch: (cause) =>
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "Could not allocate auxiliary provider state.",
          cause,
        }),
    }),
    (nativeStateRoot) =>
      Effect.gen(function* () {
        const overrides: NodeJS.ProcessEnv =
          provider === "opencode"
            ? {
                OPENCODE_DB: join(nativeStateRoot, "opencode.db"),
                XDG_DATA_HOME: join(nativeStateRoot, "xdg-data"),
                XDG_STATE_HOME: join(nativeStateRoot, "xdg-state"),
              }
            : { CODEX_SQLITE_HOME: join(nativeStateRoot, "codex-sqlite-home") };
        yield* Effect.tryPromise({
          try: () =>
            Promise.all(
              Object.entries(overrides)
                .filter(([key]) => key !== "OPENCODE_DB")
                .map(([, path]) => mkdir(path!, { recursive: true, mode: 0o700 })),
            ),
          catch: (cause) =>
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "Could not prepare auxiliary provider state.",
              cause,
            }),
        });
        return yield* use({
          ...launch,
          nativeStateRoot,
          isolationKey: `${launch.isolationKey}:thread-title:${nativeStateRoot}`,
          // Preserve the resolved Connection's credentials and profile, including
          // CODEX_HOME's keyring namespace. Only disposable runtime paths change.
          childEnvironment: (baseEnv) => ({ ...launch.childEnvironment(baseEnv), ...overrides }),
        });
      }),
    // A process-tree teardown defect means exit could not be proven. Retain
    // state in that case rather than removing files a child may still own.
    (nativeStateRoot, exit) =>
      Exit.isFailure(exit) && Cause.hasDies(exit.cause)
        ? Effect.logWarning("Retaining auxiliary provider state after a runtime defect", {
            nativeStateRoot,
          })
        : Effect.tryPromise({
            try: () => rm(nativeStateRoot, { recursive: true, force: true }),
            catch: (cause) => cause,
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not remove auxiliary provider state", {
                nativeStateRoot,
                cause,
              }),
            ),
          ),
  );
